import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual
} from "node:crypto";

const REQUEST_RULE = "JBG-RECOVERY-REQUEST-001";
const VERIFY_RULE = "JBG-RECOVERY-VERIFY-001";
const RATE_RULE = "JBG-RECOVERY-RATE-001";
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
    if (!isRecord(record) || typeof record.id !== "string" ||
        typeof record.subjectKey !== "string" || typeof record.credentialDigest !== "string") {
      throw new TypeError("challenge record is invalid");
    }

    const previousId = subjectIndex.get(record.subjectKey);
    if (previousId) removeChallenge(previousId);

    challenges.set(record.id, { ...record, attempts: 0 });
    subjectIndex.set(record.subjectKey, record.id);

    while (challenges.size > maxChallenges) {
      const oldestId = challenges.keys().next().value;
      if (oldestId === undefined) break;
      removeChallenge(oldestId);
    }
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
    let entry = limits.get(key);
    if (!entry || now - entry.windowStartedAt >= windowMs || now < entry.windowStartedAt) {
      entry = { windowStartedAt: now, count: 0 };
      limits.delete(key);
      limits.set(key, entry);
    } else {
      limits.delete(key);
      limits.set(key, entry);
    }

    entry.count += 1;
    while (limits.size > maxRateKeys) {
      const oldestKey = limits.keys().next().value;
      if (oldestKey === undefined) break;
      limits.delete(oldestKey);
    }

    return {
      allowed: entry.count <= maxRequests,
      retryAfterMs: Math.max(0, entry.windowStartedAt + windowMs - now)
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

  const secret = normalizeSecret(options.secret);
  const store = validateStore(options.store ?? createMemoryRecoveryStore());
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

  function emit(action, ruleId, channel, scopes = [], severity = "medium") {
    safeNotify(onEvent, {
      id: randomUUID(),
      timestamp: new Date(clock()).toISOString(),
      component: "jb-security-guard",
      action,
      severity,
      ruleIds: [ruleId],
      channel,
      scopes
    });
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
    const now = clock();
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
          : digest("request-account-missing", requestId)
      },
      {
        name: "destination",
        key: eligible
          ? digest("request-destination", destinationDigest)
          : digest("request-destination-missing", requestId)
      }
    ];
    const policyMap = requestPolicies;
    const limited = await applyLimits(scopes, policyMap, now);
    if (!limited.allowed) {
      stats.rateLimited += 1;
      emit("request-rate-limited", RATE_RULE, channel, limited.blockedScopes, "high");
      return Object.freeze({ accepted: true, requestId });
    }

    const provider = channel === "email" ? emailProvider : smsProvider;
    if (!eligible || !provider) {
      stats.suppressed += 1;
      emit("request-suppressed", REQUEST_RULE, channel, [], "medium");
      return Object.freeze({ accepted: true, requestId });
    }

    const credential = channel === "email"
      ? randomBytes(32).toString("base64url")
      : String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = now + (channel === "email" ? emailTtlMs : smsTtlMs);
    const subjectKey = digest("subject-index", accountDigest + "\0" + channel);
    const credentialDigest = digest("credential", requestId + "\0" + credential);

    await store.putChallenge({
      id: requestId,
      subjectKey,
      accountId,
      channel,
      credentialDigest,
      createdAt: now,
      expiresAt
    });
    stats.challengesIssued += 1;

    const delivery = channel === "email"
      ? Object.freeze({ to: destination, requestId, token: credential, expiresAt })
      : Object.freeze({ to: destination, requestId, code: credential, expiresAt });

    // Do not make the public response wait for a provider. This keeps account
    // existence and provider latency from becoming an easy timing oracle.
    Promise.resolve()
      .then(() => provider.send(delivery))
      .then(() => {
        emit("challenge-issued", REQUEST_RULE, channel, [], "info");
      })
      .catch(async () => {
        try {
          await store.deleteChallenge(requestId);
        } catch {
          // Keep the public recovery response generic even if cleanup fails.
        }
        stats.deliveryFailures += 1;
        emit("delivery-failed", REQUEST_RULE, channel, [], "high");
      });

    return Object.freeze({ accepted: true, requestId });
  }

  async function verifyRecovery(input = {}) {
    if (!isRecord(input)) throw new TypeError("verifyRecovery input must be an object");
    const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
    const credential = typeof input.credential === "string" ? input.credential : "";

    const limit = await store.consumeLimit({
      key: digest("verify-ip", getClientDigest(input.request)),
      now: clock(),
      windowMs: verifyIpPolicy.windowMs,
      maxRequests: verifyIpPolicy.maxRequests
    });

    if (!limit || typeof limit.allowed !== "boolean") {
      throw new TypeError("store.consumeLimit returned an invalid result");
    }
    if (!limit.allowed) {
      stats.rateLimited += 1;
      stats.verificationFailed += 1;
      emit("verification-rate-limited", RATE_RULE, null, ["verifyIp"], "high");
      return Object.freeze({ valid: false });
    }

    if (!/^[0-9a-f-]{36}$/i.test(requestId) || credential.length < 1 || credential.length > 2048) {
      stats.verificationFailed += 1;
      emit("verification-failed", VERIFY_RULE, null, [], "medium");
      return Object.freeze({ valid: false });
    }

    const credentialDigest = digest("credential", requestId + "\0" + credential);
    const result = await store.consumeChallenge({
      id: requestId,
      credentialDigest,
      now: clock(),
      maxAttempts
    });

    if (!result || result.status !== "valid") {
      stats.verificationFailed += 1;
      emit("verification-failed", VERIFY_RULE, null, [], "medium");
      return Object.freeze({ valid: false });
    }

    stats.verificationSucceeded += 1;
    emit("verification-succeeded", VERIFY_RULE, result.channel, [], "info");
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
