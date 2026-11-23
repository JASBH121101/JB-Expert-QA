const ENGINE_ID = "jb.api-rate-limit-testing-engine";
const ENGINE_VERSION = "0.1.0";
const REPORT_SCHEMA = "jb.api-rate-limit-report/v1";
const INPUT_SCHEMA = "jb.api-rate-limit-test/v1";
const MIN_SAMPLES = 2;
const MAX_SAMPLES = 20;
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 10000;
const MAX_RETRY_AFTER_SECONDS = 86400;
const RATE_LIMIT_REMAINING_HEADERS = [
  "ratelimit-remaining",
  "x-ratelimit-remaining",
  "x-rate-limit-remaining"
];
const RATE_LIMIT_LIMIT_HEADERS = [
  "ratelimit-limit",
  "x-ratelimit-limit",
  "x-rate-limit-limit"
];
const RATE_LIMIT_RESET_HEADERS = [
  "ratelimit-reset",
  "x-ratelimit-reset",
  "x-rate-limit-reset"
];

export const API_RATE_LIMIT_TESTING_ENGINE_ID = ENGINE_ID;
export const API_RATE_LIMIT_TESTING_ENGINE_VERSION = ENGINE_VERSION;
export const API_RATE_LIMIT_TEST_SCHEMA = INPUT_SCHEMA;
export const API_RATE_LIMIT_REPORT_SCHEMA = REPORT_SCHEMA;

export class ApiRateLimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiRateLimitError";
    this.code = code;
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainData(value, label, allowedKeys) {
  if (!isPlainRecord(value)) throw new TypeError(label + " must be a plain object");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new TypeError(label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " cannot contain accessors");
    }
  }
}

function validateSignal(signal) {
  if (signal === undefined || signal === null) return;
  if (typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function") {
    throw new TypeError("options.signal must be an AbortSignal");
  }
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(label + " must be an integer between " + minimum + " and " + maximum);
  }
  return value;
}

function normalizeProbe(input) {
  assertPlainData(input, "probe", new Set([
    "schema", "probeId", "version", "request", "samples", "intervalMs", "stopOnThrottle"
  ]));
  if (input.schema !== INPUT_SCHEMA) throw new ApiRateLimitError("INVALID_SCHEMA", "Unsupported API rate-limit test schema");
  if (typeof input.probeId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.probeId)) {
    throw new TypeError("probe.probeId must be a stable identifier of at most 64 characters");
  }
  if (typeof input.version !== "string" || !/^\d+\.\d+\.\d+$/.test(input.version)) {
    throw new TypeError("probe.version must use stable MAJOR.MINOR.PATCH form");
  }

  assertPlainData(input.request, "probe.request", new Set(["method", "url", "headers"]));
  const method = typeof input.request.method === "string" ? input.request.method.trim().toUpperCase() : "";
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    throw new ApiRateLimitError("UNSAFE_METHOD", "Rate-limit probes only support GET, HEAD and OPTIONS");
  }
  if (typeof input.request.url !== "string" || input.request.url.length > 4096) {
    throw new TypeError("probe.request.url must be an absolute HTTP(S) URL");
  }
  let url;
  try { url = new URL(input.request.url); } catch {
    throw new TypeError("probe.request.url must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new ApiRateLimitError("UNSAFE_URL", "Probe URL must use HTTP(S) without credentials or fragments");
  }
  for (const key of url.searchParams.keys()) {
    if (/auth|token|secret|password|credential|api[-_]?key|signature/i.test(key)) {
      throw new ApiRateLimitError("SENSITIVE_QUERY", "Credential-like query parameters are not allowed in rate-limit probes");
    }
  }

  const headers = input.request.headers === undefined ? undefined : input.request.headers;
  if (headers !== undefined) {
    assertPlainData(headers, "probe.request.headers", new Set(Object.keys(headers)));
    const entries = Object.entries(headers);
    if (entries.length > 30) throw new TypeError("probe.request.headers exceeds the 30-header limit");
    for (const [name, value] of entries) {
      if (!name.trim() || typeof value !== "string" || value.length > 4096 || /[\r\n\0]/.test(value)) {
        throw new TypeError("Probe headers must have non-empty names and safe string values");
      }
    }
  }

  const samples = input.samples === undefined ? 3 : boundedInteger(input.samples, "probe.samples", MIN_SAMPLES, MAX_SAMPLES);
  const intervalMs = input.intervalMs === undefined
    ? 1000
    : boundedInteger(input.intervalMs, "probe.intervalMs", MIN_INTERVAL_MS, MAX_INTERVAL_MS);
  const stopOnThrottle = input.stopOnThrottle === undefined ? true : input.stopOnThrottle;
  if (typeof stopOnThrottle !== "boolean") throw new TypeError("probe.stopOnThrottle must be a boolean");

  const request = { method, url: url.toString() };
  if (headers !== undefined) request.headers = { ...headers };
  return Object.freeze({
    probeId: input.probeId,
    version: input.version,
    request: Object.freeze(request),
    samples,
    intervalMs,
    stopOnThrottle
  });
}

