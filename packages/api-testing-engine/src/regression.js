import { createHash } from "node:crypto";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SENSITIVE_NAME = /authorization|cookie|token|secret|password|credential|api[-_]?key|email|phone|ssn|private[-_]?key/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;
const MAX_SHAPE_NODES = 10000;
const MAX_JSON_DEPTH = 24;
const MAX_PATH_LENGTH = 512;

export const API_REGRESSION_ENGINE_ID = "jb.api-regression-engine";
export const API_REGRESSION_ENGINE_VERSION = "0.1.0";
export const API_REGRESSION_BASELINE_SCHEMA = "jb.api-regression-baseline/v1";

export class ApiRegressionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiRegressionError";
    this.code = code;
  }
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonSafe(value, label, limits = {}) {
  const maximumDepth = limits.maximumDepth ?? MAX_JSON_DEPTH;
  const maximumNodes = limits.maximumNodes ?? MAX_SHAPE_NODES;
  const seen = new Set();
  let nodes = 0;
  function visit(item, depth) {
    nodes += 1;
    if (nodes > maximumNodes) throw new TypeError(label + " exceeds the maximum value count");
    if (depth > maximumDepth) throw new TypeError(label + " exceeds the maximum JSON depth");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError(label + " contains a non-finite number");
      return;
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) throw new TypeError(label + " cannot contain circular data");
      seen.add(item);
      const keys = Object.keys(item);
      if (keys.length !== item.length || keys.some((key) => !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length)) {
        throw new TypeError(label + " arrays cannot contain holes or custom properties");
      }
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError(label + " cannot contain array accessors");
        visit(descriptor.value, depth + 1);
      }
      seen.delete(item);
      return;
    }
    if (!isRecord(item)) throw new TypeError(label + " must contain plain JSON objects only");
    if (seen.has(item)) throw new TypeError(label + " cannot contain circular data");
    seen.add(item);
    for (const key of Object.keys(item)) {
      if (FORBIDDEN_KEYS.has(key)) throw new TypeError(label + " contains a forbidden object key");
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError(label + " cannot contain getters or setters");
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  }
  visit(value, 0);
}

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
    return output;
  }
  return value;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function propertyPath(base, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? base + "." + key : base + "[" + JSON.stringify(key) + "]";
}

function parsePath(path, { allowWildcard = false, allowSensitive = false } = {}) {
  if (typeof path !== "string" || path.length < 1 || path.length > MAX_PATH_LENGTH || path[0] !== "$") {
    throw new TypeError("JSON paths must start with $ and be at most " + MAX_PATH_LENGTH + " characters");
  }
  const parts = [];
  let index = 1;
  while (index < path.length) {
    if (path[index] === ".") {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(path.slice(index + 1));
      if (!match) throw new TypeError("JSON path contains an invalid property segment");
      if (FORBIDDEN_KEYS.has(match[0]) || (!allowSensitive && SENSITIVE_NAME.test(match[0]))) throw new TypeError("JSON path contains a forbidden or sensitive property name");
      parts.push({ type: "key", value: match[0] });
      index += match[0].length + 1;
      continue;
    }
    if (path[index] === "[") {
      const end = path.indexOf("]", index + 1);
      if (end < 0) throw new TypeError("JSON path contains an unterminated array or property segment");
      const token = path.slice(index + 1, end);
      if (token === "*") {
        if (!allowWildcard) throw new TypeError("Wildcard paths are not allowed here");
        parts.push({ type: "wildcard" });
      } else if (/^(0|[1-9]\d{0,8})$/u.test(token)) {
        parts.push({ type: "index", value: Number(token) });
      } else if (token.startsWith('"')) {
        let key;
        try { key = JSON.parse(token); } catch { throw new TypeError("JSON path contains an invalid quoted property"); }
        if (typeof key !== "string" || !key || FORBIDDEN_KEYS.has(key) || (!allowSensitive && SENSITIVE_NAME.test(key))) {
          throw new TypeError("JSON path contains a forbidden or sensitive property name");
        }
        parts.push({ type: "key", value: key });
      } else {
        throw new TypeError("JSON path contains an invalid bracket segment");
      }
      index = end + 1;
      continue;
    }
    throw new TypeError("JSON path contains an unsupported segment");
  }
  return parts;
}

