const SAFE_IDENTIFIER = /^[a-zA-Z0-9:_-]{1,96}$/;
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

function normalizeCheckInput(input = {}) {
  if (!isRecord(input)) throw new TypeError("check input must be an object");
  const allowed = new Set(["identity", "scope", "policy"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError("Unknown rate-limit check input: " + key);
  }

  const identity = input.identity;
  if (typeof identity !== "string" || !identity.trim() || identity.length > 512) {
    throw new TypeError("identity must be a non-empty trusted identifier no longer than 512 characters");
  }

  const scope = input.scope ?? "request";
  if (typeof scope !== "string" || !SAFE_IDENTIFIER.test(scope)) {
    throw new TypeError("scope must contain 1-96 safe identifier characters");
  }

  const normalized = { identity: identity.trim(), scope };
  if (input.policy !== undefined) {
    if (typeof input.policy !== "string" || !SAFE_IDENTIFIER.test(input.policy)) {
      throw new TypeError("policy must contain 1-96 safe identifier characters");
    }
    normalized.policy = input.policy;
  }
  return normalized;
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
  if (!isRecord(value) ||
      typeof value.allowed !== "boolean" ||
      typeof value.exceeded !== "boolean" ||
      typeof value.enforced !== "boolean" ||
      typeof value.unavailable !== "boolean" ||
      !(value.status === null || value.status === 429 || value.status === 503) ||
      !(value.retryAfterSeconds === null ||
        (Number.isSafeInteger(value.retryAfterSeconds) && value.retryAfterSeconds >= 1 && value.retryAfterSeconds <= 60)) ||
      !(value.policy === null || (typeof value.policy === "string" && SAFE_IDENTIFIER.test(value.policy))) ||
      !(typeof value.scope === "string" && SAFE_IDENTIFIER.test(value.scope))) {
    throw new TypeError("Rate-limit service returned an invalid decision");
  }

  if (value.allowed && value.status !== null) {
    throw new TypeError("Allowed service decision must not contain a response status");
  }
  if (!value.allowed && ![429, 503].includes(value.status)) {
    throw new TypeError("Blocked service decision requires an HTTP 429 or 503 status");
  }

  let response = null;
  if (value.status === 429) {
    response = createFailureResponse(429, value.retryAfterSeconds ?? 60, "rate_limit_exceeded");
  } else if (value.status === 503) {
    response = createFailureResponse(503, value.retryAfterSeconds ?? 5, "security_rate_limit_unavailable");
  }

  return Object.freeze({
    allowed: value.allowed,
    exceeded: value.exceeded,
    enforced: value.enforced,
    unavailable: value.unavailable,
    policy: value.policy,
    scope: value.scope,
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
    const normalizedInput = normalizeCheckInput(input);
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
