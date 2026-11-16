import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  createAuthCoreAttempt,
  createAuthCoreDecision,
  normalizeAuthCoreContract,
  safelyEmitAuthCore
} from "./auth-core-contract-v1.js";
import { validateSecurityEventV1 } from "./core-contract-v1.js";

const REQUEST_RULE = "JBG-RECOVERY-REQUEST-001";
const VERIFY_RULE = "JBG-RECOVERY-VERIFY-001";
const RATE_RULE = "JBG-RECOVERY-RATE-001";
const RECOVERY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_CHALLENGES = 10_000;
const DEFAULT_MAX_RATE_KEYS = 20_000;

const DEFAULT_REQUEST_POLICIES = Object.freeze({
  ip: Object.freeze({ maxRequests: 10, windowMs: 15 * 60_000 }),
  account: Object.freeze({ maxRequests: 3, windowMs: 15 * 60_000 }),
  destination: Object.freeze({ maxRequests: 3, windowMs: 60 * 60_000 })
});
const DEFAULT_VERIFY_IP_POLICY = Object.freeze({
  maxRequests: 20,
  windowMs: 15 * 60_000
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(name + " must be a positive integer no greater than " + maximum);
  }
  return value;
}

function safeNotify(onEvent, event) {
  try {
    const result = onEvent(Object.freeze({
      ...event,
      ruleIds: Object.freeze([...event.ruleIds]),
      scopes: Object.freeze([...(event.scopes ?? [])])
    }));
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch {
    // Audit delivery must never interrupt account recovery.
  }
}

function createRecoveryCoreEvent(core, input) {
  if (!core) return null;
  const attempt = createAuthCoreAttempt(core, {
    attemptId: randomUUID(),
    occurredAtMs: input.occurredAtMs,
    outcome: "failure",
    accountDigest: input.subjectDigest ?? null,
    clientDigest: null
  });
  return validateSecurityEventV1({
    schema: "jb.security.event/v1",
    eventId: randomUUID(),
    occurredAtMs: input.occurredAtMs,
    tenantId: core.tenantId,
    applicationId: core.applicationId,
    producer: "security-guard-node",
    category: "recovery",
    ruleId: input.ruleId,
    severity: input.severity,
    action: input.action,
    outcome: input.outcome,
    subjectKey: attempt.account.key,
    subjectKeyId: attempt.account.keyId,
    scope: input.scopes?.length ? input.scopes.join("_") : "account_recovery",
    ...(RECOVERY_UUID.test(input.correlationId ?? "")
      ? { correlationId: input.correlationId }
      : { correlationId: attempt.attemptId })
  });
}


function normalizePolicy(input, defaults, name) {
  if (!isRecord(input)) throw new TypeError(name + " must be an object");
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaults, key)) throw new TypeError("Unknown " + name + " option: " + key);
  }
  return Object.freeze({
    maxRequests: positiveInteger(input.maxRequests ?? defaults.maxRequests, name + ".maxRequests", 1_000_000),
    windowMs: positiveInteger(input.windowMs ?? defaults.windowMs, name + ".windowMs", 7 * 86_400_000)
  });
}

function normalizeRequestPolicies(input = {}) {
  if (!isRecord(input)) throw new TypeError("requestPolicies must be an object");
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_REQUEST_POLICIES, key)) {
      throw new TypeError("Unknown requestPolicies scope: " + key);
    }
  }
  const result = {};
  for (const [scope, defaults] of Object.entries(DEFAULT_REQUEST_POLICIES)) {
    result[scope] = normalizePolicy(input[scope] ?? {}, defaults, "requestPolicies." + scope);
  }
  return Object.freeze(result);
}

function normalizeAccountId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError("accountId must be an opaque string, number, null, or undefined");
  }
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > 128) throw new TypeError("accountId must not exceed 128 characters");
  return normalized;
}

function normalizeDestination(channel, value) {
  if (typeof value !== "string") return null;
  const destination = channel === "email"
    ? value.trim().toLowerCase()
    : value.trim().replace(/[ ()-]/g, "");
  if (!destination || destination.length > 254) return null;

  if (channel === "email") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination) ? destination : null;
  }
  return /^\+[1-9]\d{7,14}$/.test(destination) ? destination : null;
}