function matchesIgnoredPath(path, ignored) {
  return ignored.some((pattern) => path === pattern || path.startsWith(pattern + ".") || path.startsWith(pattern + "["));
}

function normalizePathList(value, label, { allowWildcard = false, allowSensitive = false, maximum = 100 } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(label + " must be an array of at most " + maximum + " JSON paths");
  const seen = new Set();
  const output = [];
  for (const path of value) {
    parsePath(path, { allowWildcard, allowSensitive });
    if (seen.has(path)) throw new TypeError(label + " cannot contain duplicate paths");
    seen.add(path);
    output.push(path);
  }
  return output.sort();
}

function collectShape(value, ignoredPaths) {
  const entries = new Map();
  let visited = 0;
  function visit(item, path, depth) {
    visited += 1;
    if (visited > MAX_SHAPE_NODES || depth > MAX_JSON_DEPTH) {
      throw new ApiRegressionError("JSON_COMPLEXITY_LIMIT", "Response JSON exceeds regression shape limits");
    }
    if (matchesIgnoredPath(path, ignoredPaths)) return;
    const type = valueType(item);
    entries.set(path + "\u0000" + type, { path, type });
    if (Array.isArray(item)) {
      for (const child of item) visit(child, path + "[*]", depth + 1);
    } else if (isRecord(item)) {
      for (const key of Object.keys(item).sort()) visit(item[key], propertyPath(path, key), depth + 1);
    }
  }
  visit(value, "$", 0);
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type));
}

function getPath(value, path) {
  let current = value;
  for (const part of parsePath(path)) {
    if (part.type === "key") {
      if (!isRecord(current) || !Object.hasOwn(current, part.value)) return { found: false };
      current = current[part.value];
    } else if (part.type === "index") {
      if (!Array.isArray(current) || part.value >= current.length) return { found: false };
      current = current[part.value];
    } else return { found: false };
  }
  return { found: true, value: current };
}

function safeReportPath(path) {
  return path.replace(/\.([A-Za-z_$][A-Za-z0-9_$]*)/gu, (segment, key) => SENSITIVE_NAME.test(key) ? ".[redacted]" : segment)
    .replace(/\["([^"]+)"\]/gu, (segment, key) => SENSITIVE_NAME.test(key) ? '["[redacted]"]' : segment);
}

function normalizeHeaderNames(value) {
  const input = value === undefined ? ["content-type"] : value;
  if (!Array.isArray(input) || input.length > 50) throw new TypeError("headerNames must be an array of at most 50 header names");
  const names = new Set();
  for (const name of input) {
    if (typeof name !== "string" || !HEADER_NAME.test(name)) throw new TypeError("headerNames contains an invalid header name");
    const normalized = name.toLowerCase();
    if (SENSITIVE_NAME.test(normalized) || normalized === "set-cookie") throw new TypeError("Sensitive response headers cannot be captured in a regression baseline");
    if (names.has(normalized)) throw new TypeError("headerNames cannot contain duplicates");
    names.add(normalized);
  }
  return [...names].sort();
}

