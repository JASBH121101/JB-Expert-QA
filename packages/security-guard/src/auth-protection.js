import { createHmac, randomBytes, randomUUID } from "node:crypto";

const SEVERITY = "high";
const RULE_ID = "JBG-AUTH-BRUTE-001";
const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_RESET_AFTER_MS = 60 * 60_000;
const DEFAULT_MAX_TRACKED_KEYS = 10_000;

const DEFAULT_POLICIES = Object.freeze({
  ip: Object.freeze({ maxFailures: 20, lockoutMs: 5 * 60_000, maxLockoutMs: 30 * 60_000 }),
  accountIp: Object.freeze({ maxFailures: 5, lockoutMs: 60_000, maxLockoutMs: 15 * 60_000 }),
  account: Object.freeze({ maxFailures: 12, lockoutMs: 15_000, maxLockoutMs: 60_000 })
});

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(name + " must be a positive integer no greater than " + maximum);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeNotify(onEvent, event) {
  try {
    const result = onEvent(Object.freeze({ ...event, ruleIds: Object.freeze([...event.ruleIds]), scopes: Object.freeze([...event.scopes]) }));
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch {
    // Observability must never break the protected authentication handler.
  }
}

function normalizeIdentifier(value, name, maximumLength) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError(name + " must return a string, number, null, or undefined");
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.length > maximumLength) {
    throw new TypeError(name + " returned an identifier that exceeds " + maximumLength + " characters");
  }
  return normalized;
}

function normalizePolicies(input = {}) {
  if (!isRecord(input)) throw new TypeError("policies must be an object");
  const policies = {};
  for (const scope of Object.keys(DEFAULT_POLICIES)) {
    const supplied = input[scope] ?? {};
    if (!isRecord(supplied)) throw new TypeError("policies." + scope + " must be an object");
    const defaults = DEFAULT_POLICIES[scope];
    for (const key of Object.keys(supplied)) {
      if (!Object.hasOwn(defaults, key)) {
        throw new TypeError("Unknown policies." + scope + " option: " + key);
      }
    }
    policies[scope] = Object.freeze({
      maxFailures: positiveInteger(supplied.maxFailures ?? defaults.maxFailures, "policies." + scope + ".maxFailures", 1_000_000),
      lockoutMs: positiveInteger(supplied.lockoutMs ?? defaults.lockoutMs, "policies." + scope + ".lockoutMs", 86_400_000),
      maxLockoutMs: positiveInteger(supplied.maxLockoutMs ?? defaults.maxLockoutMs, "policies." + scope + ".maxLockoutMs", 7 * 86_400_000)
    });
    if (policies[scope].maxLockoutMs < policies[scope].lockoutMs) {
      throw new TypeError("policies." + scope + ".maxLockoutMs cannot be lower than lockoutMs");
    }
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_POLICIES, key)) throw new TypeError("Unknown authentication policy scope: " + key);
  }
  return Object.freeze(policies);
}

