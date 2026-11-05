import { createHmac, randomBytes, randomUUID } from "node:crypto";

const RULE_ID = "JBG-RATE-DISTRIBUTED-001";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(name + " must be a positive integer no greater than " + maximum);
  }
  return value;
}

function notify(onEvent, event) {
  try {
    const result = onEvent(Object.freeze({ ...event, ruleIds: Object.freeze([...event.ruleIds]) }));
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch { /* Observability must never interrupt request protection. */ }
}

function respond(response, statusCode, payload, headers = {}) {
  if (response.headersSent || response.writableEnded) {
    response.destroy?.();
    return;
  }
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, String(value));
  response.end(JSON.stringify(payload));
}

/**
 * Asynchronous request limiter backed by an atomic shared fixed-window store.
 * The store must implement consumeLimit({ key, now, windowMs, maxRequests }).
 */
export function createDistributedRateLimit(options = {}) {
  if (!isRecord(options)) throw new TypeError("Distributed rate-limit options must be an object");
  const allowed = new Set(["store", "secret", "keyGenerator", "namespace", "windowMs", "maxRequests", "clock", "failClosed", "onEvent"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("Unknown distributed rate-limit option: " + key);
  }
  const store = options.store;
  if (!isRecord(store) || typeof store.consumeLimit !== "function") {
    throw new TypeError("store.consumeLimit must implement an atomic shared fixed-window counter");
  }
  const secret = options.secret ?? randomBytes(32);
  if (!(typeof secret === "string" && Buffer.byteLength(secret) >= 32) &&
      !(Buffer.isBuffer(secret) && secret.length >= 32)) {
    throw new TypeError("secret must contain at least 32 bytes and remain stable across instances");
  }
  const keyGenerator = options.keyGenerator ?? ((request) => request.socket?.remoteAddress ?? "unknown");
  if (typeof keyGenerator !== "function") throw new TypeError("keyGenerator must be a function");
  const namespace = options.namespace ?? "jb-guard:request";
  if (typeof namespace !== "string" || !/^[a-zA-Z0-9:_-]{1,96}$/.test(namespace)) {
    throw new TypeError("namespace must contain 1-96 safe identifier characters");
  }
  const windowMs = positiveInteger(options.windowMs ?? 60_000, "windowMs", 86_400_000);
  const maxRequests = positiveInteger(options.maxRequests ?? 120, "maxRequests", 1_000_000);
  const clock = options.clock ?? Date.now;
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const failClosed = options.failClosed ?? true;
  if (typeof failClosed !== "boolean") throw new TypeError("failClosed must be a boolean");
  const onEvent = options.onEvent ?? (() => {});
  if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");

  const stats = { requests: 0, allowed: 0, blocked: 0, storeErrors: 0 };

  function readNow() {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("clock must return a non-negative safe integer timestamp in milliseconds");
    }
    return now;
  }

  function makeKey(request) {
    let identity;
    try {
      const value = keyGenerator(request);
      identity = value === null || value === undefined ? "unknown" : String(value).trim();
    } catch { identity = "unknown"; }
    if (!identity) identity = "unknown";
    if (identity.length > 512) identity = identity.slice(0, 512);
    const digest = createHmac("sha256", secret).update(namespace).update("\0").update(identity).digest("hex");
    return namespace + ":" + digest;
  }

  async function middleware(request, response, next) {
    if (!request || typeof request !== "object" || !response ||
        typeof response.setHeader !== "function" || typeof response.end !== "function" ||
        typeof next !== "function") {
      throw new TypeError("Distributed rate-limit middleware requires (request, response, next)");
    }
    stats.requests += 1;
    const now = readNow();
    let result;
    try {
      result = await store.consumeLimit({ key: makeKey(request), now, windowMs, maxRequests });
      if (!isRecord(result) || typeof result.allowed !== "boolean" ||
          (result.count !== undefined && (!Number.isSafeInteger(result.count) || result.count < 1)) ||
          (result.retryAfterMs !== undefined && (!Number.isFinite(result.retryAfterMs) || result.retryAfterMs < 0))) {
        throw new TypeError("store.consumeLimit returned an invalid result");
      }
    } catch {
      stats.storeErrors += 1;
      notify(onEvent, {
        id: randomUUID(), timestamp: new Date(now).toISOString(),
        component: "jb-security-guard", action: "distributed-rate-store-unavailable",
        severity: "critical", ruleIds: [RULE_ID]
      });
      if (failClosed) {
        respond(response, 503, {
          error: "security_rate_limit_unavailable",
          message: "Request temporarily unavailable due to a security control."
        }, { "Retry-After": 5 });
      } else {
        next();
      }
      return;
    }

    if (result.allowed) {
      stats.allowed += 1;
      next();
      return;
    }

    stats.blocked += 1;
    if (result.count === maxRequests + 1) {
      notify(onEvent, {
        id: randomUUID(), timestamp: new Date(now).toISOString(),
        component: "jb-security-guard", action: "distributed-rate-limit-exceeded",
        severity: "high", ruleIds: [RULE_ID]
      });
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((result.retryAfterMs ?? windowMs) / 1000));
    respond(response, 429, {
      error: "rate_limit_exceeded",
      message: "Too many requests. Try again later."
    }, { "Retry-After": retryAfterSeconds });
  }

  return Object.freeze({
    middleware,
    getStats: () => Object.freeze({ ...stats })
  });
}
