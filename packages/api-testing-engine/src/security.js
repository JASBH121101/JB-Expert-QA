const POLICY_KEYS = new Set([
  "requireHttps", "allowInsecureLocalhost", "requireNoSniff", "requireHsts",
  "disallowWildcardCors", "disallowServerDisclosure", "sensitiveResponse",
  "requireSecureCookies", "requireHttpOnlyCookies", "requireSameSiteCookies",
  "scanSensitiveFields", "requestOrigin", "allowedCorsOrigins"
]);
const SENSITIVE_FIELDS = new Set([
  "password", "passwd", "pwd", "secret", "client_secret", "clientsecret",
  "access_token", "accesstoken", "refresh_token", "refreshtoken", "id_token",
  "idtoken", "api_key", "apikey", "private_key", "privatekey", "authorization",
  "credential", "credentials"
]);
const DISCLOSURE_HEADERS = ["server", "x-powered-by", "x-aspnet-version", "x-aspnetmvc-version", "via"];
const MAX_HEADERS = 200;
const MAX_COOKIE_COUNT = 100;
const MAX_JSON_NODES = 20000;
const MAX_JSON_DEPTH = 24;

export const API_SECURITY_TESTING_ENGINE_ID = "jb.api-security-testing-engine";
export const API_SECURITY_TESTING_ENGINE_VERSION = "0.1.0";

export class ApiSecurityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiSecurityError";
    this.code = code;
  }
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainDataObject(value, label, allowedKeys) {
  if (!isRecord(value)) throw new TypeError(label + " must be a plain object");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new TypeError(label + " cannot contain symbol properties");
  }
  const keys = ownKeys;
  if (allowedKeys && keys.some((key) => !allowedKeys.has(key))) {
    throw new TypeError(label + " contains unsupported fields");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " cannot contain getters or setters");
    }
  }
}

function assertSafeJson(value, label, limits = {}) {
  const maxDepth = limits.maxDepth ?? MAX_JSON_DEPTH;
  const maxNodes = limits.maxNodes ?? MAX_JSON_NODES;
  const seen = new Set();
  let nodes = 0;

  function visit(item, depth) {
    nodes += 1;
    if (nodes > maxNodes) throw new TypeError(label + " exceeds the maximum value count");
    if (depth > maxDepth) throw new TypeError(label + " exceeds the maximum nesting depth");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError(label + " contains a non-finite number");
      return;
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) throw new TypeError(label + " contains circular data");
      seen.add(item);
      const keys = Object.keys(item);
      if (keys.length !== item.length || keys.some((key) => !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length)) {
        throw new TypeError(label + " arrays cannot contain custom enumerable properties");
      }
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError(label + " arrays cannot contain holes or accessors");
        }
        visit(descriptor.value, depth + 1);
      }
      seen.delete(item);
      return;
    }
    if (!isRecord(item)) throw new TypeError(label + " must contain plain JSON objects");
    if (seen.has(item)) throw new TypeError(label + " contains circular data");
    seen.add(item);
    for (const key of Object.keys(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new TypeError(label + " contains a forbidden object key");
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError(label + " cannot contain getters or setters");
      }
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  }

  visit(value, 0);
}

