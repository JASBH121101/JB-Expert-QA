import { createHmac, randomUUID } from "node:crypto";

const RULE_ID = "JBG-AUTH-DISTRIBUTED-001";
const DEFAULT_POLICIES = Object.freeze({
  ip: Object.freeze({ maxFailures: 20, lockoutMs: 300_000, maxLockoutMs: 1_800_000 }),
  accountIp: Object.freeze({ maxFailures: 5, lockoutMs: 60_000, maxLockoutMs: 900_000 }),
  account: Object.freeze({ maxFailures: 12, lockoutMs: 15_000, maxLockoutMs: 60_000 })
});
const SCOPES = Object.freeze(["ip", "accountIp", "account"]);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(name + " must be a positive integer no greater than " + maximum);
  }
  return value;
}

function normalizePolicies(input = {}) {
  if (!isRecord(input)) throw new TypeError("policies must be an object");
  const output = {};
  for (const scope of SCOPES) {
    const supplied = input[scope] ?? {};
    if (!isRecord(supplied)) throw new TypeError("policies." + scope + " must be an object");
    const defaults = DEFAULT_POLICIES[scope];
    for (const key of Object.keys(supplied)) {
      if (!Object.hasOwn(defaults, key)) throw new TypeError("Unknown policies." + scope + " option: " + key);
    }
    const policy = {
      maxFailures: positiveInteger(supplied.maxFailures ?? defaults.maxFailures, "policies." + scope + ".maxFailures", 1_000_000),
      lockoutMs: positiveInteger(supplied.lockoutMs ?? defaults.lockoutMs, "policies." + scope + ".lockoutMs", 86_400_000),
      maxLockoutMs: positiveInteger(supplied.maxLockoutMs ?? defaults.maxLockoutMs, "policies." + scope + ".maxLockoutMs", 7 * 86_400_000)
    };
    if (policy.maxLockoutMs < policy.lockoutMs) throw new TypeError("policies." + scope + ".maxLockoutMs cannot be lower than lockoutMs");
    output[scope] = Object.freeze(policy);
  }
  for (const key of Object.keys(input)) if (!SCOPES.includes(key)) throw new TypeError("Unknown authentication policy scope: " + key);
  return Object.freeze(output);
}

function notify(onEvent, event) {
  try {
    const result = onEvent(Object.freeze({ ...event, ruleIds: Object.freeze([...event.ruleIds]), scopes: Object.freeze([...event.scopes]) }));
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch { /* Logging must never break authentication protection. */ }
}

function respondUnavailable(response) {
  if (response.headersSent || response.writableEnded) {
    response.destroy?.();
    return;
  }
  response.statusCode = 503;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Retry-After", "5");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({
    error: "authentication_temporarily_unavailable",
    message: "Authentication is temporarily unavailable. Try again later."
  }));
}

/**
 * Distributed authentication throttling. The supplied store must implement
 * atomic recordFailure, getStatus and clearFailures operations shared by all workers.
 */
