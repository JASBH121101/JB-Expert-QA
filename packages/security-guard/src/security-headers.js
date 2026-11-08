const DEFAULT_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=()";
const REFERRER_POLICIES = new Set([
  "no-referrer", "no-referrer-when-downgrade", "origin",
  "origin-when-cross-origin", "same-origin", "strict-origin",
  "strict-origin-when-cross-origin", "unsafe-url"
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeHeaderValue(value, name, maximumLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength ||
      /[\r\n\u0000]/.test(value)) {
    throw new TypeError(name + " must be a non-empty, single-line string within the configured length");
  }
  return value.trim();
}

function normalizeOptions(options) {
  if (!isRecord(options)) throw new TypeError("securityHeaders options must be an object");
  const allowed = new Set([
    "frameOptions", "referrerPolicy", "permissionsPolicy",
    "contentSecurityPolicy", "contentSecurityPolicyReportOnly",
    "hsts", "isSecureRequest"
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("Unknown securityHeaders option: " + key);
  }

  const frameOptions = options.frameOptions ?? "SAMEORIGIN";
  if (frameOptions !== false && frameOptions !== "DENY" && frameOptions !== "SAMEORIGIN") {
    throw new TypeError("frameOptions must be DENY, SAMEORIGIN, or false");
  }
  const referrerPolicy = options.referrerPolicy ?? "strict-origin-when-cross-origin";
  if (!REFERRER_POLICIES.has(referrerPolicy)) {
    throw new TypeError("referrerPolicy must be a supported Referrer-Policy token");
  }
  const permissionsPolicy = safeHeaderValue(
    options.permissionsPolicy ?? DEFAULT_PERMISSIONS_POLICY, "permissionsPolicy", 2048
  );
  const contentSecurityPolicy = options.contentSecurityPolicy === undefined
    ? null : safeHeaderValue(options.contentSecurityPolicy, "contentSecurityPolicy", 8192);
  const contentSecurityPolicyReportOnly = options.contentSecurityPolicyReportOnly === undefined
    ? null : safeHeaderValue(options.contentSecurityPolicyReportOnly, "contentSecurityPolicyReportOnly", 8192);
  if (contentSecurityPolicy && contentSecurityPolicyReportOnly) {
    throw new TypeError("Configure either enforced CSP or report-only CSP, not both");
  }

  const hstsInput = options.hsts ?? {};
  if (!isRecord(hstsInput)) throw new TypeError("hsts must be an object");
  for (const key of Object.keys(hstsInput)) {
    if (!["enabled", "maxAgeSeconds", "includeSubDomains", "preload"].includes(key)) {
      throw new TypeError("Unknown hsts option: " + key);
    }
  }
  const hsts = {
    enabled: hstsInput.enabled ?? true,
    maxAgeSeconds: hstsInput.maxAgeSeconds ?? 31_536_000,
    includeSubDomains: hstsInput.includeSubDomains ?? false,
    preload: hstsInput.preload ?? false
  };
  if (typeof hsts.enabled !== "boolean" || !Number.isSafeInteger(hsts.maxAgeSeconds) ||
      hsts.maxAgeSeconds < 0 || hsts.maxAgeSeconds > 63_072_000 ||
      typeof hsts.includeSubDomains !== "boolean" || typeof hsts.preload !== "boolean") {
    throw new TypeError("hsts settings contain an invalid value");
  }
  if (hsts.preload && (!hsts.includeSubDomains || hsts.maxAgeSeconds < 31_536_000)) {
    throw new TypeError("HSTS preload requires includeSubDomains and maxAgeSeconds of at least one year");
  }

  const isSecureRequest = options.isSecureRequest ?? ((request) =>
    request?.socket?.encrypted === true || request?.secure === true
  );
  if (typeof isSecureRequest !== "function") {
    throw new TypeError("isSecureRequest must be a function");
  }

  return Object.freeze({
    frameOptions, referrerPolicy, permissionsPolicy,
    contentSecurityPolicy, contentSecurityPolicyReportOnly,
    hsts: Object.freeze(hsts), isSecureRequest
  });
}

export function createSecurityHeaders(options = {}) {
  const settings = normalizeOptions(options);
  function middleware(request, response, next) {
    if (!request || !response || typeof next !== "function" ||
        typeof response.setHeader !== "function") {
      throw new TypeError("Security headers middleware requires (request, response, next)");
    }
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", settings.referrerPolicy);
    response.setHeader("Permissions-Policy", settings.permissionsPolicy);
    if (settings.frameOptions) response.setHeader("X-Frame-Options", settings.frameOptions);
    if (settings.contentSecurityPolicy) {
      response.setHeader("Content-Security-Policy", settings.contentSecurityPolicy);
    } else if (settings.contentSecurityPolicyReportOnly) {
      response.setHeader("Content-Security-Policy-Report-Only", settings.contentSecurityPolicyReportOnly);
    }
    response.removeHeader?.("X-Powered-By");

    if (settings.hsts.enabled) {
      let secure = false;
      try {
        secure = settings.isSecureRequest(request) === true;
      } catch {
        // Fail closed: never emit HSTS based on an untrusted or broken resolver.
      }
      if (secure) {
        const directives = ["max-age=" + settings.hsts.maxAgeSeconds];
        if (settings.hsts.includeSubDomains) directives.push("includeSubDomains");
        if (settings.hsts.preload) directives.push("preload");
        response.setHeader("Strict-Transport-Security", directives.join("; "));
      }
    }
    next();
  }
  return Object.freeze({ middleware });
}
