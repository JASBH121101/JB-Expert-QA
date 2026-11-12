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

async function digestKey(namespace, policy, scope, identity) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle || typeof cryptoApi.subtle.digest !== "function") {
    throw new Error("Web Crypto is unavailable");
  }

  // The input is domain-separated so the same identity cannot share counters
  // across policies, scopes, or applications.
  const input = new TextEncoder().encode(
    [namespace, policy, scope, identity].join("\0")
  );
  const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", input));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  // A fixed 64-character opaque key; no account identifier is sent to Cloudflare.
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
    "binding", "policies", "namespace", "mode", "periodSeconds", "failureMode", "onEvent"
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("Unknown Cloudflare rate-limit option: " + key);
  }

  const namespace = options.namespace ?? "jb-security-guard";
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

  async function check(input = {}) {
    if (!isRecord(input)) throw new TypeError("check input must be an object");
    const allowedInput = new Set(["identity", "scope", "policy"]);
    for (const key of Object.keys(input)) {
      if (!allowedInput.has(key)) throw new TypeError("Unknown rate-limit check input: " + key);
    }

    const policyName = input.policy ?? (policies.has("default")
      ? "default"
      : policies.size === 1 ? policies.keys().next().value : null);
    if (typeof policyName !== "string" || !policies.has(policyName)) {
      throw new TypeError("A configured rate-limit policy must be selected");
    }

    const identity = input.identity;
    if (typeof identity !== "string" || !identity.trim() || identity.length > 512) {
      throw new TypeError("identity must be a non-empty trusted identifier no longer than 512 characters");
    }

    const scope = input.scope ?? "request";
    if (typeof scope !== "string" || !SAFE_IDENTIFIER.test(scope)) {
      throw new TypeError("scope must contain 1-96 safe identifier characters");
    }

    const policy = policies.get(policyName);
    let result;
    try {
      const key = await digestKey(namespace, policyName, scope, identity.trim());
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
