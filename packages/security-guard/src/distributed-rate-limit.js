import { createHmac, randomUUID } from "node:crypto";
import {
  validateRateLimitCheckV1,
  toRateLimitDecisionV1,
  validateSecurityEventV1
} from "./core-contract-v1.js";

const RULE_ID = "JBG-RATE-DISTRIBUTED-001";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const SAFE_IDENTIFIER = /^[A-Za-z0-9:_-]{1,96}$/;
const SAFE_KEY_ID = /^[A-Za-z0-9:_-]{1,64}$/;
const CORE_IDENTITY_TYPES = new Set(["ip", "account", "account_ip", "session", "anonymous"]);

function normalizeCoreContract(value) {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new TypeError("coreContract must be an object");
  const allowed = new Set([
    "tenantId", "applicationId", "policyId", "scope",
    "identityType", "identityKeyId"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError("Unknown coreContract option: " + key);
  }
  for (const key of ["tenantId", "applicationId", "policyId"]) {
    if (typeof value[key] !== "string" || !SAFE_IDENTIFIER.test(value[key])) {
      throw new TypeError("coreContract." + key + " must be a safe identifier");
    }
  }
  const scope = value.scope ?? "request";
  if (typeof scope !== "string" || !SAFE_IDENTIFIER.test(scope)) {
    throw new TypeError("coreContract.scope must be a safe identifier");
  }
  if (!CORE_IDENTITY_TYPES.has(value.identityType)) {
    throw new TypeError("coreContract.identityType must be a supported identity type");
  }
  if (typeof value.identityKeyId !== "string" || !SAFE_KEY_ID.test(value.identityKeyId)) {
    throw new TypeError("coreContract.identityKeyId must be a safe key identifier");
  }
  return Object.freeze({
    tenantId: value.tenantId,
    applicationId: value.applicationId,
    policyId: value.policyId,
    scope,
    identityType: value.identityType,
    identityKeyId: value.identityKeyId
  });
}

function safelyCall(callback, value) {
  if (typeof callback !== "function" || value === null || value === undefined) return;
  try {
    const result = callback(value);
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch {
    // Contract telemetry must never interrupt rate-limit enforcement.
  }
}

function createCoreRateLimitEvent(check, decision, occurredAtMs) {
  if (!decision.exceeded && !decision.unavailable) return null;
  return validateSecurityEventV1({
    schema: "jb.security.event/v1",
    eventId: randomUUID(),
    occurredAtMs,
    tenantId: check.tenantId,
    applicationId: check.applicationId,
    producer: "security-guard-node",
    category: "rate_limit",
    ruleId: "JBG-RATE-LIMIT-001",
    severity: decision.unavailable && decision.enforced ? "critical" : "high",
    action: decision.unavailable
      ? (decision.enforced ? "rejected" : "observed")
      : (decision.enforced ? "blocked" : "observed"),
    outcome: decision.unavailable
      ? "unavailable"
      : (decision.enforced ? "denied" : "observed"),
    subjectKey: check.identity.key,
    subjectKeyId: check.identity.keyId,
    scope: check.scope,
    correlationId: check.requestId
  });
}


function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(name + " must be a positive integer no greater than " + maximum);
  }
  return value;
}