export function createDistributedAuthProtection(options = {}) {
  if (!isRecord(options)) throw new TypeError("Distributed authentication options must be an object");
  const allowed = new Set(["store", "secret", "identityKeyGenerator", "clientKeyGenerator", "namespace", "mode", "blockSeverities", "policies", "windowMs", "resetAfterMs", "clock", "onEvent"]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new TypeError("Unknown distributed authentication option: " + key);

  const store = options.store;
  for (const method of ["recordFailure", "getStatus", "clearFailures"]) {
    if (!isRecord(store) || typeof store[method] !== "function") {
      throw new TypeError("store." + method + " must implement the distributed atomic authentication-store contract");
    }
  }
  const secret = options.secret;
  if (!(typeof secret === "string" && Buffer.byteLength(secret) >= 32) &&
      !(Buffer.isBuffer(secret) && secret.length >= 32)) {
    throw new TypeError("secret must contain at least 32 bytes and remain stable across instances");
  }
  if (typeof options.identityKeyGenerator !== "function") throw new TypeError("identityKeyGenerator is required and must be a function");
  const clientKeyGenerator = options.clientKeyGenerator ?? ((request) => request.socket?.remoteAddress ?? null);
  if (typeof clientKeyGenerator !== "function") throw new TypeError("clientKeyGenerator must be a function");
  const namespace = options.namespace ?? "jb-guard:auth";
  if (typeof namespace !== "string" || !/^[a-zA-Z0-9:_-]{1,96}$/.test(namespace)) throw new TypeError("namespace must contain 1-96 safe identifier characters");
  const mode = options.mode ?? "monitor";
  if (!["monitor", "balanced", "strict", "custom"].includes(mode)) throw new TypeError("mode must be monitor, balanced, strict, or custom");
  const blockSeverities = options.blockSeverities ?? ["high", "critical"];
  if (!Array.isArray(blockSeverities) || blockSeverities.some((v) => !["info", "low", "medium", "high", "critical"].includes(v)) || new Set(blockSeverities).size !== blockSeverities.length) {
    throw new TypeError("blockSeverities must contain unique supported severity names");
  }
  const policies = normalizePolicies(options.policies);
  const windowMs = positiveInteger(options.windowMs ?? 600_000, "windowMs", 7 * 86_400_000);
  const resetAfterMs = positiveInteger(options.resetAfterMs ?? 3_600_000, "resetAfterMs", 30 * 86_400_000);
  const clock = options.clock ?? Date.now;
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const onEvent = options.onEvent ?? (() => {});
  if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");
  const stats = { failures: 0, lockouts: 0, blocked: 0, storeErrors: 0 };

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("clock must return a non-negative safe integer timestamp");
    return value;
  }

  function digest(scope, value) {
    return createHmac("sha256", secret).update(namespace).update("\0").update(scope).update("\0").update(value).digest("hex");
  }

  function getKeys(request) {
    let account = null;
    let client = null;
    try {
      const value = options.identityKeyGenerator(request);
      if (value !== null && value !== undefined && String(value).trim()) {
        account = String(value).trim().toLowerCase();
        if (account.length > 320) throw new TypeError("Account identifier is too long");
      }
    } catch { /* IP protection remains available if account resolution fails. */ }
    try {
      const value = clientKeyGenerator(request);
      if (value !== null && value !== undefined && String(value).trim()) {
        client = String(value).trim();
        if (client.length > 256) client = client.slice(0, 256);
      }
    } catch { /* Keep account-scoped protection when client resolution fails. */ }
    const keys = {
      account: account ? digest("account", account) : null,
      ip: client ? digest("ip", client) : null,
      accountIp: account && client ? digest("account-ip", account + "\0" + client) : null
    };
    if (!keys.account && !keys.ip) {
      throw new TypeError("At least one server-resolved account or client identity is required");
    }
    return keys;
  }

  function activeKeys(keys) {
    return SCOPES.map((scope) => ({ scope, key: keys[scope] })).filter((item) => item.key);
  }

  async function getStatus(request) {
    if (!request || typeof request !== "object") throw new TypeError("getStatus requires an authentication request");
    const timestamp = now();
    const keys = activeKeys(getKeys(request));
    if (keys.length === 0) return Object.freeze({ blocked: false, retryAfterMs: 0, scopes: Object.freeze([]) });
    const result = await store.getStatus({ keys, now: timestamp, resetAfterMs });
    if (!isRecord(result) || typeof result.blocked !== "boolean" ||
        !Array.isArray(result.scopes) || result.scopes.some((scope) => !SCOPES.includes(scope)) ||
        !Number.isFinite(result.retryAfterMs) || result.retryAfterMs < 0) {
      throw new TypeError("store.getStatus returned an invalid result");
    }
    return Object.freeze({
      blocked: result.blocked,
      retryAfterMs: result.retryAfterMs,
      retryAfterSeconds: result.blocked ? Math.max(1, Math.ceil(result.retryAfterMs / 1000)) : 0,
      scopes: Object.freeze([...new Set(result.scopes)])
    });
  }

  async function recordFailure(request) {
    if (!request || typeof request !== "object") throw new TypeError("recordFailure requires the authentication request");
    const timestamp = now();
    const keys = activeKeys(getKeys(request));
    const triggered = [];
    const statuses = await Promise.all(keys.map(async ({ scope, key }) => {
      const result = await store.recordFailure({
        key, scope, now: timestamp, windowMs, resetAfterMs, ...policies[scope]
      });
      if (!isRecord(result) || typeof result.blocked !== "boolean" ||
          !Number.isFinite(result.retryAfterMs) || result.retryAfterMs < 0 ||
          (result.triggered !== undefined && typeof result.triggered !== "boolean")) {
        throw new TypeError("store.recordFailure returned an invalid result");
      }
      if (result.triggered) triggered.push(scope);
      return { scope, ...result };
    }));
    stats.failures += keys.length;
    if (triggered.length) {
      stats.lockouts += triggered.length;
      const blocked = statuses.filter((item) => item.blocked);
      notify(onEvent, {
        id: randomUUID(), timestamp: new Date(timestamp).toISOString(),
        component: "jb-security-guard", action: mode === "monitor" ? "throttle-observed" : "throttle-started",
        mode, severity: "high", ruleIds: [RULE_ID], scopes: triggered,
        retryAfterSeconds: Math.max(1, Math.ceil(Math.max(...blocked.map((item) => item.retryAfterMs), 0) / 1000))
      });
    }
    const blocked = statuses.filter((item) => item.blocked);
    const retryAfterMs = Math.max(0, ...blocked.map((item) => item.retryAfterMs));
    return Object.freeze({
      throttled: blocked.length > 0,
      enforced: blocked.length > 0 && mode !== "monitor" && blockSeverities.includes("high"),
      retryAfterMs,
      retryAfterSeconds: blocked.length ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : 0,
      scopes: Object.freeze(blocked.map((item) => item.scope))
    });
  }

  async function recordSuccess(request) {
    if (!request || typeof request !== "object") throw new TypeError("recordSuccess requires the authentication request");
    const keys = getKeys(request);
    const clear = activeKeys({ ip: null, accountIp: keys.accountIp, account: keys.account });
    if (clear.length) await store.clearFailures({ keys: clear, now: now(), resetAfterMs });
  }

  async function middleware(request, response, next) {
    if (!request || !response || typeof response.setHeader !== "function" || typeof response.end !== "function" || typeof next !== "function") {
      throw new TypeError("Distributed authentication middleware requires (request, response, next)");
    }
    let status;
    try {
      status = await getStatus(request);
    } catch {
      stats.storeErrors += 1;
      notify(onEvent, {
        id: randomUUID(), timestamp: new Date().toISOString(),
        component: "jb-security-guard", action: "distributed-auth-store-unavailable",
        mode, severity: "critical", ruleIds: [RULE_ID], scopes: []
      });
      respondUnavailable(response);
      return;
    }
    if (!status.blocked || mode === "monitor" || !blockSeverities.includes("high")) {
      if (status.blocked) stats.blocked += 1;
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
    response.setHeader("Retry-After", String(status.retryAfterSeconds));
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      error: "authentication_temporarily_unavailable",
      message: "Authentication is temporarily unavailable. Try again later."
    }));
  }

  return Object.freeze({
    middleware, recordFailure, recordSuccess, getStatus,
    getStats: () => Object.freeze({ ...stats })
  });
}
