const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SAFE_IDENTIFIER = /^[a-zA-Z0-9:_-]{1,96}$/;

function notify(onEvent, event) {
  try {
    const result = onEvent(Object.freeze({ ...event }));
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch {
    // Telemetry must never interrupt request handling.
  }
}

async function digestKey(namespace, scope, identity) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle || typeof cryptoApi.subtle.digest !== "function") {
    throw new Error("Web Crypto is unavailable");
  }
  const input = new TextEncoder().encode(namespace + "\0" + scope + "\0" + identity);
  const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", input));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return namespace + ":" + hex;
}

/**
 * Worker-native adapter for the Cloudflare Rate Limiting binding.
 * It deliberately does not import the Node/Express Guard entry point.
 * Counters are approximate and local to each Cloudflare location.
 */
export function createCloudflareWorkerRateLimit(options = {}) {
  if (!isRecord(options)) throw new TypeError("Cloudflare rate-limit options must be an object");
  const allowed = new Set(["binding", "namespace", "mode", "periodSeconds", "onEvent"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("Unknown Cloudflare rate-limit option: " + key);
  }

  const binding = options.binding;
  if (!isRecord(binding) || typeof binding.limit !== "function") {
    throw new TypeError("binding.limit must be a Cloudflare Rate Limiting binding");
  }

  const namespace = options.namespace ?? "jb-security-guard";
  if (typeof namespace !== "string" || !SAFE_IDENTIFIER.test(namespace)) {
    throw new TypeError("namespace must contain 1-96 safe identifier characters");
  }

  const mode = options.mode ?? "monitor";
  if (!["monitor", "enforce"].includes(mode)) {
    throw new TypeError("mode must be monitor or enforce");
  }

  const periodSeconds = options.periodSeconds ?? 60;
  if (![10, 60].includes(periodSeconds)) {
    throw new TypeError("periodSeconds must be 10 or 60");
  }

  const onEvent = options.onEvent ?? (() => {});
  if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");

  async function check(input = {}) {
    if (!isRecord(input)) throw new TypeError("check input must be an object");
    const identity = input.identity;
    const scope = input.scope ?? "account";

    if (typeof identity !== "string" || !identity.trim() || identity.length > 512) {
      throw new TypeError("identity must be a non-empty string no longer than 512 characters");
    }
    if (typeof scope !== "string" || !SAFE_IDENTIFIER.test(scope)) {
      throw new TypeError("scope must contain 1-96 safe identifier characters");
    }

    let result;
    try {
      const key = await digestKey(namespace, scope, identity.trim());
      result = await binding.limit({ key });
      if (!isRecord(result) || typeof result.success !== "boolean") {
        throw new TypeError("Cloudflare Rate Limiting binding returned an invalid result");
      }
    } catch {
      notify(onEvent, {
        component: "jb-security-guard",
        action: "cloudflare-rate-limit-unavailable",
        severity: "high",
        scope
      });
      // Availability takes priority when the platform counter is unavailable.
      return Object.freeze({
        allowed: true,
        exceeded: false,
        enforced: false,
        unavailable: true,
        scope,
        response: null
      });
    }

    if (result.success) {
      return Object.freeze({
        allowed: true,
        exceeded: false,
        enforced: false,
        unavailable: false,
        scope,
        response: null
      });
    }

    notify(onEvent, {
      component: "jb-security-guard",
      action: "cloudflare-rate-limit-exceeded",
      severity: "high",
      scope,
      mode
    });

    const enforced = mode === "enforce";
    const response = enforced
      ? new Response(JSON.stringify({
          error: "rate_limit_exceeded",
          message: "Too many requests. Try again later."
        }), {
          status: 429,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "retry-after": String(periodSeconds),
            "x-content-type-options": "nosniff"
          }
        })
      : null;

    return Object.freeze({
      allowed: !enforced,
      exceeded: true,
      enforced,
      unavailable: false,
      scope,
      response
    });
  }

  return Object.freeze({ check });
}
