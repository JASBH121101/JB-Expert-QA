import {
  createHmac,
  randomUUID,
  timingSafeEqual
} from "node:crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_HEADER_NAME = "x-csrf-token";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSecret(value) {
  const secret = Buffer.isBuffer(value) ? Buffer.from(value) :
    typeof value === "string" ? Buffer.from(value, "utf8") : null;
  if (!secret || secret.length < 32) {
    throw new TypeError("secret must contain at least 32 bytes of stable secret material");
  }
  return secret;
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

function normalizeOptions(options) {
  if (!isRecord(options)) throw new TypeError("CSRF protection options must be an object");
  const allowed = new Set(["secret", "sessionKeyGenerator", "headerName", "onEvent"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("Unknown CSRF protection option: " + key);
  }

  const secret = normalizeSecret(options.secret);
  if (typeof options.sessionKeyGenerator !== "function") {
    throw new TypeError("sessionKeyGenerator is required and must return a stable opaque session identifier");
  }
  const headerName = options.headerName ?? DEFAULT_HEADER_NAME;
  if (typeof headerName !== "string" || !/^x-[a-z0-9-]{1,60}$/.test(headerName)) {
    throw new TypeError("headerName must be a valid lowercase X- header name");
  }
  const onEvent = options.onEvent ?? (() => {});
  if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");

  return Object.freeze({
    secret,
    sessionKeyGenerator: options.sessionKeyGenerator,
    headerName,
    onEvent
  });
}

/**
 * Stateless synchronizer-token helper. Tokens are HMAC-bound to the host
 * application's current session identifier; session storage remains external.
 */
export function createCsrfProtection(options = {}) {
  const settings = normalizeOptions(options);
  const stats = { requests: 0, allowed: 0, blocked: 0 };

  function sessionKey(request) {
    let value;
    try {
      value = settings.sessionKeyGenerator(request);
    } catch {
      throw new TypeError("sessionKeyGenerator could not resolve the current session");
    }
    if (typeof value !== "string" && typeof value !== "number") {
      throw new TypeError("sessionKeyGenerator must return a string or number");
    }
    const normalized = String(value).trim();
    if (!normalized || normalized.length > 512) {
      throw new TypeError("sessionKeyGenerator must return a non-empty opaque session identifier of at most 512 characters");
    }
    return normalized;
  }

  function createToken(request) {
    const key = sessionKey(request);
    return createHmac("sha256", settings.secret)
      .update("jb-security-guard-csrf-v1")
      .update("\0")
      .update(key)
      .digest("base64url");
  }

  function verifyToken(request, suppliedToken) {
    if (typeof suppliedToken !== "string" || suppliedToken.length !== 43) return false;
    let expected;
    try {
      expected = createToken(request);
    } catch {
      return false;
    }
    const expectedBytes = Buffer.from(expected, "ascii");
    const suppliedBytes = Buffer.from(suppliedToken, "ascii");
    return expectedBytes.length === suppliedBytes.length &&
      timingSafeEqual(expectedBytes, suppliedBytes);
  }

  function middleware(request, response, next) {
    if (!request || !response || typeof next !== "function") {
      throw new TypeError("CSRF middleware requires (request, response, next)");
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

    const supplied = request.headers?.[settings.headerName];
    const token = typeof supplied === "string" ? supplied : null;
    if (verifyToken(request, token)) {
      stats.allowed += 1;
      next();
      return;
    }

    stats.blocked += 1;
    safeNotify(settings.onEvent, {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      component: "jb-security-guard",
      action: "csrf-token-rejected",
      severity: "high",
      ruleIds: ["JBG-CSRF-TOKEN-001"],
      method: method.slice(0, 32)
    });

    if (response.headersSent || response.writableEnded) {
      response.destroy?.();
      return;
    }
    response.statusCode = 403;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      error: "csrf_token_rejected",
      message: "Request verification failed"
    }));
  }

  return Object.freeze({
    middleware,
    createToken,
    verifyToken,
    headerName: settings.headerName,
    getStats() { return Object.freeze({ ...stats }); },
    reset() {
      stats.requests = 0;
      stats.allowed = 0;
      stats.blocked = 0;
    }
  });
}
