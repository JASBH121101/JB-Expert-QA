import {
  normalizeRateLimitCheckInput,
  normalizeRateLimitServiceDecision
} from "./rate-limit-contract.js";

import {
  validateRateLimitCheckV1,
  validateRateLimitDecisionV1,
  validateSecurityEventV1,
  toRateLimitDecisionV1
} from "./core-contract-v1.js";

const DEFAULT_SERVICE_PATH = "/__jb/security-guard/rate-limit";

const SAFE_IDENTIFIER = /^[A-Za-z0-9:_-]{1,96}$/;
const SAFE_KEY_ID = /^[A-Za-z0-9:_-]{1,64}$/;
const CORE_IDENTITY_TYPES = new Set(["ip", "account", "account_ip", "session", "anonymous"]);

function normalizeCoreIdentitySecret(value) {
  let bytes;
  if (typeof value === "string") bytes = new TextEncoder().encode(value);
  else if (value instanceof Uint8Array) bytes = new Uint8Array(value);
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
  else throw new TypeError("core.identitySecret must be a string, Uint8Array, or ArrayBuffer");
  if (bytes.byteLength < 32) throw new TypeError("core.identitySecret must contain at least 32 bytes");
  return bytes;
}

function normalizeCoreOptions(value) {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new TypeError("core must be an object");
  const allowed = new Set([
    "tenantId", "applicationId", "identityType", "identityKeyId",
    "identitySecret", "requestIdGenerator"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError("Unknown Pages Core option: " + key);
  }
  for (const key of ["tenantId", "applicationId"]) {
    if (typeof value[key] !== "string" || !SAFE_IDENTIFIER.test(value[key])) {
      throw new TypeError("core." + key + " must be a safe identifier");
    }
  }
  if (!CORE_IDENTITY_TYPES.has(value.identityType)) {
    throw new TypeError("core.identityType must be a supported identity type");
  }
  if (typeof value.identityKeyId !== "string" || !SAFE_KEY_ID.test(value.identityKeyId)) {
    throw new TypeError("core.identityKeyId must be a safe key identifier");
  }
  const requestIdGenerator = value.requestIdGenerator ?? (() => globalThis.crypto.randomUUID());
  if (typeof requestIdGenerator !== "function") {
    throw new TypeError("core.requestIdGenerator must be a function");
  }
  return Object.freeze({
    tenantId: value.tenantId,
    applicationId: value.applicationId,
    identityType: value.identityType,
    identityKeyId: value.identityKeyId,
    identitySecret: normalizeCoreIdentitySecret(value.identitySecret),
    requestIdGenerator
  });
}

async function createCoreRateLimitCheck(core, normalizedInput) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("Web Crypto is unavailable");
  const key = await cryptoApi.subtle.importKey(
    "raw",
    core.identitySecret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const material = new TextEncoder().encode([
    "jb.security.rate-limit.identity/v1",
    core.tenantId,
    core.applicationId,
    core.identityType,
    normalizedInput.identity
  ].join("\\0"));
  const digest = new Uint8Array(await cryptoApi.subtle.sign("HMAC", key, material));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");

  return validateRateLimitCheckV1({
    schema: "jb.security.rate-limit.check/v1",
    requestId: core.requestIdGenerator(),
    tenantId: core.tenantId,
    applicationId: core.applicationId,
    policyId: normalizedInput.policy ?? "default",
    scope: normalizedInput.scope,
    identity: {
      type: core.identityType,
      key: hex,
      keyId: core.identityKeyId
    }
  });
}

function emitCoreEvent(callback, event) {
  if (typeof callback !== "function" || !event) return;
  try {
    const result = callback(event);
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch {
    // Telemetry must never interrupt request protection.
  }
}

function createPagesCoreEvent(check, decision) {
  if (!decision.exceeded && !decision.unavailable) return null;
  return validateSecurityEventV1({
    schema: "jb.security.event/v1",
    eventId: globalThis.crypto.randomUUID(),
    occurredAtMs: Date.now(),
    tenantId: check.tenantId,
    applicationId: check.applicationId,
    producer: "security-guard-pages",
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

function attachPagesCoreUnavailable(result, check, failureMode, onCoreEvent) {
  if (!check) return result;
  const closed = failureMode === "closed";
  const coreDecision = toRateLimitDecisionV1(check, {
    allowed: !closed,
    exceeded: false,
    enforced: closed,
    unavailable: true,
    status: closed ? 503 : null,
    retryAfterSeconds: closed ? 5 : null
  });
  const coreEvent = createPagesCoreEvent(check, coreDecision);
  emitCoreEvent(onCoreEvent, coreEvent);
  return Object.freeze({ ...result, core: Object.freeze({ check, decision: coreDecision, event: coreEvent }) });
}


function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function notify(callback, event) {
  if (typeof callback !== "function") return;
  try {
    const result = callback(Object.freeze({ ...event }));
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch {
    // Telemetry must never interrupt request protection.
  }
}

function createFailureResponse(status, retryAfterSeconds, error) {
  return new Response(JSON.stringify({
    error,
    message: status === 429
      ? "Too many requests. Try again later."
      : "Request temporarily unavailable due to a security control."
  }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(retryAfterSeconds),
      "x-content-type-options": "nosniff"
    }
  });
}

function unavailableDecision({ failureMode, onEvent, policy, scope }) {
  const closed = failureMode === "closed";
  const event = {
    component: "jb-security-guard",
    action: "cloudflare-pages-rate-limit-unavailable",
    severity: closed ? "critical" : "high",
    policy: policy ?? null,
    scope: scope ?? "request",
    failureMode
  };
  notify(onEvent, event);
  return Object.freeze({
    allowed: !closed,
    exceeded: false,
    enforced: closed,
    unavailable: true,
    policy: policy ?? null,
    scope: scope ?? "request",
    response: closed
      ? createFailureResponse(503, 5, "security_rate_limit_unavailable")
      : null
  });
}

function normalizeServiceDecision(value) {
  const normalized = normalizeRateLimitServiceDecision(value);
  let response = null;
  if (normalized.status === 429) {
    response = createFailureResponse(
      429, normalized.retryAfterSeconds ?? 60, "rate_limit_exceeded"
    );
  } else if (normalized.status === 503) {
    response = createFailureResponse(
      503, normalized.retryAfterSeconds ?? 5, "security_rate_limit_unavailable"
    );
  }
  return Object.freeze({
    allowed: normalized.allowed,
    exceeded: normalized.exceeded,
    enforced: normalized.enforced,
    unavailable: normalized.unavailable,
    policy: normalized.policy,
    scope: normalized.scope,
    response
  });
}

/**
 * Pages Functions adapter that delegates request counting to a private Worker.
 *
 * Pages Functions do not expose the Workers Rate Limiting binding directly.
 * Bind a private Worker to Pages with a Service Binding. The Worker should use
 * createCloudflareWorkerRateLimitService() and a Worker Rate Limiting binding.
 *
 * The identity must be resolved by trusted Pages server-side code. Do not pass
 * a raw browser-supplied account ID, username, cookie, password, or token.
 */
export function createCloudflarePagesRateLimit(options = {}) {
  if (!isRecord(options)) throw new TypeError("Cloudflare Pages rate-limit options must be an object");

  const allowed = new Set(["serviceBinding", "path", "failureMode", "onEvent", "core", "onCoreEvent"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("Unknown Cloudflare Pages rate-limit option: " + key);
  }

  const serviceBinding = options.serviceBinding;
  if (!serviceBinding || typeof serviceBinding.fetch !== "function") {
    throw new TypeError("serviceBinding must be a Cloudflare Pages Service Binding");
  }

  const path = options.path ?? DEFAULT_SERVICE_PATH;
  if (typeof path !== "string" || !/^\/[a-zA-Z0-9/_-]{1,128}$/.test(path) || path.includes("..")) {
    throw new TypeError("path must be a safe absolute service route");
  }

  const failureMode = options.failureMode ?? "closed";
  if (!["open", "closed"].includes(failureMode)) {
    throw new TypeError("failureMode must be open or closed");
  }

  const core = normalizeCoreOptions(options.core);
  const onCoreEvent = options.onCoreEvent;
  if (onCoreEvent !== undefined && typeof onCoreEvent !== "function") {
    throw new TypeError("onCoreEvent must be a function");
  }

  const onEvent = options.onEvent;
  if (onEvent !== undefined && typeof onEvent !== "function") {
    throw new TypeError("onEvent must be a function");
  }

  async function check(input = {}) {
    const normalizedInput = normalizeRateLimitCheckInput(input);
    let coreCheck = null;
    if (core) coreCheck = await createCoreRateLimitCheck(core, normalizedInput);
    const serviceInput = coreCheck ?? normalizedInput;
    const request = new Request("https://jb-security-guard.internal" + path, {
      method: "POST",
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json"
      },
      body: JSON.stringify(serviceInput)
    });

    let payload;
    try {
      const response = await serviceBinding.fetch(request);
      if (!response || response.ok !== true || typeof response.json !== "function") {
        throw new Error("Rate-limit service request failed");
      }
      const rawPayload = await response.json();
      const coreDecisionValue = rawPayload?.coreDecision;
      const coreEventValue = rawPayload?.coreEvent;
      const legacyPayload = { ...rawPayload };
      delete legacyPayload.coreDecision;
      delete legacyPayload.coreEvent;
      payload = normalizeServiceDecision(legacyPayload);

      if (coreCheck) {
        const coreDecision = validateRateLimitDecisionV1(coreDecisionValue);
        if (coreDecision.requestId !== coreCheck.requestId ||
            coreDecision.tenantId !== coreCheck.tenantId ||
            coreDecision.applicationId !== coreCheck.applicationId ||
            coreDecision.policyId !== coreCheck.policyId ||
            coreDecision.scope !== coreCheck.scope) {
          throw new TypeError("Worker Core decision context does not match the Pages request");
        }
        const coreEvent = coreEventValue === null
          ? null
          : validateSecurityEventV1(coreEventValue);
        if (coreEvent && (
          coreEvent.tenantId !== coreCheck.tenantId ||
          coreEvent.applicationId !== coreCheck.applicationId ||
          coreEvent.correlationId !== coreCheck.requestId ||
          coreEvent.subjectKey !== coreCheck.identity.key ||
          coreEvent.subjectKeyId !== coreCheck.identity.keyId
        )) {
          throw new TypeError("Worker Core event context does not match the Pages request");
        }
        payload = Object.freeze({
          ...payload,
          core: Object.freeze({ check: coreCheck, decision: coreDecision, event: coreEvent })
        });
        emitCoreEvent(onCoreEvent, coreEvent);
      } else if (coreDecisionValue !== undefined || coreEventValue !== undefined) {
        throw new TypeError("Unexpected Core contract response when Pages Core mode is disabled");
      }
    } catch {
      const unavailable = unavailableDecision({
        failureMode,
        onEvent,
        policy: normalizedInput.policy,
        scope: normalizedInput.scope
      });
      return attachPagesCoreUnavailable(unavailable, coreCheck, failureMode, onCoreEvent);
    }

    if (payload.unavailable) {
      notify(onEvent, {
        component: "jb-security-guard",
        action: "cloudflare-pages-rate-limit-unavailable",
        severity: payload.allowed ? "high" : "critical",
        policy: payload.policy,
        scope: payload.scope,
        failureMode
      });
    } else if (payload.exceeded) {
      notify(onEvent, {
        component: "jb-security-guard",
        action: "cloudflare-pages-rate-limit-exceeded",
        severity: "high",
        policy: payload.policy,
        scope: payload.scope,
        enforced: payload.enforced
      });
    }
    return payload;
  }

  return Object.freeze({ check });
}
