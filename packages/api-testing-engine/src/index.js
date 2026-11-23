const METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const BLOCKED_HEADERS = new Set(["connection", "content-length", "host", "keep-alive", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const SENSITIVE_HEADER = /authorization|cookie|token|secret|api[-_]?key|password|credential|signature/i;
const SENSITIVE_QUERY = /access[-_]?token|auth|api[-_]?key|client[-_]?secret|credential|password|secret|signature|token/i;
const MAX_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export const API_TESTING_ENGINE_ID = "jb.api-testing-engine";
export const API_TESTING_ENGINE_VERSION = "0.1.0";

export class ApiTestingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiTestingError";
    this.code = code;
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJsonValue(value, label) {
  const seen = new Set();
  function visit(item, depth) {
    if (depth > 20) throw new TypeError(label + " exceeds the maximum JSON depth");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError(label + " contains a non-finite number");
      return;
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) throw new TypeError(label + " cannot contain circular data");
      seen.add(item);
      for (let index = 0; index < item.length; index += 1) {
        if (!Object.hasOwn(item, index)) throw new TypeError(label + " cannot contain sparse arrays");
        visit(item[index], depth + 1);
      }
      seen.delete(item);
      return;
    }
    if (!isPlainRecord(item)) throw new TypeError(label + " must contain JSON-compatible values only");
    if (seen.has(item)) throw new TypeError(label + " cannot contain circular data");
    seen.add(item);
    for (const key of Object.keys(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new TypeError(label + " contains a forbidden object key");
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError(label + " cannot contain accessors");
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  }
  visit(value, 0);
}

function boundedInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(label + " must be an integer between 1 and " + maximum);
  }
  return value;
}

function normalizeAllowedOrigins(origins) {
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 100) {
    throw new TypeError("allowedOrigins must contain between 1 and 100 exact origins");
  }
  const result = new Set();
  for (const value of origins) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError("Each allowed origin must be a non-empty URL string");
    let url;
    try { url = new URL(value); } catch { throw new TypeError("allowedOrigins contains an invalid URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash || url.origin === "null") {
      throw new TypeError("allowedOrigins entries must be exact HTTP(S) origins without paths or credentials");
    }
    if (result.has(url.origin)) throw new TypeError("allowedOrigins cannot contain duplicate origins");
    result.add(url.origin);
  }
  return result;
}

function normalizeUrl(value, allowlist) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) {
    throw new TypeError("request.url must be an absolute URL of at most 4096 characters");
  }
  let url;
  try { url = new URL(value); } catch { throw new TypeError("request.url must be a valid absolute URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("Only HTTP and HTTPS API endpoints are supported");
  if (url.username || url.password) throw new TypeError("Credentials in request URLs are not allowed; use an authorization header");
  if (url.hash) throw new TypeError("URL fragments are not allowed in API requests");
  if (!allowlist.has(url.origin)) {
    throw new ApiTestingError("ORIGIN_NOT_ALLOWED", "Request origin is not in the configured allowlist: " + url.origin);
  }
  return url;
}

function safeUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
  return url.toString();
}

function normalizeHeaders(input, jsonProvided) {
  if (input !== undefined && !isPlainRecord(input)) throw new TypeError("request.headers must be a plain object");
  const headers = new Headers();
  for (const [rawName, rawValue] of Object.entries(input || {})) {
    const name = rawName.trim().toLowerCase();
    if (!name || BLOCKED_HEADERS.has(name) || name.startsWith("proxy-")) {
      throw new TypeError("request.headers contains a forbidden header: " + rawName);
    }
    if (typeof rawValue !== "string" || rawValue.length > 8192 || /[\r\n\0]/.test(rawValue)) {
      throw new TypeError("Header values must be strings up to 8192 characters without line breaks");
    }
    headers.set(name, rawValue);
  }
  if (jsonProvided && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (!headers.has("accept")) headers.set("accept", "application/json, text/plain;q=0.9, */*;q=0.1");
  return headers;
}

function normalizeBody(input, method, maxBytes, headers) {
  const hasJson = Object.hasOwn(input, "json");
  const hasBody = Object.hasOwn(input, "body");
  if (hasJson && hasBody) throw new TypeError("Use either request.json or request.body, not both");
  if (!hasJson && !hasBody) return undefined;
  if (method === "GET" || method === "HEAD") throw new TypeError(method + " requests cannot contain a body");
  let body;
  if (hasJson) {
    validateJsonValue(input.json, "request.json");
    body = JSON.stringify(input.json);
    if (typeof body !== "string") throw new TypeError("request.json could not be serialized");
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  } else {
    if (typeof input.body !== "string") throw new TypeError("request.body must be a string; use request.json for JSON values");
    body = input.body;
  }
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new ApiTestingError("REQUEST_TOO_LARGE", "Request body exceeds the configured byte limit");
  }
  return body;
}