function validateResponse(response) {
  if (!isRecord(response)) throw new TypeError("response must be a plain API Request Engine response object");
  assertJsonSafe(response, "response", { maximumDepth: 28, maximumNodes: 50000 });
  if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new TypeError("response.status must be a valid HTTP status code");
  }
  if (typeof response.method !== "string" || !/^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/u.test(response.method)) {
    throw new TypeError("response.method must be a supported uppercase HTTP method");
  }
  if (typeof response.url !== "string" || response.url.length > 4096) throw new TypeError("response.url must be a bounded URL string");
  let url;
  try { url = new URL(response.url); } catch { throw new TypeError("response.url must be an absolute URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new TypeError("response.url must be a credential-free HTTP(S) URL");
  if (!isRecord(response.headers ?? {})) throw new TypeError("response.headers must be a plain object");
  for (const value of Object.values(response.headers ?? {})) {
    if (typeof value !== "string") throw new TypeError("response header values must be strings");
  }
  if (response.jsonParsed !== undefined && typeof response.jsonParsed !== "boolean") throw new TypeError("response.jsonParsed must be boolean when provided");
  const jsonParsed = response.jsonParsed === true;
  if (jsonParsed) assertJsonSafe(response.json, "response.json");
  if (response.durationMs !== undefined && (!Number.isFinite(response.durationMs) || response.durationMs < 0 || response.durationMs > 86400000)) {
    throw new TypeError("response.durationMs must be a non-negative finite duration up to 24 hours");
  }
  return { url, jsonParsed, headers: response.headers ?? {} };
}

function validateOptions(options, allowed, label) {
  if (!isRecord(options)) throw new TypeError(label + " must be a plain object");
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new TypeError(label + " contains an unsupported field: " + key);
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) {
    const output = {};
    for (const key of Object.keys(value)) output[key] = cloneJson(value[key]);
    return output;
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function validateBaseline(baseline) {
  if (!isRecord(baseline)) throw new ApiRegressionError("INVALID_BASELINE", "baseline must be a plain versioned baseline object");
  try { assertJsonSafe(baseline, "baseline", { maximumDepth: 28, maximumNodes: 50000 }); }
  catch (error) { throw new ApiRegressionError("INVALID_BASELINE", error.message); }
  const allowed = new Set(["schema", "engineId", "engineVersion", "baselineId", "capturedAt", "request", "status", "headers", "json", "durationMs", "policy"]);
  if (Object.keys(baseline).some((key) => !allowed.has(key)) || baseline.schema !== API_REGRESSION_BASELINE_SCHEMA ||
      baseline.engineId !== API_REGRESSION_ENGINE_ID || baseline.engineVersion !== API_REGRESSION_ENGINE_VERSION) {
    throw new ApiRegressionError("UNSUPPORTED_BASELINE", "baseline schema or engine version is not supported");
  }
  if (typeof baseline.baselineId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(baseline.baselineId) ||
      typeof baseline.capturedAt !== "string" || !Number.isFinite(Date.parse(baseline.capturedAt)) ||
      !Number.isSafeInteger(baseline.status) || baseline.status < 100 || baseline.status > 599 ||
      !isRecord(baseline.request) || typeof baseline.request.method !== "string" || !/^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/u.test(baseline.request.method) ||
      typeof baseline.request.endpointHash !== "string" || !/^[a-f0-9]{64}$/u.test(baseline.request.endpointHash) ||
      !Array.isArray(baseline.headers) || !isRecord(baseline.json) || !isRecord(baseline.policy)) {
    throw new ApiRegressionError("INVALID_BASELINE", "baseline is missing required fields or contains invalid values");
  }
  if (baseline.durationMs !== null && (!Number.isFinite(baseline.durationMs) || baseline.durationMs < 0)) {
    throw new ApiRegressionError("INVALID_BASELINE", "baseline durationMs must be null or a non-negative finite number");
  }
  if (Object.keys(baseline.request).some((key) => !["method", "endpointHash"].includes(key))) {
    throw new ApiRegressionError("INVALID_BASELINE", "baseline request identity contains unsupported fields");
  }
  const policyKeys = new Set(["headerNames", "ignoredJsonPaths", "valuePaths"]);
  if (Object.keys(baseline.policy).some((key) => !policyKeys.has(key)) ||
      !Array.isArray(baseline.policy.headerNames) || !Array.isArray(baseline.policy.ignoredJsonPaths) || !Array.isArray(baseline.policy.valuePaths)) {
    throw new ApiRegressionError("INVALID_BASELINE", "baseline policy is invalid");
  }
  let headerNames;
  let ignoredJsonPaths;
  let valuePaths;
  try {
    headerNames = normalizeHeaderNames(baseline.policy.headerNames);
    ignoredJsonPaths = normalizePathList(baseline.policy.ignoredJsonPaths, "baseline.policy.ignoredJsonPaths", { allowWildcard: true, allowSensitive: true });
    valuePaths = normalizePathList(baseline.policy.valuePaths, "baseline.policy.valuePaths", { maximum: 50 });
  } catch (error) {
    throw new ApiRegressionError("INVALID_BASELINE", error.message);
  }
  if (JSON.stringify(headerNames) !== JSON.stringify(baseline.policy.headerNames) ||
      JSON.stringify(ignoredJsonPaths) !== JSON.stringify(baseline.policy.ignoredJsonPaths) ||
      JSON.stringify(valuePaths) !== JSON.stringify(baseline.policy.valuePaths)) {
    throw new ApiRegressionError("INVALID_BASELINE", "baseline policy values must use their canonical normalized order");
  }
  if (baseline.headers.length > 50) throw new ApiRegressionError("INVALID_BASELINE", "baseline contains too many response headers");
  const seenHeaders = new Set();
  for (const header of baseline.headers) {
    if (!isRecord(header) || Object.keys(header).some((key) => !["name", "valueHash"].includes(key)) ||
        typeof header.name !== "string" || !HEADER_NAME.test(header.name) || header.name !== header.name.toLowerCase() ||
        SENSITIVE_NAME.test(header.name) || typeof header.valueHash !== "string" || !/^[a-f0-9]{64}$/u.test(header.valueHash) ||
        seenHeaders.has(header.name) || !headerNames.includes(header.name)) {
      throw new ApiRegressionError("INVALID_BASELINE", "baseline contains an invalid header fingerprint");
    }
    seenHeaders.add(header.name);
  }
  if (Object.keys(baseline.json).some((key) => !["parsed", "shape", "valueHashes"].includes(key)) ||
      typeof baseline.json.parsed !== "boolean" || !Array.isArray(baseline.json.shape) || !Array.isArray(baseline.json.valueHashes) ||
      baseline.json.valueHashes.length !== valuePaths.length || (!baseline.json.parsed && baseline.json.shape.length !== 0)) {
    throw new ApiRegressionError("INVALID_BASELINE", "baseline JSON fingerprint is invalid");
  }
  const shapeKeys = new Set();
  for (const entry of baseline.json.shape) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !["path", "type"].includes(key)) ||
        typeof entry.path !== "string" || !["null", "array", "object", "string", "number", "integer", "boolean"].includes(entry.type)) {
      throw new ApiRegressionError("INVALID_BASELINE", "baseline contains an invalid JSON shape entry");
    }
    try { parsePath(entry.path, { allowWildcard: true, allowSensitive: true }); }
    catch (error) { throw new ApiRegressionError("INVALID_BASELINE", error.message); }
    const key = entry.path + "\u0000" + entry.type;
    if (shapeKeys.has(key)) throw new ApiRegressionError("INVALID_BASELINE", "baseline contains duplicate JSON shape entries");
    shapeKeys.add(key);
  }
  const seenValuePaths = new Set();
  for (const entry of baseline.json.valueHashes) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !["path", "found", "valueHash"].includes(key)) ||
        typeof entry.path !== "string" || typeof entry.found !== "boolean" ||
        (entry.found && (typeof entry.valueHash !== "string" || !/^[a-f0-9]{64}$/u.test(entry.valueHash))) ||
        (!entry.found && entry.valueHash !== null) || !valuePaths.includes(entry.path) || seenValuePaths.has(entry.path)) {
      throw new ApiRegressionError("INVALID_BASELINE", "baseline contains an invalid selected JSON value fingerprint");
    }
    seenValuePaths.add(entry.path);
  }
  return baseline;
}