function normalizeOrigin(value, label) {
  if (typeof value !== "string" || !value || value.length > 2048) {
    throw new TypeError(label + " must be a valid HTTP(S) origin");
  }
  let url;
  try { url = new URL(value); } catch { throw new TypeError(label + " must be a valid HTTP(S) origin"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || url.origin === "null") {
    throw new TypeError(label + " must be an exact HTTP(S) origin without credentials, path, query or fragment");
  }
  return url.origin;
}

function normalizePolicy(input) {
  if (input === undefined) input = {};
  assertPlainDataObject(input, "policy", POLICY_KEYS);
  const defaults = {
    requireHttps: true,
    allowInsecureLocalhost: false,
    requireNoSniff: true,
    requireHsts: true,
    disallowWildcardCors: true,
    disallowServerDisclosure: false,
    sensitiveResponse: false,
    requireSecureCookies: true,
    requireHttpOnlyCookies: true,
    requireSameSiteCookies: true,
    scanSensitiveFields: true
  };
  for (const key of Object.keys(defaults)) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") {
      throw new TypeError("policy." + key + " must be boolean");
    }
    if (input[key] !== undefined) defaults[key] = input[key];
  }

  let requestOrigin;
  if (input.requestOrigin !== undefined) requestOrigin = normalizeOrigin(input.requestOrigin, "policy.requestOrigin");

  let allowedCorsOrigins;
  if (input.allowedCorsOrigins !== undefined) {
    if (!Array.isArray(input.allowedCorsOrigins) || input.allowedCorsOrigins.length > 100) {
      throw new TypeError("policy.allowedCorsOrigins must be an array of at most 100 exact origins");
    }
    const arrayKeys = Object.keys(input.allowedCorsOrigins);
    if (arrayKeys.length !== input.allowedCorsOrigins.length ||
        arrayKeys.some((key) => !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= input.allowedCorsOrigins.length)) {
      throw new TypeError("policy.allowedCorsOrigins cannot contain sparse or custom array properties");
    }
    allowedCorsOrigins = [];
    const seen = new Set();
    for (let index = 0; index < input.allowedCorsOrigins.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input.allowedCorsOrigins, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError("policy.allowedCorsOrigins cannot contain array accessors");
      }
      const item = descriptor.value;
      const origin = normalizeOrigin(item, "policy.allowedCorsOrigins entry");
      if (seen.has(origin)) throw new TypeError("policy.allowedCorsOrigins cannot contain duplicates");
      seen.add(origin);
      allowedCorsOrigins.push(origin);
    }
  }

  return Object.freeze({ ...defaults, requestOrigin, allowedCorsOrigins: allowedCorsOrigins ? Object.freeze(allowedCorsOrigins) : undefined });
}

function normalizeResponse(response) {
  const required = new Set(["method", "url", "status", "headers"]);
  assertPlainDataObject(response, "response");
  for (const key of required) {
    if (!Object.hasOwn(response, key)) throw new TypeError("response." + key + " is required");
  }
  if (typeof response.method !== "string" || response.method.length > 16) {
    throw new TypeError("response.method must be a bounded string");
  }
  if (typeof response.url !== "string" || response.url.length > 4096) {
    throw new TypeError("response.url must be an absolute URL string");
  }
  let url;
  try { url = new URL(response.url); } catch { throw new TypeError("response.url must be a valid absolute URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError("response.url must use HTTP(S) without credentials or fragment");
  }
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new TypeError("response.status must be an HTTP status code");
  }
  assertPlainDataObject(response.headers, "response.headers");
  const entries = Object.entries(response.headers);
  if (entries.length > MAX_HEADERS) throw new TypeError("response.headers exceeds the header count limit");
  const headers = new Map();
  for (const [name, value] of entries) {
    if (!/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]{1,128}$/u.test(name) ||
        typeof value !== "string" || value.length > 8192 || /[\r\n\0]/u.test(value)) {
      throw new TypeError("response.headers contains an invalid header name or value");
    }
    const key = name.toLowerCase();
    if (headers.has(key)) throw new TypeError("response.headers contains duplicate names after case normalization");
    headers.set(key, value.trim());
  }

  if (response.jsonParsed === true) {
    if (!Object.hasOwn(response, "json")) throw new TypeError("response.json is required when jsonParsed is true");
    assertSafeJson(response.json, "response.json");
  }

  return Object.freeze({ method: response.method.toUpperCase(), url, status: response.status, headers, jsonParsed: response.jsonParsed === true, json: response.json });
}

function isLocalhost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function addCheck(checks, id, category, severity, status, title, message, recommendation, evidence = {}) {
  checks.push(Object.freeze({
    id,
    category,
    severity,
    status,
    passed: status === "pass",
    title,
    message,
    recommendation,
    evidence: Object.freeze(evidence)
  }));
}

function splitSetCookie(value) {
  return value.split(/,(?=\s*[^;,\s=]+=[^;]*)/u).map((item) => item.trim()).filter(Boolean);
}

function scanSensitiveValues(root, checks) {
  const matches = [];
  let visited = 0;
  function walk(value, path, depth) {
    visited += 1;
    if (visited > MAX_JSON_NODES || depth > MAX_JSON_DEPTH || matches.length >= 100) return;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) walk(value[index], path + "[" + index + "]", depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[-\s]/gu, "_");
      const itemHasValue = item !== null && item !== undefined &&
        !(typeof item === "string" && (!item.trim() || /^\[?redacted\]?$/iu.test(item.trim()) || /^[*x]{3,}$/iu.test(item.trim())));
      const nextPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? path + "." + key : path + "[" + JSON.stringify(key) + "]";
      if (SENSITIVE_FIELDS.has(normalized) && itemHasValue) {
        matches.push({
          path: nextPath,
          field: normalized,
          valueType: Array.isArray(item) ? "array" : item === null ? "null" : typeof item,
          valueLength: typeof item === "string" ? item.length : undefined
        });
      }
      if (isRecord(item) || Array.isArray(item)) walk(item, nextPath, depth + 1);
    }
  }
  walk(root, "$", 0);
  return matches;
}