function responseHeaders(headers) {
  const output = {};
  for (const [name, value] of headers.entries()) {
    output[name] = SENSITIVE_HEADER.test(name) ? "[REDACTED]" : value;
  }
  return Object.freeze(output);
}

async function readBody(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new ApiTestingError("RESPONSE_TOO_LARGE", "Response body exceeds the configured byte limit");
  }
  if (!response.body) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximumBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new ApiTestingError("RESPONSE_TOO_LARGE", "Response body exceeds the configured byte limit");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(buffer), bytes: total };
}

function parseResponseJson(bodyText, contentType) {
  if (!bodyText || !/(?:application|text)\/(?:[^;]+\+)?json\b/i.test(contentType)) {
    return { json: null, jsonParsed: false, jsonParseError: null };
  }
  try { return { json: JSON.parse(bodyText), jsonParsed: true, jsonParseError: null }; }
  catch { return { json: null, jsonParsed: false, jsonParseError: "Response declared JSON but contained invalid JSON" }; }
}

function validateSignal(signal) {
  if (signal === undefined || signal === null) return;
  if (typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function") {
    throw new TypeError("options.signal must be an AbortSignal");
  }
}

export function createApiRequestEngine({
  allowedOrigins,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  maxRequestBytes = MAX_BODY_BYTES,
  maxResponseBytes = 2 * 1024 * 1024
} = {}) {
  const allowlist = normalizeAllowedOrigins(allowedOrigins);
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a fetch-compatible function");
  const defaultTimeout = boundedInteger(timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);
  const requestLimit = boundedInteger(maxRequestBytes, "maxRequestBytes", MAX_BODY_BYTES);
  const responseLimit = boundedInteger(maxResponseBytes, "maxResponseBytes", MAX_RESPONSE_BYTES);

  async function request(input, options = {}) {
    if (!isPlainRecord(input)) throw new TypeError("request must be a plain object");
    const allowedKeys = new Set(["method", "url", "headers", "json", "body", "timeoutMs", "maxResponseBytes"]);
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw new TypeError("request contains unsupported fields");
    if (!isPlainRecord(options) || Object.keys(options).some((key) => key !== "signal")) {
      throw new TypeError("request options only support an AbortSignal");
    }
    validateSignal(options.signal);

    const method = typeof input.method === "string" ? input.method.trim().toUpperCase() : "";
    if (!METHODS.has(method)) throw new TypeError("request.method must be one of: " + [...METHODS].join(", "));
    const url = normalizeUrl(input.url, allowlist);
    const timeout = input.timeoutMs === undefined ? defaultTimeout : boundedInteger(input.timeoutMs, "request.timeoutMs", MAX_TIMEOUT_MS);
    const maxBytes = input.maxResponseBytes === undefined ? responseLimit : boundedInteger(input.maxResponseBytes, "request.maxResponseBytes", MAX_RESPONSE_BYTES);
    const headers = normalizeHeaders(input.headers, Object.hasOwn(input, "json"));
    const body = normalizeBody(input, method, requestLimit, headers);

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const started = performance.now();

    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer"
      });
      const bodyResult = await readBody(response, maxBytes);
      const contentType = response.headers.get("content-type") || "";
      return Object.freeze({
        engineId: API_TESTING_ENGINE_ID,
        method,
        url: safeUrl(url.toString()),
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        redirected: response.redirected,
        responseUrl: response.url ? safeUrl(response.url) : safeUrl(url.toString()),
        headers: responseHeaders(response.headers),
        bodyText: bodyResult.text,
        bytesReceived: bodyResult.bytes,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        ...parseResponseJson(bodyResult.text, contentType)
      });
    } catch (error) {
      if (error instanceof ApiTestingError) throw error;
      if (timedOut) throw new ApiTestingError("REQUEST_TIMEOUT", "API request exceeded its " + timeout + " ms timeout");
      if (options.signal?.aborted) throw new ApiTestingError("REQUEST_ABORTED", "API request was cancelled");
      throw new ApiTestingError("NETWORK_ERROR", "API request failed for " + safeUrl(url.toString()));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  return Object.freeze({
    engineId: API_TESTING_ENGINE_ID,
    version: API_TESTING_ENGINE_VERSION,
    allowedOrigins: Object.freeze([...allowlist]),
    request
  });
}


export {
  API_ASSERTIONS_ENGINE_ID,
  API_ASSERTIONS_ENGINE_VERSION,
  ApiAssertionError,
  createApiAssertionsEngine
} from "./assertions.js";