export function createApiRegressionEngine() {
  function createBaseline(response, options = {}) {
    validateOptions(options, new Set(["baselineId", "capturedAt", "headerNames", "ignoredJsonPaths", "valuePaths"]), "baseline options");
    const normalized = validateResponse(response);
    const baselineId = options.baselineId ?? "default";
    if (typeof baselineId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(baselineId)) {
      throw new TypeError("baselineId must be a stable identifier of at most 128 characters");
    }
    const capturedAt = options.capturedAt ?? new Date().toISOString();
    if (typeof capturedAt !== "string" || !Number.isFinite(Date.parse(capturedAt))) throw new TypeError("capturedAt must be a valid date-time string");

    const headerNames = normalizeHeaderNames(options.headerNames);
    const ignoredJsonPaths = normalizePathList(options.ignoredJsonPaths, "ignoredJsonPaths", { allowWildcard: true, allowSensitive: true });
    const valuePaths = normalizePathList(options.valuePaths, "valuePaths", { maximum: 50 });
    const headerLookup = new Map(Object.entries(normalized.headers).map(([name, value]) => [name.toLowerCase(), value]));
    const headers = headerNames.filter((name) => headerLookup.has(name)).map((name) => ({ name, valueHash: hash(headerLookup.get(name)) }));

    const json = normalized.jsonParsed
      ? {
          parsed: true,
          shape: collectShape(response.json, ignoredJsonPaths),
          valueHashes: valuePaths.map((path) => {
            const result = getPath(response.json, path);
            return { path, found: result.found, valueHash: result.found ? hash(JSON.stringify(canonicalize(result.value))) : null };
          })
        }
      : { parsed: false, shape: [], valueHashes: valuePaths.map((path) => ({ path, found: false, valueHash: null })) };

    return deepFreeze({
      schema: API_REGRESSION_BASELINE_SCHEMA,
      engineId: API_REGRESSION_ENGINE_ID,
      engineVersion: API_REGRESSION_ENGINE_VERSION,
      baselineId,
      capturedAt,
      request: { method: response.method, endpointHash: hash(response.method + " " + normalized.url.toString()) },
      status: response.status,
      headers,
      json,
      durationMs: Number.isFinite(response.durationMs) ? response.durationMs : null,
      policy: { headerNames, ignoredJsonPaths, valuePaths }
    });
  }

  function compare(baselineInput, response, options = {}) {
    validateOptions(options, new Set(["maxLatencyIncreaseMs", "maxLatencyIncreasePercent"]), "comparison options");
    const baseline = validateBaseline(baselineInput);
    const normalized = validateResponse(response);
    for (const key of ["maxLatencyIncreaseMs", "maxLatencyIncreasePercent"]) {
      const value = options[key];
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1000000)) {
        throw new TypeError(key + " must be a finite number between 0 and 1000000");
      }
    }

    const checks = [];
    const add = (id, status, code, message, details = undefined) => {
      const check = { id, status, code, message };
      if (details !== undefined) check.details = details;
      checks.push(check);
    };

    const endpointHash = hash(response.method + " " + normalized.url.toString());
    add("endpoint", response.method === baseline.request.method && endpointHash === baseline.request.endpointHash ? "passed" : "failed",
      "ENDPOINT_CHANGED", response.method === baseline.request.method && endpointHash === baseline.request.endpointHash
        ? "HTTP method and endpoint match the baseline" : "HTTP method or endpoint differs from the baseline");
    add("status", response.status === baseline.status ? "passed" : "failed", "HTTP_STATUS_CHANGED",
      response.status === baseline.status ? "HTTP status matches the baseline" : "HTTP status differs from the baseline",
      { expected: baseline.status, actual: response.status });

    const currentHeaderLookup = new Map(Object.entries(normalized.headers).map(([name, value]) => [name.toLowerCase(), value]));
    const baselineHeaderLookup = new Map(baseline.headers.map((item) => [item.name, item.valueHash]));
    for (const name of baseline.policy.headerNames) {
      const currentPresent = currentHeaderLookup.has(name);
      const baselinePresent = baselineHeaderLookup.has(name);
      const currentHash = currentPresent ? hash(currentHeaderLookup.get(name)) : null;
      const expectedHash = baselinePresent ? baselineHeaderLookup.get(name) : null;
      const equal = currentPresent === baselinePresent && (!currentPresent || currentHash === expectedHash);
      add("header:" + name, equal ? "passed" : "failed", currentPresent ? "HEADER_CHANGED" : "HEADER_MISSING",
        equal ? "Selected response header matches the baseline" : "Selected response header is missing or changed",
        { header: name, baselinePresent, currentPresent });
    }

    if (normalized.jsonParsed !== baseline.json.parsed) {
      add("json:parse", "failed", "JSON_PARSE_STATE_CHANGED", "Response JSON parse state differs from the baseline",
        { baselineParsed: baseline.json.parsed, currentParsed: normalized.jsonParsed });
    } else if (normalized.jsonParsed) {
      const currentShape = collectShape(response.json, baseline.policy.ignoredJsonPaths);
      const keyOf = (entry) => entry.path + "\u0000" + entry.type;
      const expected = new Map(baseline.json.shape.map((entry) => [keyOf(entry), entry]));
      const actual = new Map(currentShape.map((entry) => [keyOf(entry), entry]));
      const added = [...actual.values()].filter((entry) => !expected.has(keyOf(entry)));
      const removed = [...expected.values()].filter((entry) => !actual.has(keyOf(entry)));
      add("json:shape", added.length === 0 && removed.length === 0 ? "passed" : "failed", "JSON_SHAPE_CHANGED",
        added.length === 0 && removed.length === 0 ? "JSON structure and value types match the baseline" : "JSON structure or value types differ from the baseline",
        { added: added.slice(0, 100).map((entry) => ({ path: safeReportPath(entry.path), type: entry.type })),
          removed: removed.slice(0, 100).map((entry) => ({ path: safeReportPath(entry.path), type: entry.type })),
          addedCount: added.length, removedCount: removed.length });

      for (const expectedValue of baseline.json.valueHashes) {
        const current = getPath(response.json, expectedValue.path);
        const currentHash = current.found ? hash(JSON.stringify(canonicalize(current.value))) : null;
        const equal = current.found === expectedValue.found && (!current.found || currentHash === expectedValue.valueHash);
        add("json:value:" + expectedValue.path, equal ? "passed" : "failed", current.found ? "JSON_VALUE_CHANGED" : "JSON_VALUE_MISSING",
          equal ? "Selected JSON value matches the baseline fingerprint" : "Selected JSON value is missing or changed",
          { path: safeReportPath(expectedValue.path), baselinePresent: expectedValue.found, currentPresent: current.found });
      }
    } else {
      add("json:shape", "skipped", "JSON_NOT_AVAILABLE", "JSON shape comparison skipped because the response is not parsed JSON");
    }

    const latencyConfigured = options.maxLatencyIncreaseMs !== undefined || options.maxLatencyIncreasePercent !== undefined;
    if (!latencyConfigured || baseline.durationMs === null || !Number.isFinite(response.durationMs)) {
      add("latency", "skipped", "LATENCY_THRESHOLD_NOT_CONFIGURED", "Latency comparison requires a baseline duration and an explicit threshold");
    } else {
      const increaseMs = response.durationMs - baseline.durationMs;
      const increasePercent = baseline.durationMs === 0
        ? (increaseMs > 0 ? Infinity : 0)
        : (increaseMs / baseline.durationMs) * 100;
      const overMs = options.maxLatencyIncreaseMs !== undefined && increaseMs > options.maxLatencyIncreaseMs;
      const overPercent = options.maxLatencyIncreasePercent !== undefined && increasePercent > options.maxLatencyIncreasePercent;
      const failed = overMs || overPercent;
      add("latency", failed ? "failed" : "passed", "LATENCY_REGRESSION",
        failed ? "Response latency exceeded a configured regression threshold" : "Response latency is within configured regression thresholds",
        { baselineMs: baseline.durationMs, currentMs: response.durationMs,
          increaseMs: Math.round(increaseMs * 100) / 100,
          increasePercent: Number.isFinite(increasePercent) ? Math.round(increasePercent * 100) / 100 : null });
    }

    const failedCount = checks.filter((check) => check.status === "failed").length;
    const passedCount = checks.filter((check) => check.status === "passed").length;
    const skippedCount = checks.filter((check) => check.status === "skipped").length;
    return deepFreeze({
      engineId: API_REGRESSION_ENGINE_ID,
      engineVersion: API_REGRESSION_ENGINE_VERSION,
      baselineId: baseline.baselineId,
      status: failedCount > 0 ? "regression" : "passed",
      passed: failedCount === 0,
      failedCount,
      passedCount,
      skippedCount,
      passRate: checks.length === 0 ? 1 : Math.round((passedCount / (checks.length - skippedCount)) * 10000) / 10000,
      checks
    });
  }

  function compile(baselineInput) {
    const baseline = deepFreeze(cloneJson(validateBaseline(baselineInput)));
    return Object.freeze({
      baselineId: baseline.baselineId,
      compare: (response, options) => compare(baseline, response, options)
    });
  }

  return Object.freeze({
    engineId: API_REGRESSION_ENGINE_ID,
    version: API_REGRESSION_ENGINE_VERSION,
    createBaseline,
    compare,
    compile
  });
}