async function withTimeout(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Distributed store operation timed out")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  const allowed = new Set(["store", "secret", "keyGenerator", "namespace", "windowMs", "maxRequests", "storeTimeoutMs", "clock", "failClosed", "onEvent", "coreContract", "onCoreDecision", "onCoreEvent"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("Unknown distributed rate-limit option: " + key);
  }
  const store = options.store;
  if (!isRecord(store) || typeof store.consumeLimit !== "function") {
    throw new TypeError("store.consumeLimit must implement an atomic shared fixed-window counter");
  }
  const secret = options.secret;
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
  const storeTimeoutMs = positiveInteger(options.storeTimeoutMs ?? 3000, "storeTimeoutMs", 60_000);
  const clock = options.clock ?? Date.now;
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const failClosed = options.failClosed ?? true;
  if (typeof failClosed !== "boolean") throw new TypeError("failClosed must be a boolean");
  const coreContract = normalizeCoreContract(options.coreContract);
  const onCoreDecision = options.onCoreDecision;
  const onCoreEvent = options.onCoreEvent;
  if (onCoreDecision !== undefined && typeof onCoreDecision !== "function") {
    throw new TypeError("onCoreDecision must be a function");
  }
  if (onCoreEvent !== undefined && typeof onCoreEvent !== "function") {
    throw new TypeError("onCoreEvent must be a function");
  }
  if (coreContract && windowMs > 60_000) {
    throw new TypeError("windowMs must be 60000 or less when Core v1 contract output is enabled");
  }

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

  function resolveIdentity(request) {
    let identity;
    try {
      const value = keyGenerator(request);
      identity = value === null || value === undefined ? "unknown" : String(value).trim();
    } catch { identity = "unknown"; }
    if (!identity) identity = "unknown";
    if (identity.length > 512) identity = identity.slice(0, 512);
    return identity;
  }

  function makeKey(identity) {
    const digest = createHmac("sha256", secret).update(namespace).update("\0").update(identity).digest("hex");
    return namespace + ":" + digest;
  }

  function makeCoreCheck(identity) {
    if (!coreContract) return null;
    const key = createHmac("sha256", secret)
      .update("jb.security.rate-limit.identity/v1").update("\0")
      .update(coreContract.tenantId).update("\0")
      .update(coreContract.applicationId).update("\0")
      .update(coreContract.identityType).update("\0")
      .update(identity)
      .digest("hex");
    return validateRateLimitCheckV1({
      schema: "jb.security.rate-limit.check/v1",
      requestId: randomUUID(),
      tenantId: coreContract.tenantId,
      applicationId: coreContract.applicationId,
      policyId: coreContract.policyId,
      scope: coreContract.scope,
      identity: {
        type: coreContract.identityType,
        key,
        keyId: coreContract.identityKeyId
      }
    });
  }

  function publishCore(check, decisionInput, now, emitEvent = false) {
    if (!check) return;
    const decision = toRateLimitDecisionV1(check, decisionInput);
    safelyCall(onCoreDecision, Object.freeze({ check, decision }));
    if (emitEvent) {
      const event = createCoreRateLimitEvent(check, decision, now);
      safelyCall(onCoreEvent, event);
    }
  }

  async function middleware(request, response, next) {
    if (!request || typeof request !== "object" || !response ||
        typeof response.setHeader !== "function" || typeof response.end !== "function" ||
        typeof next !== "function") {
      throw new TypeError("Distributed rate-limit middleware requires (request, response, next)");
    }
    stats.requests += 1;
    let now;
    let result;
    let coreCheck = null;
    let identity = null;
    try {
      now = readNow();
      identity = resolveIdentity(request);
      coreCheck = makeCoreCheck(identity);
      result = await withTimeout(
        () => store.consumeLimit({ key: makeKey(identity), now, windowMs, maxRequests }),
        storeTimeoutMs
      );
      if (!isRecord(result) || typeof result.allowed !== "boolean" ||
          (result.count !== undefined && (!Number.isSafeInteger(result.count) || result.count < 1)) ||
          (result.retryAfterMs !== undefined && (!Number.isFinite(result.retryAfterMs) || result.retryAfterMs < 0))) {
        throw new TypeError("store.consumeLimit returned an invalid result");
      }
    } catch {
      stats.storeErrors += 1;
      const eventTime = Number.isSafeInteger(now) ? now : Date.now();
      notify(onEvent, {
        id: randomUUID(), timestamp: new Date(eventTime).toISOString(),
        component: "jb-security-guard", action: "distributed-rate-store-unavailable",
        severity: "critical", ruleIds: [RULE_ID]
      });
      if (coreCheck) {
        publishCore(coreCheck, {
          allowed: !failClosed,
          exceeded: false,
          enforced: failClosed,
          unavailable: true,
          status: failClosed ? 503 : null,
          retryAfterSeconds: failClosed ? 5 : null
        }, eventTime, true);
      }
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
      publishCore(coreCheck, {
        allowed: true,
        exceeded: false,
        enforced: false,
        unavailable: false,
        status: null,
        retryAfterSeconds: null
      }, now);
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
    publishCore(coreCheck, {
      allowed: false,
      exceeded: true,
      enforced: true,
      unavailable: false,
      status: 429,
      retryAfterSeconds
    }, now, result.count === maxRequests + 1);
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
