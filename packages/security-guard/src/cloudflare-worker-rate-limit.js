import {
  normalizeRateLimitCheckInput,
  createRateLimitServicePayload
} from "./rate-limit-contract.js";

import {
  validateRateLimitCheckV1,
  toRateLimitDecisionV1,
  validateSecurityEventV1
} from "./core-contract-v1.js";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SAFE_IDENTIFIER = /^[a-zA-Z0-9:_-]{1,96}$/;

function notify(callback, event) {
  if (typeof callback !== "function") return;
  try {
    const result = callback(Object.freeze({ ...event }));
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch {
    // Telemetry must never interrupt request protection.
  }
}

function normalizeIdentitySecret(value) {
  if (value === undefined || value === null) return null;
  let bytes;
  if (typeof value === "string") {
    bytes = new TextEncoder().encode(value);
  } else if (value instanceof Uint8Array) {
    bytes = new Uint8Array(value);
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value.slice(0));
  } else {
    throw new TypeError("identitySecret must be a string, Uint8Array, or ArrayBuffer");
  }
  if (bytes.byteLength < 32) {
    throw new TypeError("identitySecret must contain at least 32 bytes");
  }
  return bytes;
}

async function digestKey(namespace, policy, scope, identity, identitySecret) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("Web Crypto is unavailable");

  // Domain separation prevents counter reuse across applications, policies and scopes.
  const input = new TextEncoder().encode(
    [namespace, policy, scope, identity].join("\0")
  );
  let digest;
  if (identitySecret) {
    const key = await cryptoApi.subtle.importKey(
      "raw",
      identitySecret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    digest = new Uint8Array(await cryptoApi.subtle.sign("HMAC", key, input));
  } else {
    // Legacy-compatible digest is permitted only in monitor mode.
    digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", input));
  }

  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function normalizePolicy(name, input, defaults) {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new TypeError("Policy names must contain 1-96 safe identifier characters");
  }
  if (!isRecord(input)) throw new TypeError("Each policy must be an object");

  const allowed = new Set(["binding", "mode", "periodSeconds", "failureMode", "onEvent"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError("Unknown rate-limit policy option: " + key);
  }

  const binding = input.binding;
  if (!isRecord(binding) || typeof binding.limit !== "function") {
    throw new TypeError("Policy " + name + " requires a Cloudflare Rate Limiting binding");
  }

  const mode = input.mode ?? defaults.mode ?? "monitor";
  if (!["monitor", "enforce"].includes(mode)) {
    throw new TypeError("Policy " + name + " mode must be monitor or enforce");
  }

  const periodSeconds = input.periodSeconds ?? defaults.periodSeconds ?? 60;
  if (![10, 60].includes(periodSeconds)) {
    throw new TypeError("Policy " + name + " periodSeconds must be 10 or 60");
  }

  const failureMode = input.failureMode ?? defaults.failureMode ??
    (mode === "enforce" ? "closed" : "open");
  if (!["open", "closed"].includes(failureMode)) {
    throw new TypeError("Policy " + name + " failureMode must be open or closed");
  }

  const onEvent = input.onEvent ?? defaults.onEvent;
  if (onEvent !== undefined && typeof onEvent !== "function") {
    throw new TypeError("Policy " + name + " onEvent must be a function");
  }

  return Object.freeze({ binding, mode, periodSeconds, failureMode, onEvent });
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

/**
 * Worker-native, policy-aware adapter for Cloudflare Rate Limiting bindings.
 *
 * Use one Cloudflare binding per independently configured threshold/period.
 * Each check must receive an identity resolved by trusted server-side code.
 * Cloudflare's counters are approximate and local to each Cloudflare location.
 */
export function createCloudflareWorkerRateLimit(options = {}) {
  if (!isRecord(options)) throw new TypeError("Cloudflare rate-limit options must be an object");

  const allowed = new Set([
    "binding", "policies", "namespace", "mode", "periodSeconds", "failureMode", "onEvent", "identitySecret"
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("Unknown Cloudflare rate-limit option: " + key);
  }

  const namespace = options.namespace ?? "jb-security-guard";
  const identitySecret = normalizeIdentitySecret(options.identitySecret);
  if (typeof namespace !== "string" || !SAFE_IDENTIFIER.test(namespace)) {
    throw new TypeError("namespace must contain 1-96 safe identifier characters");
  }

  const defaults = {
    mode: options.mode,
    periodSeconds: options.periodSeconds,
    failureMode: options.failureMode,
    onEvent: options.onEvent
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (value === undefined) continue;
    if (key === "mode" && !["monitor", "enforce"].includes(value)) {
      throw new TypeError("mode must be monitor or enforce");
    }
    if (key === "periodSeconds" && ![10, 60].includes(value)) {
      throw new TypeError("periodSeconds must be 10 or 60");
    }
    if (key === "failureMode" && !["open", "closed"].includes(value)) {
      throw new TypeError("failureMode must be open or closed");
    }
    if (key === "onEvent" && typeof value !== "function") {
      throw new TypeError("onEvent must be a function");
    }
  }

  const hasSingleBinding = options.binding !== undefined;
  const hasPolicies = options.policies !== undefined;
  if (hasSingleBinding === hasPolicies) {
    throw new TypeError("Provide exactly one of binding or policies");
  }

  const policies = new Map();
  if (hasSingleBinding) {
    policies.set("default", normalizePolicy("default", {
      binding: options.binding,
      mode: options.mode,
      periodSeconds: options.periodSeconds,
      failureMode: options.failureMode,
      onEvent: options.onEvent
    }, {}));
  } else {
    if (!isRecord(options.policies)) throw new TypeError("policies must be an object");
    const entries = Object.entries(options.policies);
    if (entries.length === 0 || entries.length > 32) {
      throw new TypeError("policies must contain between 1 and 32 entries");
    }
    for (const [name, config] of entries) {
      policies.set(name, normalizePolicy(name, config, defaults));
    }
  }

  if (!identitySecret && [...policies.values()].some((policy) => policy.mode === "enforce")) {
    throw new TypeError("identitySecret is required for every enforce-mode policy");
  }

  async function check(input = {}) {
    const normalizedInput = normalizeRateLimitCheckInput(input);
    const policyName = normalizedInput.policy ?? (policies.has("default")
      ? "default"
      : policies.size === 1 ? policies.keys().next().value : null);
    if (typeof policyName !== "string" || !policies.has(policyName)) {
      throw new TypeError("A configured rate-limit policy must be selected");
    }

    const identity = normalizedInput.identity;
    const scope = normalizedInput.scope;
    const policy = policies.get(policyName);
    let result;
    try {
      const key = await digestKey(namespace, policyName, scope, identity, identitySecret);
      result = await policy.binding.limit({ key });
      if (!isRecord(result) || typeof result.success !== "boolean") {
        throw new TypeError("Cloudflare Rate Limiting binding returned an invalid result");
      }
    } catch {
      const event = {
        component: "jb-security-guard",
        action: "cloudflare-rate-limit-unavailable",
        severity: policy.failureMode === "closed" ? "critical" : "high",
        policy: policyName,
        scope,
        failureMode: policy.failureMode
      };
      notify(options.onEvent, event);
      if (policy.onEvent !== options.onEvent) notify(policy.onEvent, event);

      const closed = policy.failureMode === "closed";
      return Object.freeze({
        allowed: !closed,
        exceeded: false,
        enforced: closed,
        unavailable: true,
        policy: policyName,
        scope,
        response: closed ? createFailureResponse(503, 5, "security_rate_limit_unavailable") : null
      });
    }

    if (result.success) {
      return Object.freeze({
        allowed: true,
        exceeded: false,
        enforced: false,
        unavailable: false,
        policy: policyName,
        scope,
        response: null
      });
    }

    const enforced = policy.mode === "enforce";
    const event = {
      component: "jb-security-guard",
      action: "cloudflare-rate-limit-exceeded",
      severity: "high",
      policy: policyName,
      scope,
      mode: policy.mode
    };
    notify(options.onEvent, event);
    if (policy.onEvent !== options.onEvent) notify(policy.onEvent, event);

    return Object.freeze({
      allowed: !enforced,
      exceeded: true,
      enforced,
      unavailable: false,
      policy: policyName,
      scope,
      response: enforced
        ? createFailureResponse(429, policy.periodSeconds, "rate_limit_exceeded")
        : null
    });
  }

  return Object.freeze({
    check,
    getPolicies: () => Object.freeze([...policies.keys()])
  });
}


const DEFAULT_PAGES_SERVICE_PATH = "/__jb/security-guard/rate-limit";

function serviceJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff"
    }
  });
}