function validateResponse(response) {
  if (!isPlainRecord(response)) throw new ApiRateLimitError("INVALID_RESPONSE", "Request Engine returned an invalid response");
  const statusDescriptor = Object.getOwnPropertyDescriptor(response, "status");
  const headersDescriptor = Object.getOwnPropertyDescriptor(response, "headers");
  const durationDescriptor = Object.getOwnPropertyDescriptor(response, "durationMs");
  const bytesDescriptor = Object.getOwnPropertyDescriptor(response, "bytesReceived");
  if (!statusDescriptor || !Object.hasOwn(statusDescriptor, "value") ||
      !Number.isSafeInteger(statusDescriptor.value) || statusDescriptor.value < 100 || statusDescriptor.value > 599) {
    throw new ApiRateLimitError("INVALID_RESPONSE", "Request Engine returned an invalid HTTP status");
  }
  if (headersDescriptor && !Object.hasOwn(headersDescriptor, "value")) {\n    throw new ApiRateLimitError("INVALID_RESPONSE", "Response headers cannot be an accessor");\n  }\n  const headers = headersDescriptor?.value ?? {};
  if (!isPlainRecord(headers)) throw new ApiRateLimitError("INVALID_RESPONSE", "Request Engine returned invalid response headers");
  const normalizedHeaders = new Map();
  for (const key of Reflect.ownKeys(headers)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(headers, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") {
      throw new ApiRateLimitError("INVALID_RESPONSE", "Response headers cannot contain accessors or non-string values");
    }
    normalizedHeaders.set(key.toLowerCase(), descriptor.value);
  }
  const durationMs = durationDescriptor && Object.hasOwn(durationDescriptor, "value") &&
    Number.isFinite(durationDescriptor.value) && durationDescriptor.value >= 0
    ? Math.round(durationDescriptor.value) : null;
  const bytesReceived = bytesDescriptor && Object.hasOwn(bytesDescriptor, "value") &&
    Number.isSafeInteger(bytesDescriptor.value) && bytesDescriptor.value >= 0
    ? bytesDescriptor.value : null;
  return {
    status: statusDescriptor.value,
    durationMs,
    bytesReceived,
    headers: normalizedHeaders
  };
}

function headerValue(headers, candidates) {
  for (const name of candidates) {
    if (headers.has(name)) return headers.get(name);
  }
  return null;
}

function numericHeader(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= MAX_RETRY_AFTER_SECONDS ? number : null;
}

function retryAfterSeconds(value) {
  const seconds = numericHeader(value);
  if (seconds !== null) return Math.ceil(seconds);
  if (typeof value !== "string" || !value.trim()) return null;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  const delta = Math.ceil((date - Date.now()) / 1000);
  return delta >= 0 && delta <= MAX_RETRY_AFTER_SECONDS ? delta : null;
}

function detectRateLimit(sample) {
  const remainingRaw = headerValue(sample.headers, RATE_LIMIT_REMAINING_HEADERS);
  const limitRaw = headerValue(sample.headers, RATE_LIMIT_LIMIT_HEADERS);
  const resetRaw = headerValue(sample.headers, RATE_LIMIT_RESET_HEADERS);
  const retryRaw = headerValue(sample.headers, ["retry-after"]);
  const remaining = numericHeader(remainingRaw);
  const limit = numericHeader(limitRaw);
  const resetSeconds = numericHeader(resetRaw);
  const retrySeconds = retryAfterSeconds(retryRaw);
  const throttled = sample.status === 429 || remaining === 0;
  return {
    throttled,
    remaining,
    limit,
    resetSeconds,
    retryAfterSeconds: retrySeconds,
    hasRetryAfter: retryRaw !== null
  };
}