function normalizeSecret(value) {
  const secret = Buffer.isBuffer(value) ? Buffer.from(value) :
    typeof value === "string" ? Buffer.from(value, "utf8") : null;
  if (!secret || secret.length < 32) {
    throw new TypeError("secret must contain at least 32 bytes of stable secret material");
  }
  return secret;
}

function validateStore(store) {
  const required = ["putChallenge", "consumeChallenge", "consumeLimit", "deleteChallenge"];
  if (!isRecord(store) || required.some((method) => typeof store[method] !== "function")) {
    throw new TypeError("store must implement putChallenge, consumeChallenge, consumeLimit, and deleteChallenge");
  }
  return store;
}

/**
 * Process-local storage adapter for development and single-instance deployments.
 * Production multi-instance deployments should provide an adapter whose
 * challenge and limit methods are atomic across all application instances.
 */
export function createMemoryRecoveryStore(options = {}) {
  if (!isRecord(options)) throw new TypeError("memory recovery store options must be an object");
  const maxChallenges = positiveInteger(
    options.maxChallenges ?? DEFAULT_MAX_CHALLENGES,
    "maxChallenges",
    1_000_000
  );
  const maxRateKeys = positiveInteger(
    options.maxRateKeys ?? DEFAULT_MAX_RATE_KEYS,
    "maxRateKeys",
    1_000_000
  );

  const challenges = new Map();
  const subjectIndex = new Map();
  const limits = new Map();

  function removeChallenge(id) {
    const current = challenges.get(id);
    if (!current) return false;
    challenges.delete(id);
    if (subjectIndex.get(current.subjectKey) === id) subjectIndex.delete(current.subjectKey);
    return true;
  }

  function putChallenge(record) {
    if (!isRecord(record) ||
        typeof record.id !== "string" || !record.id || record.id.length > 128 ||
        typeof record.subjectKey !== "string" || !/^[a-f0-9]{64}$/i.test(record.subjectKey) ||
        typeof record.accountId !== "string" ||
        (record.channel !== "email" && record.channel !== "sms") ||
        typeof record.credentialDigest !== "string" || !/^[a-f0-9]{64}$/i.test(record.credentialDigest) ||
        !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) ||
        record.expiresAt <= record.createdAt) {
      throw new TypeError("challenge record is invalid");
    }

    // Expired challenges may be reclaimed, but a live challenge is never
    // silently evicted just because the bounded store has reached capacity.
    for (const [knownId, knownChallenge] of challenges) {
      if (record.createdAt >= knownChallenge.expiresAt) removeChallenge(knownId);
    }

    const previousId = subjectIndex.get(record.subjectKey);
    if (previousId) removeChallenge(previousId);
    if (challenges.size >= maxChallenges) return false;

    challenges.set(record.id, { ...record, attempts: 0 });
    subjectIndex.set(record.subjectKey, record.id);
    return true;
  }

  function consumeChallenge({ id, credentialDigest, now, maxAttempts }) {
    const current = challenges.get(id);
    if (!current) return { status: "not_found" };

    if (current.expiresAt <= now) {
      removeChallenge(id);
      return { status: "expired" };
    }

    if (current.attempts >= maxAttempts) {
      removeChallenge(id);
      return { status: "locked" };
    }

    const expected = Buffer.from(current.credentialDigest, "hex");
    const supplied = Buffer.from(String(credentialDigest), "hex");
    const matches = expected.length === supplied.length &&
      expected.length > 0 &&
      timingSafeEqual(expected, supplied);

    if (!matches) {
      current.attempts += 1;
      if (current.attempts >= maxAttempts) {
        removeChallenge(id);
        return { status: "locked" };
      }
      return { status: "invalid" };
    }

    const result = {
      status: "valid",
      accountId: current.accountId,
      channel: current.channel
    };
    removeChallenge(id);
    return result;
  }

  function consumeLimit({ key, now, windowMs, maxRequests }) {
    if (typeof key !== "string" || !key || key.length > 256 ||
        !Number.isSafeInteger(now) || now < 0 ||
        !Number.isSafeInteger(windowMs) || windowMs < 1 ||
        !Number.isSafeInteger(maxRequests) || maxRequests < 1) {
      throw new TypeError("store.consumeLimit received invalid limiter input");
    }

    // Reclaim only genuinely expired windows before considering capacity.
    // A backwards wall-clock adjustment must not silently reset every bucket.
    for (const [knownKey, knownEntry] of limits) {
      if (now >= knownEntry.windowStartedAt &&
          now - knownEntry.windowStartedAt >= knownEntry.windowMs) {
        limits.delete(knownKey);
      }
    }

    let entry = limits.get(key);
    if (!entry && limits.size >= maxRateKeys) {
      // Never evict a live bucket: doing so would let attackers bypass limits
      // by creating many distinct keys. Unknown keys fail closed until a slot
      // naturally expires; existing buckets continue to work.
      let retryAfterMs = Number.POSITIVE_INFINITY;
      for (const knownEntry of limits.values()) {
        retryAfterMs = Math.min(
          retryAfterMs,
          Math.max(1, knownEntry.windowStartedAt + knownEntry.windowMs - now)
        );
      }
      return { allowed: false, retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : windowMs };
    }

    if (!entry || entry.windowMs !== windowMs) {
      entry = { windowStartedAt: now, windowMs, count: 0 };
      limits.set(key, entry);
    }

    entry.count += 1;
    return {
      allowed: entry.count <= maxRequests,
      retryAfterMs: Math.max(0, entry.windowStartedAt + entry.windowMs - now)
    };
  }

  return Object.freeze({
    putChallenge,
    consumeChallenge,
    consumeLimit,
    deleteChallenge: removeChallenge,
    getStats() {
      return Object.freeze({ challenges: challenges.size, rateLimitKeys: limits.size });
    },
    reset() {
      challenges.clear();
      subjectIndex.clear();
      limits.clear();
    }
  });
}