export function createAuthProtection(options = {}) {
  if (!isRecord(options)) throw new TypeError("Authentication protection options must be an object");
  const allowedOptions = new Set([
    "identityKeyGenerator", "clientKeyGenerator", "mode", "blockSeverities",
    "onEvent", "windowMs", "resetAfterMs", "maxTrackedKeys", "policies",
    "clock", "keySecret"
  ]);
  for (const key of Object.keys(options)) {
    if (!allowedOptions.has(key)) throw new TypeError("Unknown authentication protection option: " + key);
  }

  const identityKeyGenerator = options.identityKeyGenerator;
  if (typeof identityKeyGenerator !== "function") {
    throw new TypeError("identityKeyGenerator is required and must be a function");
  }

  const clientKeyGenerator = options.clientKeyGenerator ?? ((request) => request.socket?.remoteAddress ?? null);
  if (typeof clientKeyGenerator !== "function") throw new TypeError("clientKeyGenerator must be a function");

  const mode = options.mode ?? "monitor";
  if (!["monitor", "balanced", "strict", "custom"].includes(mode)) {
    throw new TypeError("mode must be monitor, balanced, strict, or custom");
  }
  const blockSeverities = options.blockSeverities ?? ["high", "critical"];
  if (!Array.isArray(blockSeverities) ||
      blockSeverities.some((value) => !["info", "low", "medium", "high", "critical"].includes(value)) ||
      new Set(blockSeverities).size !== blockSeverities.length) {
    throw new TypeError("blockSeverities must contain unique supported severity names");
  }

  const onEvent = options.onEvent ?? (() => {});
  if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");

  const windowMs = positiveInteger(options.windowMs ?? DEFAULT_WINDOW_MS, "windowMs", 7 * 86_400_000);
  const resetAfterMs = positiveInteger(options.resetAfterMs ?? DEFAULT_RESET_AFTER_MS, "resetAfterMs", 30 * 86_400_000);
  const maxTrackedKeys = positiveInteger(options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS, "maxTrackedKeys", 100_000);
  const policies = normalizePolicies(options.policies);
  const clock = options.clock ?? Date.now;
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const keySecret = options.keySecret ?? randomBytes(32);
  if (!(typeof keySecret === "string" && keySecret.length >= 16) &&
      !(Buffer.isBuffer(keySecret) && keySecret.length >= 16)) {
    throw new TypeError("keySecret must be a string or Buffer containing at least 16 bytes");
  }

  const buckets = {
    ip: new Map(),
    accountIp: new Map(),
    account: new Map()
  };
  const overflowBuckets = { ip: null, accountIp: null, account: null };
  const stats = {
    failures: 0,
    lockouts: 0,
    blocked: 0,
    observed: 0
  };

  function readNow() {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("clock must return a non-negative safe integer timestamp in milliseconds");
    }
    return now;
  }

  function digest(scope, value) {
    return createHmac("sha256", keySecret).update(scope).update("\0").update(value).digest("hex");
  }

  function getKeys(request) {
    let account = null;
    let client = null;
    try {
      account = normalizeIdentifier(identityKeyGenerator(request), "identityKeyGenerator", 320);
    } catch {
      // A broken account resolver must not disable IP-scoped protection.
    }
    try {
      client = normalizeIdentifier(clientKeyGenerator(request), "clientKeyGenerator", 256);
    } catch {
      // Ignore a failing client resolver and keep any available account scope.
    }

    return {
      account: account ? digest("account", account) : null,
      ip: client ? digest("ip", client) : null,
      accountIp: account && client ? digest("account-ip", account + "\0" + client) : null
    };
  }

  function touchBucket(scope, key, now) {
    const store = buckets[scope];
    let entry = store.get(key);
    if (entry && now - entry.lastFailureAt >= resetAfterMs) {
      entry = null;
      store.delete(key);
    }

    if (!entry && store.size >= maxTrackedKeys) {
      // Reclaim only expired buckets. Live identity buckets are never evicted.
      for (const [knownKey, knownEntry] of store) {
        if (now - knownEntry.lastFailureAt >= resetAfterMs) store.delete(knownKey);
      }
      if (store.size >= maxTrackedKeys) {
        // New identities share one bounded overflow bucket and can temporarily throttle.
        entry = overflowBuckets[scope];
        if (entry && now - entry.lastFailureAt >= resetAfterMs) entry = null;
        if (!entry) {
          entry = {
            windowStartedAt: now,
            lastFailureAt: now,
            failures: 0,
            lockouts: 0,
            blockedUntil: 0
          };
        }
        overflowBuckets[scope] = entry;
        return entry;
      }
    }

    if (!entry) {
      entry = {
        windowStartedAt: now,
        lastFailureAt: now,
        failures: 0,
        lockouts: 0,
        blockedUntil: 0
      };
    }
    store.set(key, entry);
    return entry;
  }

  function getActiveStatus(keys, now) {
    const activeScopes = [];
    let blockedUntil = 0;
    for (const scope of ["ip", "accountIp", "account"]) {
      const key = keys[scope];
      if (!key) continue;
      const entry = key ? buckets[scope].get(key) : null;
      const overflow = overflowBuckets[scope];
      for (const candidate of [entry, overflow]) {
        if (candidate && now - candidate.lastFailureAt < resetAfterMs && candidate.blockedUntil > now) {
          activeScopes.push(scope);
          blockedUntil = Math.max(blockedUntil, candidate.blockedUntil);
        }
      }
    }
    return {
      blocked: activeScopes.length > 0,
      retryAfterMs: Math.max(0, blockedUntil - now),
      scopes: activeScopes
    };
  }

  function statusFor(request) {
    const now = readNow();
    return getActiveStatus(getKeys(request), now);
  }

  function recordFailure(request) {
    if (!request || typeof request !== "object") {
      throw new TypeError("recordFailure requires the authentication request");
    }
    const now = readNow();
    const keys = getKeys(request);
    const triggered = [];
    const active = [];

    for (const scope of ["ip", "accountIp", "account"]) {
      const key = keys[scope];
      if (!key) continue;
      const entry = touchBucket(scope, key, now);
      const policy = policies[scope];

      if (entry.blockedUntil > now) {
        active.push(scope);
        continue;
      }
      if (now - entry.windowStartedAt >= windowMs) {
        entry.windowStartedAt = now;
        entry.failures = 0;
      }

      entry.lastFailureAt = now;
      entry.failures += 1;
      stats.failures += 1;

      if (entry.failures >= policy.maxFailures) {
        entry.lockouts += 1;
        const multiplier = 2 ** Math.min(entry.lockouts - 1, 10);
        const duration = Math.min(policy.lockoutMs * multiplier, policy.maxLockoutMs);
        entry.blockedUntil = now + duration;
        entry.failures = 0;
        entry.windowStartedAt = now;
        triggered.push(scope);
        active.push(scope);
      }
    }

    const latest = getActiveStatus(keys, now);
    const enforced = mode !== "monitor" && blockSeverities.includes(SEVERITY);
    const result = Object.freeze({
      throttled: latest.blocked,
      enforced: latest.blocked && enforced,
      retryAfterMs: latest.retryAfterMs,
      retryAfterSeconds: latest.blocked ? Math.max(1, Math.ceil(latest.retryAfterMs / 1000)) : 0,
      scopes: Object.freeze([...new Set([...active, ...latest.scopes])])
    });

    if (triggered.length > 0) {
      stats.lockouts += triggered.length;
      const eventId = randomUUID();
      safeNotify(onEvent, {
        id: eventId,
        timestamp: new Date(now).toISOString(),
        component: "jb-security-guard",
        action: enforced ? "throttle-started" : "throttle-observed",
        mode,
        severity: SEVERITY,
        ruleIds: [RULE_ID],
        scopes: triggered,
        retryAfterSeconds: Math.max(1, Math.ceil(latest.retryAfterMs / 1000))
      });
    }

    return result;
  }

  function recordSuccess(request) {
    if (!request || typeof request !== "object") {
      throw new TypeError("recordSuccess requires the authentication request");
    }
    const keys = getKeys(request);
    for (const scope of ["accountIp", "account"]) {
      if (keys[scope]) buckets[scope].delete(keys[scope]);
    }
    // Do not clear an IP bucket: a successful account must not erase failures
    // accumulated by the same source against other accounts.
  }

  function middleware(request, response, next) {
    if (!request || !response || typeof next !== "function") {
      throw new TypeError("Authentication middleware requires (request, response, next)");
    }
    const status = statusFor(request);
    const enforced = status.blocked && mode !== "monitor" && blockSeverities.includes(SEVERITY);

    if (!status.blocked) {
      next();
      return;
    }

    if (!enforced) {
      stats.observed += 1;
      next();
      return;
    }

    stats.blocked += 1;
    if (response.headersSent || response.writableEnded) {
      response.destroy?.();
      return;
    }

    response.statusCode = 429;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Retry-After", String(Math.max(1, Math.ceil(status.retryAfterMs / 1000))));
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      error: "authentication_temporarily_unavailable",
      message: "Authentication is temporarily unavailable. Try again later."
    }));
  }

  function getStats() {
    return Object.freeze({
      failures: stats.failures,
      lockouts: stats.lockouts,
      blocked: stats.blocked,
      observed: stats.observed,
      trackedIpKeys: buckets.ip.size,
      trackedAccountIpKeys: buckets.accountIp.size,
      trackedAccountKeys: buckets.account.size
    });
  }

  function reset() {
    for (const store of Object.values(buckets)) store.clear();
    for (const scope of Object.keys(overflowBuckets)) overflowBuckets[scope] = null;
    for (const key of Object.keys(stats)) stats[key] = 0;
  }

  return Object.freeze({
    middleware,
    recordFailure,
    recordSuccess,
    getStatus: statusFor,
    getStats,
    reset
  });
}