function wait(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new ApiRateLimitError("REQUEST_ABORTED", "Rate-limit probe was cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    function done() {
      cleanup();
      resolve();
    }
    function abort() {
      cleanup();
      reject(new ApiRateLimitError("REQUEST_ABORTED", "Rate-limit probe was cancelled"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function makeReport(probe, samples, status, errorCode = null, attemptedRequests = samples.length) {
  const durations = samples.map((item) => item.durationMs).filter((value) => value !== null);
  const last = samples.at(-1);
  const signals = [];
  if (samples.some((item) => item.status === 429)) signals.push("http-429");
  if (samples.some((item) => item.remaining === 0)) signals.push("rate-limit-remaining-zero");
  if (samples.some((item) => item.retryAfterSeconds !== null)) signals.push("retry-after-observed");
  if (samples.some((item) => item.limit !== null)) signals.push("rate-limit-limit-observed");

  const checks = [
    { id: "request-budget", status: "passed", observed: samples.length, expected: probe.samples },
    { id: "sequential-execution", status: "passed", detail: "Requests were executed one at a time" },
    {
      id: "throttle-observed",
      status: signals.includes("http-429") || signals.includes("rate-limit-remaining-zero") ? "passed" : "warning",
      detail: signals.includes("http-429") || signals.includes("rate-limit-remaining-zero")
        ? "A rate-limit response or zero remaining quota was observed"
        : "No explicit throttle signal was observed within the configured sample budget"
    },
    {
      id: "retry-after",
      status: samples.some((item) => item.retryAfterSeconds !== null) ? "passed" : "warning",
      detail: samples.some((item) => item.retryAfterSeconds !== null)
        ? "A valid Retry-After value was normalized to seconds"
        : "No valid Retry-After value was observed"
    }
  ];

  const report = {
    schema: REPORT_SCHEMA,
    engineId: ENGINE_ID,
    engineVersion: ENGINE_VERSION,
    probeId: probe.probeId,
    version: probe.version,
    status,
    request: { method: probe.request.method, origin: new URL(probe.request.url).origin },
    requestedSamples: probe.samples,
    sentRequests: attemptedRequests,
    completedResponses: samples.length,
    intervalMs: probe.intervalMs,
    stopOnThrottle: probe.stopOnThrottle,
    throttled: signals.includes("http-429") || signals.includes("rate-limit-remaining-zero"),
    signals,
    summary: {
      minDurationMs: durations.length ? Math.min(...durations) : null,
      maxDurationMs: durations.length ? Math.max(...durations) : null,
      averageDurationMs: durations.length
        ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length)
        : null,
      lastStatus: last?.status ?? null,
      lastRemaining: last?.remaining ?? null,
      lastLimit: last?.limit ?? null,
      lastResetSeconds: last?.resetSeconds ?? null,
      retryAfterSeconds: [...samples].reverse().find((item) => item.retryAfterSeconds !== null)?.retryAfterSeconds ?? null
    },
    samples: samples.map((item, index) => ({
      index: index + 1,
      status: item.status,
      durationMs: item.durationMs,
      bytesReceived: item.bytesReceived,
      remaining: item.remaining,
      limit: item.limit,
      resetSeconds: item.resetSeconds,
      retryAfterSeconds: item.retryAfterSeconds
    })),
    checks
  };
  if (errorCode) report.error = { code: errorCode };
  return Object.freeze({
    ...report,
    request: Object.freeze(report.request),
    signals: Object.freeze(report.signals),
    summary: Object.freeze(report.summary),
    samples: Object.freeze(report.samples.map(Object.freeze)),
    checks: Object.freeze(report.checks.map(Object.freeze)),
    ...(report.error ? { error: Object.freeze(report.error) } : {})
  });
}

/**
 * Runs a small, sequential, read-only rate-limit observation against an endpoint
 * already constrained by the supplied API Request Engine's origin allowlist.
 */
export function createApiRateLimitTestingEngine({ requestEngine, activeTesting = false } = {}) {
  if (!requestEngine || typeof requestEngine.request !== "function") {
    throw new TypeError("requestEngine must expose a request() function");
  }
  if (activeTesting !== true && activeTesting !== false) {
    throw new TypeError("activeTesting must be a boolean");
  }

  function run(input, options = {}) {
    const probe = normalizeProbe(input);
    assertPlainData(options, "options", new Set(["signal"]));
    validateSignal(options.signal);
    if (activeTesting !== true) {
      throw new ApiRateLimitError("ACTIVE_TESTING_DISABLED", "Set activeTesting: true only after authorizing this endpoint for a bounded probe");
    }

    const samples = [];
    if (options.signal?.aborted) return makeReport(probe, samples, "cancelled", "REQUEST_ABORTED");
    try {
      for (let index = 0; index < probe.samples; index += 1) {
        if (options.signal?.aborted) throw new ApiRateLimitError("REQUEST_ABORTED", "Rate-limit probe was cancelled");
        attemptedRequests += 1;\n        const response = await requestEngine.request(probe.request, options.signal ? { signal: options.signal } : {});
        const normalized = validateResponse(response);
        const signals = detectRateLimit(normalized);
        samples.push({ ...normalized, ...signals });
        if (probe.stopOnThrottle && signals.throttled) break;
        if (index < probe.samples - 1) await wait(probe.intervalMs, options.signal);
      }
      const throttled = samples.some((item) => item.throttled);
      return makeReport(probe, samples, throttled ? "throttled" : "completed", null, attemptedRequests);
    } catch (error) {
      const cancelled = options.signal?.aborted || error?.code === "REQUEST_ABORTED";
      const code = cancelled ? "REQUEST_ABORTED" :
        typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "REQUEST_FAILED";
      return makeReport(probe, samples, cancelled ? "cancelled" : "failed", code);
    }
  }

  return Object.freeze({
    engineId: ENGINE_ID,
    version: ENGINE_VERSION,
    activeTesting,
    run
  });
}