async function readBoundedJson(request, maxBytes) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, status: 413 };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400 };

  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413 };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock?.();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
}

/**
 * Exposes a bounded HTTP endpoint for a Pages Function Service Binding.
 *
 * The Worker should be deployed without a public workers.dev route or custom
 * route. Pages calls this endpoint through a Service Binding only.
 */
export function createCloudflareWorkerRateLimitService(options = {}) {
  if (!isRecord(options)) throw new TypeError("Rate-limit service options must be an object");
  const allowed = new Set(["limiter", "path", "maxBodyBytes", "onCoreEvent"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("Unknown rate-limit service option: " + key);
  }

  const onCoreEvent = options.onCoreEvent;
  if (onCoreEvent !== undefined && typeof onCoreEvent !== "function") {
    throw new TypeError("onCoreEvent must be a function");
  }

  const limiter = options.limiter;
  if (!limiter || typeof limiter.check !== "function") {
    throw new TypeError("limiter.check must be a function");
  }

  const path = options.path ?? DEFAULT_PAGES_SERVICE_PATH;
  if (typeof path !== "string" || !/^\/[a-zA-Z0-9/_-]{1,128}$/.test(path) || path.includes("..")) {
    throw new TypeError("path must be a safe absolute service route");
  }

  const maxBodyBytes = options.maxBodyBytes ?? 4096;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 256 || maxBodyBytes > 16384) {
    throw new TypeError("maxBodyBytes must be between 256 and 16384");
  }

  async function fetch(request) {
    if (!request || typeof request.method !== "string" || typeof request.url !== "string") {
      return serviceJsonResponse({ error: "invalid_request" }, 400);
    }

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return serviceJsonResponse({ error: "invalid_request" }, 400);
    }

    if (url.pathname !== path) return serviceJsonResponse({ error: "not_found" }, 404);
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: {
          "allow": "POST",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff"
        }
      });
    }

    if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
      return serviceJsonResponse({ error: "content_type_not_supported" }, 415);
    }

    const parsed = await readBoundedJson(request, maxBodyBytes);
    if (!parsed.ok) return serviceJsonResponse({
      error: parsed.status === 413 ? "request_too_large" : "invalid_json"
    }, parsed.status);

    let decision;
    let coreCheck = null;
    try {
      if (isRecord(parsed.value) &&
          parsed.value.schema === "jb.security.rate-limit.check/v1") {
        coreCheck = validateRateLimitCheckV1(parsed.value);
        decision = await limiter.check({
          identity: coreCheck.identity.key,
          scope: coreCheck.scope,
          policy: coreCheck.policyId
        });
      } else {
        decision = await limiter.check(parsed.value);
      }
    } catch {
      return serviceJsonResponse({ error: "invalid_rate_limit_request" }, 400);
    }

    try {
      const payload = createRateLimitServicePayload(decision);
      if (!coreCheck) return serviceJsonResponse(payload);

      const coreDecision = toRateLimitDecisionV1(coreCheck, {
        allowed: decision.allowed,
        exceeded: decision.exceeded,
        enforced: decision.enforced,
        unavailable: decision.unavailable,
        status: payload.status,
        retryAfterSeconds: payload.retryAfterSeconds
      });

      let coreEvent = null;
      if (coreDecision.exceeded || coreDecision.unavailable) {
        coreEvent = validateSecurityEventV1({
          schema: "jb.security.event/v1",
          eventId: globalThis.crypto.randomUUID(),
          occurredAtMs: Date.now(),
          tenantId: coreCheck.tenantId,
          applicationId: coreCheck.applicationId,
          producer: "security-guard-worker",
          category: "rate_limit",
          ruleId: "JBG-RATE-LIMIT-001",
          severity: coreDecision.unavailable && coreDecision.enforced ? "critical" : "high",
          action: coreDecision.unavailable
            ? (coreDecision.enforced ? "rejected" : "observed")
            : (coreDecision.enforced ? "blocked" : "observed"),
          outcome: coreDecision.unavailable
            ? "unavailable"
            : (coreDecision.enforced ? "denied" : "observed"),
          subjectKey: coreCheck.identity.key,
          subjectKeyId: coreCheck.identity.keyId,
          scope: coreCheck.scope,
          correlationId: coreCheck.requestId
        });
        if (onCoreEvent) {
          try {
            const callbackResult = onCoreEvent(coreEvent);
            if (callbackResult && typeof callbackResult.then === "function") {
              Promise.resolve(callbackResult).catch(() => {});
            }
          } catch {
            // Telemetry must never interrupt the service decision.
          }
        }
      }

      return serviceJsonResponse({ ...payload, coreDecision, coreEvent });

    } catch {
      // A malformed internal adapter result is a service failure, not a client error.
      return serviceJsonResponse({ error: "rate_limit_service_unavailable" }, 503);
    }
  }

  return Object.freeze({ fetch });
}