export function createAccountRecovery(options = {}) {
  if (!isRecord(options)) throw new TypeError("account recovery options must be an object");
  const allowedOptions = new Set([
    "secret", "store", "emailProvider", "smsProvider", "clientKeyGenerator",
    "onEvent", "clock", "requestPolicies", "verifyIpPolicy", "emailTtlMs",
    "smsTtlMs", "maxAttempts", "coreContract", "onCoreAttempt",
    "onCoreDecision", "onCoreEvent"
  ]);
  for (const key of Object.keys(options)) {
    if (!allowedOptions.has(key)) throw new TypeError("Unknown account recovery option: " + key);
  }

  const secret = normalizeSecret(options.secret);
  const store = validateStore(options.store ?? createMemoryRecoveryStore());
  if (options.coreContract?.operation !== undefined &&
      options.coreContract.operation !== "account_recovery") {
    throw new TypeError("coreContract.operation must be account_recovery for account recovery");
  }
  const core = options.coreContract === undefined
    ? null
    : normalizeAuthCoreContract({
      ...options.coreContract,
      operation: "account_recovery"
    }, secret);
  const onCoreAttempt = options.onCoreAttempt ?? (() => {});
  const onCoreDecision = options.onCoreDecision ?? (() => {});
  const onCoreEvent = options.onCoreEvent ?? (() => {});
  for (const [name, callback] of Object.entries({
    onCoreAttempt, onCoreDecision, onCoreEvent
  })) {
    if (typeof callback !== "function") throw new TypeError(name + " must be a function");
  }
  const emailProvider = options.emailProvider ?? null;
  const smsProvider = options.smsProvider ?? null;

  if (emailProvider !== null && (!isRecord(emailProvider) || typeof emailProvider.send !== "function")) {
    throw new TypeError("emailProvider must expose an async send({ to, requestId, token, expiresAt }) function");
  }
  if (smsProvider !== null && (!isRecord(smsProvider) || typeof smsProvider.send !== "function")) {
    throw new TypeError("smsProvider must expose an async send({ to, requestId, code, expiresAt }) function");
  }

  const clientKeyGenerator = options.clientKeyGenerator ??
    ((request) => request?.socket?.remoteAddress ?? "unknown");
  if (typeof clientKeyGenerator !== "function") throw new TypeError("clientKeyGenerator must be a function");

  const onEvent = options.onEvent ?? (() => {});
  if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");

  const clock = options.clock ?? Date.now;
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const requestPolicies = normalizeRequestPolicies(options.requestPolicies);
  const verifyIpPolicy = normalizePolicy(
    options.verifyIpPolicy ?? {},
    DEFAULT_VERIFY_IP_POLICY,
    "verifyIpPolicy"
  );
  const emailTtlMs = positiveInteger(options.emailTtlMs ?? 15 * 60_000, "emailTtlMs", 60 * 60_000);
  const smsTtlMs = positiveInteger(options.smsTtlMs ?? 5 * 60_000, "smsTtlMs", 30 * 60_000);
  const maxAttempts = positiveInteger(options.maxAttempts ?? 5, "maxAttempts", 10);

  const stats = {
    requests: 0,
    challengesIssued: 0,
    deliveryFailures: 0,
    suppressed: 0,
    rateLimited: 0,
    verificationSucceeded: 0,
    verificationFailed: 0
  };

  function digest(scope, value) {
    return createHmac("sha256", secret).update(scope).update("\0").update(value).digest("hex");
  }

  function readNow() {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("clock must return a non-negative safe integer timestamp in milliseconds");
    }
    return now;
  }

  function emit(action, ruleId, channel, scopes = [], severity = "medium", context = {}) {
    const occurredAtMs = context.occurredAtMs ?? readNow();
    safeNotify(onEvent, {
      id: randomUUID(),
      timestamp: new Date(occurredAtMs).toISOString(),
      component: "jb-security-guard",
      action,
      severity,
      ruleIds: [ruleId],
      channel,
      scopes
    });

    if (!core) return;
    const mappings = {
      "request-rate-limited": ["blocked", "denied"],
      "request-suppressed": ["observed", "observed"],
      "challenge-issued": ["challenged", "success"],
      "delivery-failed": ["rejected", "error"],
      "verification-rate-limited": ["blocked", "denied"],
      "verification-failed": ["rejected", "denied"],
      "verification-succeeded": ["allowed", "success"]
    };
    const [coreAction, outcome] = mappings[action] ?? ["observed", "observed"];
    const event = createRecoveryCoreEvent(core, {
      occurredAtMs,
      ruleId: context.coreRuleId ?? ruleId,
      severity: context.coreSeverity ?? severity,
      action: coreAction,
      outcome,
      scopes: context.coreScopes ?? scopes,
      subjectDigest: context.subjectDigest ?? null,
      correlationId: context.correlationId
    });
    safelyEmitAuthCore(onCoreEvent, event);
  }

  function publishVerificationCore({
    occurredAtMs,
    outcome,
    accountId = null,
    requestId = "",
    clientDigest,
    blocked = false,
    unavailable = false,
    retryAfterMs = 0
  }) {
    if (!core) return null;
    const subjectDigest = accountId !== null
      ? digest("account", String(accountId))
      : digest("recovery-challenge", requestId || "anonymous");
    const attempt = createAuthCoreAttempt(core, {
      attemptId: randomUUID(),
      occurredAtMs,
      outcome,
      accountDigest: subjectDigest,
      clientDigest
    });
    const decision = createAuthCoreDecision(attempt.attemptId, {
      blocked,
      enforced: blocked,
      unavailable,
      retryAfterSeconds: blocked ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : null
    });
    safelyEmitAuthCore(onCoreAttempt, attempt);
    safelyEmitAuthCore(onCoreDecision, Object.freeze({ attempt, decision }));
    return Object.freeze({ attempt, decision });
  }

  function emitCoreUnavailable(channel, occurredAtMs, subjectDigest = null, scopes = []) {
    if (!core) return;
    const event = createRecoveryCoreEvent(core, {
      occurredAtMs,
      ruleId: "JBG-RECOVERY-STORE-001",
      severity: "critical",
      action: "rejected",
      outcome: "unavailable",
      scopes: scopes.length ? scopes : ["recoveryStore"],
      subjectDigest
    });
    safelyEmitAuthCore(onCoreEvent, event);
  }

  async function applyLimits(scopes, policies, now) {
    let allowed = true;
    let retryAfterMs = 0;
    const blockedScopes = [];

    for (const scope of scopes) {
      const policy = policies[scope.name];
      const result = await store.consumeLimit({
        key: scope.key,
        now,
        windowMs: policy.windowMs,
        maxRequests: policy.maxRequests
      });
      if (!result || typeof result.allowed !== "boolean") {
        throw new TypeError("store.consumeLimit returned an invalid result");
      }
      if (!result.allowed) {
        allowed = false;
        blockedScopes.push(scope.name);
        retryAfterMs = Math.max(retryAfterMs, Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : 0);
      }
    }
    return { allowed, retryAfterMs, blockedScopes };
  }

  function getClientDigest(request) {
    let clientKey = "unknown";
    try {
      const resolved = clientKeyGenerator(request);
      if (resolved !== null && resolved !== undefined && String(resolved).trim()) {
        clientKey = String(resolved).trim().slice(0, 256);
      }
    } catch {
      // Use the shared unknown-client bucket; forwarded headers are not trusted implicitly.
    }
    return digest("client", clientKey);
  }

  async function requestRecovery(input = {}) {
    if (!isRecord(input)) throw new TypeError("requestRecovery input must be an object");
    const channel = input.channel;
    if (channel !== "email" && channel !== "sms") {
      throw new TypeError("channel must be email or sms");
    }

    stats.requests += 1;
    const now = readNow();
    const requestId = randomUUID();
    const clientDigest = getClientDigest(input.request);
    const accountId = normalizeAccountId(input.accountId);
    const destination = normalizeDestination(channel, input.destination);
    const eligible = Boolean(accountId && destination && input.contactVerified === true);
    const accountDigest = eligible ? digest("account", accountId) : null;
    const destinationDigest = eligible ? digest("destination:" + channel, destination) : null;

    // Always perform the same three store operations, including for unknown
    // accounts, so a shared remote adapter does not add a simple timing oracle.
    const scopes = [
      { name: "ip", key: digest("request-ip", clientDigest) },
      {
        name: "account",
        key: eligible
          ? digest("request-account", accountDigest)
          : digest("request-account-missing", channel)
      },
      {
        name: "destination",
        key: eligible
          ? digest("request-destination", destinationDigest)
          : digest("request-destination-missing", channel)
      }
    ];
    const policyMap = requestPolicies;
    let limited;
    try {
      limited = await applyLimits(scopes, policyMap, now);
    } catch (error) {
      emitCoreUnavailable(channel, now, accountDigest, ["requestLimits"]);
      throw error;
    }
    if (!limited.allowed) {
      stats.rateLimited += 1;
      emit("request-rate-limited", RATE_RULE, channel, limited.blockedScopes, "high", {
        occurredAtMs: now, subjectDigest: accountDigest, correlationId: requestId
      });
      return Object.freeze({ accepted: true, requestId });
    }

    const provider = channel === "email" ? emailProvider : smsProvider;
    if (!eligible || !provider) {
      stats.suppressed += 1;
      emit("request-suppressed", REQUEST_RULE, channel, [], "medium", {
        occurredAtMs: now, subjectDigest: accountDigest, correlationId: requestId
      });
      return Object.freeze({ accepted: true, requestId });
    }

    const credential = channel === "email"
      ? randomBytes(32).toString("base64url")
      : String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = now + (channel === "email" ? emailTtlMs : smsTtlMs);
    const subjectKey = digest("subject-index", accountDigest + "\0" + channel);
    const credentialDigest = digest("credential", requestId + "\0" + credential);

    let stored;
    try {
      stored = await store.putChallenge({
        id: requestId,
        subjectKey,
        accountId,
        channel,
        credentialDigest,
        createdAt: now,
        expiresAt
      });
    } catch (error) {
      emitCoreUnavailable(channel, now, accountDigest, ["challengeStore"]);
      throw error;
    }
    if (stored === false) {
      stats.suppressed += 1;
      emitCoreUnavailable(channel, now, accountDigest, ["challengeCapacity"]);
      emit("request-suppressed", REQUEST_RULE, channel, [], "medium", {
        occurredAtMs: now, subjectDigest: accountDigest, correlationId: requestId
      });
      return Object.freeze({ accepted: true, requestId });
    }
    stats.challengesIssued += 1;

    const delivery = channel === "email"
      ? Object.freeze({ to: destination, requestId, token: credential, expiresAt })
      : Object.freeze({ to: destination, requestId, code: credential, expiresAt });

    // Do not make the public response wait for a provider. This keeps account
    // existence and provider latency from becoming an easy timing oracle.
    Promise.resolve()
      .then(() => provider.send(delivery))
      .then(() => {
        emit("challenge-issued", REQUEST_RULE, channel, [], "info", {
          subjectDigest: accountDigest, correlationId: requestId
        });
      })
      .catch(async () => {
        try {
          await store.deleteChallenge(requestId);
        } catch {
          // Keep the public recovery response generic even if cleanup fails.
          emitCoreUnavailable(channel, now, accountDigest, ["challengeCleanup"]);
        }
        stats.deliveryFailures += 1;
        emit("delivery-failed", REQUEST_RULE, channel, [], "high", {
          subjectDigest: accountDigest, correlationId: requestId
        });
      });

    return Object.freeze({ accepted: true, requestId });
  }

  async function verifyRecovery(input = {}) {
    if (!isRecord(input)) throw new TypeError("verifyRecovery input must be an object");
    const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
    const credential = typeof input.credential === "string" ? input.credential : "";

    const now = readNow();
    const clientDigest = getClientDigest(input.request);
    const subjectDigest = digest("recovery-challenge", requestId || "anonymous");
    let limit;
    try {
      limit = await store.consumeLimit({
        key: digest("verify-ip", clientDigest),
        now,
        windowMs: verifyIpPolicy.windowMs,
        maxRequests: verifyIpPolicy.maxRequests
      });
    } catch (error) {
      publishVerificationCore({
        occurredAtMs: now, outcome: "failure", requestId, clientDigest, unavailable: true
      });
      emitCoreUnavailable(null, now, subjectDigest, ["verifyLimits"]);
      throw error;
    }

    if (!limit || typeof limit.allowed !== "boolean") {
      throw new TypeError("store.consumeLimit returned an invalid result");
    }
    if (!limit.allowed) {
      stats.rateLimited += 1;
      stats.verificationFailed += 1;
      emit("verification-rate-limited", RATE_RULE, null, ["verifyIp"], "high", {
        occurredAtMs: now, subjectDigest, correlationId: requestId
      });
      publishVerificationCore({
        occurredAtMs: now, outcome: "failure", requestId, clientDigest,
        blocked: true, retryAfterMs: limit.retryAfterMs
      });
      return Object.freeze({ valid: false });
    }

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) || credential.length < 1 || credential.length > 2048) {
      stats.verificationFailed += 1;
      emit("verification-failed", VERIFY_RULE, null, [], "medium", {
        occurredAtMs: now, subjectDigest, correlationId: requestId
      });
      publishVerificationCore({
        occurredAtMs: now, outcome: "failure", requestId, clientDigest
      });
      return Object.freeze({ valid: false });
    }

    const credentialDigest = digest("credential", requestId + "\0" + credential);
    let result;
    try {
      result = await store.consumeChallenge({
        id: requestId,
        credentialDigest,
        now,
        maxAttempts
      });
    } catch (error) {
      publishVerificationCore({
        occurredAtMs: now, outcome: "failure", requestId, clientDigest, unavailable: true
      });
      emitCoreUnavailable(null, now, subjectDigest, ["challengeStore"]);
      throw error;
    }

    if (!result || result.status !== "valid") {
      stats.verificationFailed += 1;
      const status = result?.status ?? "not_found";
      const coreClassification = {
        invalid: {
          ruleId: VERIFY_RULE, severity: "medium", scope: "invalidCredential"
        },
        expired: {
          ruleId: "JBG-RECOVERY-EXPIRED-001", severity: "medium", scope: "challengeExpired"
        },
        locked: {
          ruleId: "JBG-RECOVERY-BRUTE-001", severity: "high", scope: "challengeLocked"
        },
        not_found: {
          ruleId: "JBG-RECOVERY-CHALLENGE-001", severity: "medium", scope: "challengeMissingOrConsumed"
        }
      }[status] ?? {
        ruleId: VERIFY_RULE, severity: "medium", scope: "challengeInvalid"
      };
      emit("verification-failed", VERIFY_RULE, null, [], "medium", {
        occurredAtMs: now,
        subjectDigest,
        correlationId: requestId,
        coreRuleId: coreClassification.ruleId,
        coreSeverity: coreClassification.severity,
        coreScopes: [coreClassification.scope]
      });
      publishVerificationCore({
        occurredAtMs: now, outcome: "failure", requestId, clientDigest
      });
      return Object.freeze({ valid: false });
    }

    stats.verificationSucceeded += 1;
    const verifiedAccountDigest = digest("account", String(result.accountId));
    emit("verification-succeeded", VERIFY_RULE, result.channel, [], "info", {
      occurredAtMs: now, subjectDigest: verifiedAccountDigest, correlationId: requestId
    });
    publishVerificationCore({
      occurredAtMs: now, outcome: "success", accountId: result.accountId,
      requestId, clientDigest
    });
    return Object.freeze({
      valid: true,
      accountId: result.accountId,
      channel: result.channel
    });
  }

  function getStats() {
    return Object.freeze({
      ...stats,
      storage: typeof store.getStats === "function" ? store.getStats() : null
    });
  }

  return Object.freeze({ requestRecovery, verifyRecovery, getStats });
}