function buildReport(checks) {
  const passCount = checks.filter((item) => item.status === "pass").length;
  const warningCount = checks.filter((item) => item.status === "warning").length;
  const failed = checks.filter((item) => item.status === "fail");
  const bySeverity = {};
  for (const severity of ["critical", "high", "medium", "low", "info"]) {
    bySeverity[severity] = failed.filter((item) => item.severity === severity).length;
  }
  return Object.freeze({
    engineId: API_SECURITY_TESTING_ENGINE_ID,
    version: API_SECURITY_TESTING_ENGINE_VERSION,
    passed: failed.length === 0,
    status: failed.length ? "fail" : warningCount ? "warning" : "pass",
    total: checks.length,
    passCount,
    warningCount,
    failedCount: failed.length,
    findingsCount: failed.length + warningCount,
    bySeverity: Object.freeze(bySeverity),
    checks: Object.freeze(checks)
  });
}

function analyzeResponse(normalized, policy) {
  const checks = [];
  const { url, headers } = normalized;
  const get = (name) => headers.get(name) ?? null;

  const secure = url.protocol === "https:";
  const localException = policy.allowInsecureLocalhost && isLocalhost(url.hostname);
  let status = "pass";
  if (policy.requireHttps && !secure && !localException) status = "fail";
  addCheck(checks, "transport.https", "transport", "high", status,
    "HTTPS transport",
    status === "pass" ? "Response URL uses an accepted secure transport." : "The API response was obtained over HTTP while HTTPS is required.",
    "Serve the API over HTTPS and redirect HTTP traffic at the edge; do not send credentials over plaintext HTTP.",
    { protocol: url.protocol.slice(0, -1), localhostException: localException });

  const hsts = get("strict-transport-security");
  if (secure && policy.requireHsts) {
    const hstsValid = typeof hsts === "string" && /(?:^|;)\s*max-age\s*=\s*(\d+)/iu.test(hsts) &&
      Number(hsts.match(/(?:^|;)\s*max-age\s*=\s*(\d+)/iu)?.[1] ?? 0) > 0;
    addCheck(checks, "headers.hsts", "headers", "medium", hstsValid ? "pass" : "fail",
      "HTTP Strict Transport Security",
      hstsValid ? "HSTS is present with a positive max-age." : "HSTS is missing or has no positive max-age on an HTTPS response.",
      "Add a validated Strict-Transport-Security policy at the HTTPS edge after confirming all subdomains support HTTPS.",
      { present: typeof hsts === "string" });
  }

  if (policy.requireNoSniff) {
    const nosniff = get("x-content-type-options");
    const valid = typeof nosniff === "string" && nosniff.toLowerCase() === "nosniff";
    addCheck(checks, "headers.content-type-options", "headers", "low", valid ? "pass" : "fail",
      "MIME sniffing protection",
      valid ? "X-Content-Type-Options is set to nosniff." : "X-Content-Type-Options is missing or does not equal nosniff.",
      "Set X-Content-Type-Options: nosniff on API responses.",
      { present: typeof nosniff === "string" });
  }

  const allowOrigin = get("access-control-allow-origin");
  const allowCredentials = get("access-control-allow-credentials")?.toLowerCase() === "true";
  const vary = (get("vary") || "").split(",").map((item) => item.trim().toLowerCase());
  if (allowOrigin !== null || policy.requestOrigin !== undefined || policy.allowedCorsOrigins !== undefined) {
    let corsStatus = "pass";
    let corsCode = "cors.origin-policy";
    let corsMessage = "CORS response origin policy satisfies the supplied security policy.";
    let recommendation = "Allow only the origins required by the API and avoid wildcard credentialed access.";
    const normalizedAllowOrigin = allowOrigin?.trim() ?? null;
    if (normalizedAllowOrigin === "null") {
      corsStatus = "fail";
      corsMessage = "The API explicitly allows the opaque null origin.";
    } else if (normalizedAllowOrigin && normalizedAllowOrigin.includes(",")) {
      corsStatus = "fail";
      corsMessage = "Access-Control-Allow-Origin contains multiple origins; browsers require one serialized origin or wildcard.";
    } else if (normalizedAllowOrigin === "*" && allowCredentials) {
      corsStatus = "fail";
      corsCode = "cors.wildcard-credentials";
      corsMessage = "Wildcard CORS is combined with credentialed access.";
    } else if (normalizedAllowOrigin === "*" && policy.allowedCorsOrigins !== undefined) {
      corsStatus = "fail";
      corsMessage = "Wildcard CORS cannot satisfy an explicit origin allowlist.";
    } else if (normalizedAllowOrigin === "*" && policy.disallowWildcardCors) {
      corsStatus = "fail";
      corsMessage = "Wildcard CORS is disallowed by the active policy.";
    } else if (policy.requestOrigin !== undefined &&
      normalizedAllowOrigin !== policy.requestOrigin && normalizedAllowOrigin !== "*") {
      corsStatus = "fail";
      corsMessage = "Access-Control-Allow-Origin does not match the supplied request origin.";
    } else if (normalizedAllowOrigin === null && policy.requestOrigin !== undefined) {
      corsStatus = "fail";
      corsMessage = "A cross-origin request was supplied but the response does not declare Access-Control-Allow-Origin.";
    } else if (policy.allowedCorsOrigins && normalizedAllowOrigin !== "*" &&
      (!normalizedAllowOrigin || !policy.allowedCorsOrigins.includes(normalizedAllowOrigin))) {
      corsStatus = "fail";
      corsMessage = "Access-Control-Allow-Origin is not in the configured origin allowlist.";
    } else if (normalizedAllowOrigin === "*" && !policy.disallowWildcardCors) {
      corsStatus = "warning";
      corsMessage = "Wildcard CORS is enabled by policy; review whether public cross-origin access is intentional.";
    }

    addCheck(checks, corsCode, "cors", allowCredentials && normalizedAllowOrigin === "*" ? "critical" : "high",
      corsStatus, "CORS origin policy", corsMessage, recommendation,
      { allowOriginPresent: normalizedAllowOrigin !== null, wildcard: normalizedAllowOrigin === "*", credentials: allowCredentials });

    if (normalizedAllowOrigin && normalizedAllowOrigin !== "*" && !vary.includes("origin")) {
      addCheck(checks, "cors.vary-origin", "cors", "low", "warning",
        "CORS cache variation",
        "A specific Access-Control-Allow-Origin is returned without Vary: Origin.",
        "Add Origin to the Vary response header when the allowed origin is selected dynamically.",
        { varyOriginPresent: false });
    }
  }

  if (policy.sensitiveResponse) {
    const cacheControl = get("cache-control") || "";
    const directives = cacheControl.toLowerCase().split(",").map((item) => item.trim().split("=")[0]);
    const noStore = directives.includes("no-store");
    const publicCache = directives.includes("public");
    const cacheStatus = noStore && !publicCache ? "pass" : "fail";
    addCheck(checks, "cache.sensitive-response", "data-protection", "high", cacheStatus,
      "Sensitive response cache policy",
      cacheStatus === "pass" ? "Sensitive response uses Cache-Control: no-store without public caching." : "Sensitive response is not explicitly protected from storage, or is marked public.",
      "Use Cache-Control: no-store for responses that contain account, credential or other sensitive data.",
      { cacheControlPresent: Boolean(cacheControl), noStore, public: publicCache });
  }

  const cookies = get("set-cookie");
  if (cookies !== null) {
    const list = splitSetCookie(cookies);
    if (list.length > MAX_COOKIE_COUNT) {
      addCheck(checks, "cookies.count-limit", "cookies", "medium", "fail",
        "Cookie header count",
        "The response exceeds the cookie inspection limit.",
        "Reduce the number of Set-Cookie values and inspect the response before returning it.",
        { cookieCount: list.length, maximum: MAX_COOKIE_COUNT });
    } else {
      list.forEach((cookie, index) => {
        const parts = cookie.split(";").map((part) => part.trim());
        const attributes = new Set(parts.slice(1).map((part) => part.split("=")[0].toLowerCase()));
        const sameSitePart = parts.find((part) => part.toLowerCase().startsWith("samesite="));
        const sameSite = sameSitePart ? sameSitePart.slice(sameSitePart.indexOf("=") + 1).toLowerCase() : null;
        const missing = [];
        if (policy.requireSecureCookies && !attributes.has("secure")) missing.push("Secure");
        if (policy.requireHttpOnlyCookies && !attributes.has("httponly")) missing.push("HttpOnly");
        if (policy.requireSameSiteCookies && !["strict", "lax", "none"].includes(sameSite)) missing.push("SameSite");
        if (sameSite === "none" && !attributes.has("secure")) missing.push("Secure (required for SameSite=None)");
        const cookieStatus = missing.length ? "fail" : "pass";
        addCheck(checks, "cookies.flags." + (index + 1), "cookies", "medium", cookieStatus,
          "Cookie security attributes",
          cookieStatus === "pass" ? "Cookie includes the required security attributes." : "Cookie is missing one or more required security attributes.",
          "Set Secure, HttpOnly and an appropriate SameSite attribute; SameSite=None also requires Secure.",
          { cookieIndex: index + 1, missingAttributes: Object.freeze([...new Set(missing)]) });
      });
    }
  }

  const disclosures = DISCLOSURE_HEADERS.filter((name) => get(name) !== null);
  const disclosureSeverity = policy.disallowServerDisclosure ? "fail" : "warning";
  if (disclosures.length) {
    addCheck(checks, "headers.technology-disclosure", "information-disclosure", "low", disclosureSeverity,
      "Technology disclosure headers",
      "Response contains one or more headers that reveal server or intermediary implementation details.",
      "Remove unnecessary Server, X-Powered-By, X-AspNet-Version and Via values at the application or edge.",
      { headerNames: Object.freeze(disclosures) });
  } else {
    addCheck(checks, "headers.technology-disclosure", "information-disclosure", "low", "pass",
      "Technology disclosure headers",
      "No common server technology disclosure headers were observed.",
      "Continue minimizing implementation details in response headers.",
      { headerNames: Object.freeze([]) });
  }

  if (policy.scanSensitiveFields && normalized.jsonParsed) {
    const sensitive = scanSensitiveValues(normalized.json, checks);
    if (sensitive.length) {
      const tokenFields = new Set(["access_token", "accesstoken", "refresh_token", "refreshtoken", "id_token", "idtoken"]);
      const unexpectedSecrets = sensitive.filter((item) => !tokenFields.has(item.field));
      const expectedTokenMaterial = sensitive.filter((item) => tokenFields.has(item.field));
      if (unexpectedSecrets.length) {
        addCheck(checks, "data.sensitive-fields", "data-exposure", "high", "fail",
          "Sensitive response fields",
          "Parsed response JSON contains populated fields commonly used for passwords, private keys or server-side credentials.",
          "Do not return stored passwords, private keys or server-side credentials. Replace them with non-sensitive status metadata.",
          { fieldCount: unexpectedSecrets.length, fields: Object.freeze(unexpectedSecrets.map((item) => Object.freeze(item))) });
      }
      if (expectedTokenMaterial.length) {
        addCheck(checks, "data.authentication-tokens", "authentication-data", "medium", "warning",
          "Authentication token material",
          "Parsed response JSON contains access, refresh or identity token fields. These can be legitimate authentication responses but require endpoint-specific review.",
          "Confirm the endpoint is an intentional authentication flow, tokens are short-lived and scoped, and responses use Cache-Control: no-store.",
          { fieldCount: expectedTokenMaterial.length, fields: Object.freeze(expectedTokenMaterial.map((item) => Object.freeze(item))) });
      }
    } else {
      addCheck(checks, "data.sensitive-fields", "data-exposure", "high", "pass",
        "Sensitive response fields",
        "No populated credential-like field names were detected in parsed response JSON.",
        "Review data-transfer objects and keep credential material out of ordinary API responses.",
        { fieldCount: 0 });
    }
  }

  return buildReport(checks);
}

export function createApiSecurityTestingEngine() {
  function analyze(response, policy = {}) {
    const normalized = normalizeResponse(response);
    const normalizedPolicy = normalizePolicy(policy);
    return analyzeResponse(normalized, normalizedPolicy);
  }

  return Object.freeze({
    engineId: API_SECURITY_TESTING_ENGINE_ID,
    version: API_SECURITY_TESTING_ENGINE_VERSION,
    analyze
  });
}
