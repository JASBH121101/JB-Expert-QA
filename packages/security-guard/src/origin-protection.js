import { randomUUID } from "node:crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeNotify(onEvent, event) {
  try {
    const result = onEvent(Object.freeze({
      ...event,
      ruleIds: Object.freeze([...event.ruleIds])
    }));
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch {
    // Security telemetry must never interrupt request enforcement.
  }
}

function normalizeAllowedOrigin(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new TypeError("allowedOrigins entries must be exact origin strings");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("allowedOrigins entries must be valid absolute origins");
  }
  const localHttp = parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new TypeError("allowedOrigins must use HTTPS (HTTP is allowed only for localhost development)");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" ||
      parsed.search || parsed.hash || parsed.origin !== value.replace(/\/$/, "")) {
    throw new TypeError("allowedOrigins entries must contain only scheme, host, and optional port; wildcards and paths are not allowed");
  }
  return parsed.origin;
}

function readSingleHeader(request, name) {
  const rawValues = [];
  if (Array.isArray(request.rawHeaders)) {
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      if (String(request.rawHeaders[index]).toLowerCase() === name) {
        rawValues.push(String(request.rawHeaders[index + 1] ?? ""));
      }
    }
  }
  if (rawValues.length > 0) {
    return {
      present: true,
      malformed: rawValues.length !== 1,
      value: rawValues.length === 1 ? rawValues[0] : null
    };
  }

  const value = request.headers?.[name];
  if (value === undefined || value === null) {
    return { present: false, malformed: false, value: null };
  }
  if (Array.isArray(value)) {
    return {
      present: true,
      malformed: value.length !== 1,
      value: value.length === 1 ? String(value[0]) : null
    };
  }
  return typeof value === "string"
    ? { present: true, malformed: false, value }
    : { present: true, malformed: true, value: null };
}

function parseOrigin(value, allowRefererPath) {
  if (typeof value !== "string" || !value || value === "null" || value !== value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
    return null;
  }
  if (!allowRefererPath && (parsed.pathname !== "/" || parsed.search || parsed.hash)) return null;
  return parsed.origin;
}

function normalizeOptions(options) {
  if (!isRecord(options)) throw new TypeError("origin protection options must be an object");
  const allowed = new Set(["allowedOrigins", "allowRefererFallback", "allowMissingOrigin", "onEvent"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("Unknown origin protection option: " + key);
  }
  if (!Array.isArray(options.allowedOrigins) ||
      options.allowedOrigins.length < 1 ||
      options.allowedOrigins.length > 100) {
    throw new TypeError("allowedOrigins must contain between 1 and 100 exact origins");
  }
  const origins = options.allowedOrigins.map(normalizeAllowedOrigin);
  if (new Set(origins).size !== origins.length) {
    throw new TypeError("allowedOrigins must not contain duplicates");
  }
  const allowRefererFallback = options.allowRefererFallback ?? false;
  const allowMissingOrigin = options.allowMissingOrigin ?? false;
  if (typeof allowRefererFallback !== "boolean" || typeof allowMissingOrigin !== "boolean") {
    throw new TypeError("allowRefererFallback and allowMissingOrigin must be booleans");
  }
  const onEvent = options.onEvent ?? (() => {});
  if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");
  return Object.freeze({
    allowedOrigins: new Set(origins),
    allowRefererFallback,
    allowMissingOrigin,
    onEvent
  });
}

/**
 * Origin allowlist middleware for browser routes using ambient credentials
 * such as cookies. This is a CSRF defense-in-depth control, not a token system.
 */
export function createOriginProtection(options = {}) {
  const settings = normalizeOptions(options);
  const stats = { requests: 0, allowed: 0, blocked: 0 };

  function middleware(request, response, next) {
    if (!request || !response || typeof next !== "function") {
      throw new TypeError("Origin protection middleware requires (request, response, next)");
    }
    stats.requests += 1;
    const method = typeof request.method === "string"
      ? request.method.toUpperCase()
      : "UNKNOWN";

    // Safe methods must remain side-effect-free in the application.
    if (SAFE_METHODS.has(method)) {
      stats.allowed += 1;
      next();
      return;
    }

    const originHeader = readSingleHeader(request, "origin");
    const refererHeader = readSingleHeader(request, "referer");
    let candidate = originHeader.present && !originHeader.malformed
      ? parseOrigin(originHeader.value, false)
      : null;

    if (!originHeader.present && !originHeader.malformed &&
        settings.allowRefererFallback && refererHeader.present && !refererHeader.malformed) {
      candidate = parseOrigin(refererHeader.value, true);
    }

    const missingAllowed = !originHeader.present &&
      !refererHeader.present &&
      settings.allowMissingOrigin;
    const allowed = missingAllowed || (candidate !== null && settings.allowedOrigins.has(candidate));
    if (allowed) {
      stats.allowed += 1;
      next();
      return;
    }

    stats.blocked += 1;
    const event = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      component: "jb-security-guard",
      action: "origin-blocked",
      severity: "high",
      ruleIds: ["JBG-CSRF-ORIGIN-001"],
      method: method.slice(0, 32)
    };
    safeNotify(settings.onEvent, event);

    if (response.headersSent || response.writableEnded) {
      response.destroy?.();
      return;
    }
    response.statusCode = 403;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      error: "request_origin_rejected",
      message: "Request origin is not allowed"
    }));
  }

  return Object.freeze({
    middleware,
    getStats() { return Object.freeze({ ...stats }); },
    reset() {
      stats.requests = 0;
      stats.allowed = 0;
      stats.blocked = 0;
    }
  });
}
