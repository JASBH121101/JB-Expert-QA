export function assertFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
}

export function assertPositiveInteger(value, field, max) {
  if (!Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) {
    throw new TypeError(`${field} must be an integer between 1 and ${max ?? "MAX_SAFE_INTEGER"}`);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Bounded per-provider JSON reader:
 * - GET only
 * - timeout and explicit retry-after errors
 * - small in-memory cache to avoid repeated catalogue requests
 * - sequential pacing to avoid bursts against public APIs
 */
export function createJsonReader(fetchImpl, {
  timeoutMs = 12_000,
  cacheTtlMs = 5 * 60_000,
  maxCacheEntries = 40,
  minRequestIntervalMs = 150,
  requestHeaders = {},
  maxlagRetries = 2,
  sleepImpl = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  assertPositiveInteger(timeoutMs, "timeoutMs", 60_000);
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0) throw new TypeError("cacheTtlMs must be a non-negative integer");
  assertPositiveInteger(maxCacheEntries, "maxCacheEntries", 500);
  if (!Number.isSafeInteger(minRequestIntervalMs) || minRequestIntervalMs < 0 || minRequestIntervalMs > 10_000) {
    throw new TypeError("minRequestIntervalMs must be between 0 and 10000");
  }
  if (!Number.isSafeInteger(maxlagRetries) || maxlagRetries < 0 || maxlagRetries > 5) {
    throw new TypeError("maxlagRetries must be an integer between 0 and 5");
  }
  if (typeof sleepImpl !== "function") throw new TypeError("sleepImpl must be a function");
  const cache = new Map();
  let lastRequestAt = 0;

  return async function readJson(url, label, retryCount = 0) {
    const key = String(url);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      cache.delete(key);
      cache.set(key, cached);
      return cloneJson(cached.body);
    }
    if (cached) cache.delete(key);

    const waitMs = Math.max(0, minRequestIntervalMs - (Date.now() - lastRequestAt));
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let rejectTimeout;
    const timeoutPromise = new Promise((resolve, reject) => { rejectTimeout = reject; });
    const timeoutError = new Error(label + " timed out after " + timeoutMs + " ms");
    const timeout = setTimeout(() => {
      controller?.abort();
      rejectTimeout(timeoutError);
    }, timeoutMs);
    let response;
    let body;
    try {
      response = await Promise.race([fetchImpl(key, {
        method: "GET",
        headers: { Accept: "application/json", ...requestHeaders },
        ...(controller ? { signal: controller.signal } : {}),
      }), timeoutPromise]);
      lastRequestAt = Date.now();
      if (!response || response.ok !== true) {
        const status = response?.status ?? "unknown";
        const retryAfter = response?.headers?.get?.("retry-after");
        const suffix = retryAfter ? "; retry after " + retryAfter + " seconds" : "";
        throw new Error(label + " request failed with HTTP " + status + suffix);
      }
      try {
        body = await Promise.race([response.json(), timeoutPromise]);
      } catch {
        if (controller?.signal.aborted) throw timeoutError;
        throw new TypeError(label + " returned invalid JSON");
      }
    } catch (error) {
      if (controller?.signal.aborted || error === timeoutError) throw timeoutError;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TypeError(`${label} returned an invalid JSON object`);
    }
    if (body.error && typeof body.error === "object") {
      const code = String(body.error.code ?? "api_error");
      const info = String(body.error.info ?? "The upstream API rejected the request");
      const retryAfter = Number(body.error.lag);
      if (code === "maxlag" && Number.isFinite(retryAfter)) {
        if (retryCount < maxlagRetries) {
          // Wait for the upstream-reported lag plus a small buffer; never hammer retries.
          const delayMs = Math.min(30_000, Math.max(1_000, Math.ceil(retryAfter * 1_000) + 1_000));
          await sleepImpl(delayMs);
          return readJson(url, label, retryCount + 1);
        }
        throw new Error(`${label} deferred by upstream maxlag (${retryAfter}s) after ${retryCount} retries: ${info}`);
      }
      throw new Error(`${label} returned upstream API error ${code}: ${info}`);
    }
    if (cacheTtlMs > 0) {
      cache.set(key, { body: cloneJson(body), expiresAt: Date.now() + cacheTtlMs });
      while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
    }
    return body;
  };
}

export function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

export function readLimit(value, fallback, maximum) {
  const limit = value ?? fallback;
  assertPositiveInteger(limit, "limit", maximum);
  return limit;
}

export function isoNow(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid date");
  return date.toISOString();
}

