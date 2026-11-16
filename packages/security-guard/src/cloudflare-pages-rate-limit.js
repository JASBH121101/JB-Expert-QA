import {
  normalizeRateLimitCheckInput,
  normalizeRateLimitServiceDecision
} from "./rate-limit-contract.js";

const DEFAULT_SERVICE_PATH = "/__jb/security-guard/rate-limit";

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

  const allowed = new Set(["serviceBinding", "path", "failureMode", "onEvent"]);
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

  const onEvent = options.onEvent;
  if (onEvent !== undefined && typeof onEvent !== "function") {
    throw new TypeError("onEvent must be a function");
  }

  async function check(input = {}) {
    const normalizedInput = normalizeRateLimitCheckInput(input);
    const request = new Request("https://jb-security-guard.internal" + path, {
      method: "POST",
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json"
      },
      body: JSON.stringify(normalizedInput)
    });

    let payload;
    try {
      const response = await serviceBinding.fetch(request);
      if (!response || response.ok !== true || typeof response.json !== "function") {
        throw new Error("Rate-limit service request failed");
      }
      payload = normalizeServiceDecision(await response.json());
    } catch {
      return unavailableDecision({
        failureMode,
        onEvent,
        policy: normalizedInput.policy,
        scope: normalizedInput.scope
      });
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
