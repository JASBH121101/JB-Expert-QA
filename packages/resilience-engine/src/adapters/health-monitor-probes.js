import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";

const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const PROBE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HTTP_METHODS = new Set(["GET", "HEAD"]);
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_PROBES = 64;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(label + " contains unsupported fields");
}

function normalizeOrigin(value, label) {
  if (typeof value !== "string") throw new TypeError(label + " entries must be URL origins");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(label + " contains an invalid origin");
  }
  if (!["https:", "http:"].includes(parsed.protocol) ||
      parsed.username || parsed.password || parsed.pathname !== "/" ||
      parsed.search || parsed.hash) {
    throw new TypeError(label + " entries must be bare HTTP(S) origins without credentials");
  }
  return parsed.origin;
}

function normalizeHttpProbe(probe, allowedOrigins, insecureHttpOrigins) {
  assertOnlyKeys(
    probe,
    ["id", "serviceId", "type", "required", "timeoutMs", "url", "method", "expectedStatus"],
    "HTTP probe"
  );
  if (typeof probe.url !== "string") throw new TypeError("HTTP probe URL is required");
  let parsed;
  try {
    parsed = new URL(probe.url);
  } catch {
    throw new TypeError("HTTP probe URL is invalid");
  }
  if (!["https:", "http:"].includes(parsed.protocol) ||
      parsed.username || parsed.password || parsed.hash ||
      !allowedOrigins.has(parsed.origin)) {
    throw new TypeError("HTTP probe URL is outside the configured origin allowlist");
  }
  if (parsed.protocol === "http:" &&
      (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) ||
       !insecureHttpOrigins.has(parsed.origin))) {
    throw new TypeError("unencrypted HTTP probes are allowed only for explicitly allowlisted loopback origins");
  }
  const method = probe.method ?? "GET";
  if (!HTTP_METHODS.has(method)) throw new TypeError("HTTP probe method must be GET or HEAD");
  const expectedStatus = probe.expectedStatus ?? [200];
  if (!Array.isArray(expectedStatus) || expectedStatus.length < 1 || expectedStatus.length > 16 ||
      expectedStatus.some((status) => !Number.isSafeInteger(status) || status < 200 || status > 299) ||
      new Set(expectedStatus).size !== expectedStatus.length) {
    throw new TypeError("HTTP expectedStatus must contain unique successful HTTP status codes");
  }
  return Object.freeze({
    id: probe.id,
    serviceId: probe.serviceId,
    type: "http",
    required: probe.required ?? true,
    timeoutMs: probe.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    url: parsed.href,
    method,
    expectedStatus: Object.freeze([...expectedStatus])
  });
}

function normalizeTcpProbe(probe, allowedTcpTargets) {
  assertOnlyKeys(
    probe,
    ["id", "serviceId", "type", "required", "timeoutMs", "host", "port"],
    "TCP probe"
  );
  if (typeof probe.host !== "string" ||
      !/^[A-Za-z0-9.-]{1,253}$/.test(probe.host) ||
      probe.host.startsWith(".") || probe.host.endsWith(".") ||
      !Number.isSafeInteger(probe.port) || probe.port < 1 || probe.port > 65_535) {
    throw new TypeError("TCP probe host or port is invalid");
  }
  const host = probe.host.toLowerCase();
  if (!allowedTcpTargets.has(host + ":" + probe.port)) {
    throw new TypeError("TCP probe target is outside the configured host/port allowlist");
  }
  return Object.freeze({
    id: probe.id,
    serviceId: probe.serviceId,
    type: "tcp",
    required: probe.required ?? true,
    timeoutMs: probe.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    host,
    port: probe.port
  });
}

function normalizeCustomProbe(probe) {
  assertOnlyKeys(
    probe,
    ["id", "serviceId", "type", "required", "timeoutMs", "run"],
    "custom probe"
  );
  if (typeof probe.run !== "function") throw new TypeError("custom probe requires a host-owned read-only run() callback");
  return Object.freeze({
    id: probe.id,
    serviceId: probe.serviceId,
    type: "custom",
    required: probe.required ?? true,
    timeoutMs: probe.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    run: probe.run
  });
}

function validateProbeBase(probe, ids) {
  if (!isRecord(probe)) throw new TypeError("each health probe must be a plain object");
  if (typeof probe.id !== "string" || !PROBE_ID.test(probe.id) || ids.has(probe.id)) {
    throw new TypeError("health probe id is invalid or duplicated");
  }
  if (typeof probe.serviceId !== "string" || !SERVICE_ID.test(probe.serviceId)) {
    throw new TypeError("health probe serviceId is invalid");
  }
  if (probe.required !== undefined && typeof probe.required !== "boolean") {
    throw new TypeError("health probe required flag must be boolean");
  }
  if (probe.timeoutMs !== undefined &&
      (!Number.isSafeInteger(probe.timeoutMs) || probe.timeoutMs < 50 || probe.timeoutMs > MAX_TIMEOUT_MS)) {
    throw new TypeError("health probe timeout must be between 50 and 10000 milliseconds");
  }
  ids.add(probe.id);
}

function probeFailure({ id, type, required, durationMs, reason, statusCode = null }) {
  return Object.freeze({
    id, type, required, healthy: false,
    outcome: reason === "timeout" ? "timed_out" : "failed",
    reason, statusCode, durationMs
  });
}

async function runHttpProbe(probe, fetchImpl) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(null);
      }, probe.timeoutMs);
    });
    const responsePromise = Promise.resolve().then(() => fetchImpl(probe.url, {
      method: probe.method,
      redirect: "manual",
      signal: controller.signal
    }));
    const response = await Promise.race([responsePromise, timeout]);
    if (response === null && timedOut) return { healthy: false, reason: "timeout", statusCode: null };
    if (!response || !Number.isSafeInteger(response.status)) {
      return { healthy: false, reason: "invalid-response", statusCode: null };
    }
    if (response.body && typeof response.body.cancel === "function") {
      void response.body.cancel().catch(() => {});
    }
    if (response.status >= 300 && response.status < 400) {
      return { healthy: false, reason: "redirect-disallowed", statusCode: response.status };
    }
    if (!probe.expectedStatus.includes(response.status)) {
      return { healthy: false, reason: "unexpected-http-status", statusCode: response.status };
    }
    return { healthy: true, reason: null, statusCode: response.status };
  } catch {
    return {
      healthy: false,
      reason: timedOut ? "timeout" : "request-failed",
      statusCode: null
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runTcpProbe(probe) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: probe.host, port: probe.port });
    let settled = false;
    const finish = (healthy, reason) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ healthy, reason, statusCode: null });
    };
    socket.setTimeout(probe.timeoutMs, () => finish(false, "timeout"));
    socket.once("connect", () => finish(true, null));
    socket.once("error", () => finish(false, "connection-failed"));
  });
}

async function runCustomProbe(probe, context) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(null);
      }, probe.timeoutMs);
    });
    const customPromise = Promise.resolve().then(() => probe.run({
      serviceId: probe.serviceId,
      probeId: probe.id,
      observedAt: context.observedAt,
      signal: controller.signal
    }));
    const result = await Promise.race([customPromise, timeout]);
    if (result === null && timedOut) return { healthy: false, reason: "timeout", statusCode: null };
    const healthy = result === true || (isRecord(result) && result.healthy === true);
    return {
      healthy,
      reason: healthy ? null : "custom-check-unhealthy",
      statusCode: null
    };
  } catch {
    return {
      healthy: false,
      reason: timedOut ? "timeout" : "custom-check-failed",
      statusCode: null
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs allowlisted, read-only health probes and feeds their aggregate result
 * into the existing in-memory Health Monitor. It never executes recovery.
 */
export function createHealthMonitorProbeAdapter({
  monitor,
  probes,
  allowedHttpOrigins = [],
  allowInsecureHttpOrigins = [],
  allowedTcpTargets = [],
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  maxConcurrentProbes = 8
} = {}) {
  if (!isRecord(monitor) || typeof monitor.observe !== "function") {
    throw new TypeError("a health monitor with observe() is required");
  }
  if (!Array.isArray(probes) || probes.length < 1 || probes.length > MAX_PROBES) {
    throw new TypeError("between 1 and 64 health probes are required");
  }
  if (!Array.isArray(allowedHttpOrigins) || !Array.isArray(allowInsecureHttpOrigins) ||
      !Array.isArray(allowedTcpTargets)) {
    throw new TypeError("probe allowlists must be arrays");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!Number.isSafeInteger(maxConcurrentProbes) || maxConcurrentProbes < 1 || maxConcurrentProbes > 16) {
    throw new TypeError("maxConcurrentProbes must be between 1 and 16");
  }

  const httpOrigins = new Set(allowedHttpOrigins.map((value) => normalizeOrigin(value, "allowedHttpOrigins")));
  const insecureOrigins = new Set(allowInsecureHttpOrigins.map((value) =>
    normalizeOrigin(value, "allowInsecureHttpOrigins")));
  for (const origin of insecureOrigins) {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) || !httpOrigins.has(origin)) {
      throw new TypeError("allowInsecureHttpOrigins must be a subset of explicitly allowed loopback HTTP origins");
    }
  }

  const tcpTargets = new Set();
  for (const target of allowedTcpTargets) {
    if (typeof target !== "string" || !/^[A-Za-z0-9.-]{1,253}:\d{1,5}$/.test(target)) {
      throw new TypeError("allowedTcpTargets entries must use host:port syntax");
    }
    const separator = target.lastIndexOf(":");
    const host = target.slice(0, separator).toLowerCase();
    const port = Number(target.slice(separator + 1));
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new TypeError("allowedTcpTargets contains an invalid port");
    }
    tcpTargets.add(host + ":" + port);
  }

  const ids = new Set();
  const byService = new Map();
  let activeProbes = 0;
  const probeWaiters = [];

  async function acquireProbeSlot() {
    if (activeProbes < maxConcurrentProbes) {
      activeProbes += 1;
      return;
    }
    // A released slot is transferred directly to the next waiter.
    await new Promise((resolve) => probeWaiters.push(resolve));
  }

  function releaseProbeSlot() {
    const next = probeWaiters.shift();
    if (next) next();
    else activeProbes -= 1;
  }
  for (const candidate of probes) {
    validateProbeBase(candidate, ids);
    const normalized = candidate.type === "http"
      ? normalizeHttpProbe(candidate, httpOrigins, insecureOrigins)
      : candidate.type === "tcp"
        ? normalizeTcpProbe(candidate, tcpTargets)
        : candidate.type === "custom"
          ? normalizeCustomProbe(candidate)
          : null;
    if (!normalized) throw new TypeError("health probe type must be http, tcp or custom");
    if (normalized.timeoutMs < 50 || normalized.timeoutMs > MAX_TIMEOUT_MS) {
      throw new TypeError("health probe timeout must be between 50 and 10000 milliseconds");
    }
    if (!byService.has(normalized.serviceId)) byService.set(normalized.serviceId, []);
    byService.get(normalized.serviceId).push(normalized);
  }
  for (const [serviceId, entries] of byService) {
    if (!entries.some((entry) => entry.required)) {
      throw new TypeError("service " + serviceId + " must have at least one required health probe");
    }
    if (entries.length > 16) throw new RangeError("service " + serviceId + " exceeds the 16-probe limit");
  }

  function readClock() {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("clock must return a non-negative safe integer");
    }
    return now;
  }

  async function executeProbe(probe, observedAt) {
    await acquireProbeSlot();
    const started = performance.now();
    try {
      let result;
      try {
        if (probe.type === "http") {
          result = await runHttpProbe(probe, fetchImpl);
        } else if (probe.type === "tcp") {
          result = await runTcpProbe(probe);
        } else {
          result = await runCustomProbe(probe, { observedAt });
        }
      } catch {
        result = { healthy: false, reason: "probe-failed", statusCode: null };
      }
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      return Object.freeze({
        id: probe.id,
        type: probe.type,
        required: probe.required,
        healthy: result.healthy === true,
        outcome: result.healthy === true ? "healthy" : result.reason === "timeout" ? "timed_out" : "failed",
        reason: result.reason ?? null,
        statusCode: result.statusCode ?? null,
        durationMs
      });
    } finally {
      releaseProbeSlot();
    }
  }

  async function probeService({ serviceId, securityThreatActive = false } = {}) {
    if (typeof serviceId !== "string" || !SERVICE_ID.test(serviceId) || !byService.has(serviceId)) {
      throw new TypeError("serviceId is unknown or invalid for this health probe adapter");
    }
    if (typeof securityThreatActive !== "boolean") {
      throw new TypeError("securityThreatActive must be boolean");
    }
    const entries = byService.get(serviceId);
    const observedAt = readClock();
    const results = new Array(entries.length);
    let nextIndex = 0;
    const workerCount = Math.min(maxConcurrentProbes, entries.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= entries.length) return;
        results[index] = await executeProbe(entries[index], observedAt);
      }
    }));

    const healthy = results.every((result) => !result.required || result.healthy);
    const observation = monitor.observe({ serviceId, healthy, securityThreatActive });
    const failedRequiredProbes = results
      .filter((result) => result.required && !result.healthy)
      .map((result) => result.id);
    return Object.freeze({
      serviceId,
      observedAt,
      healthy,
      securityThreatActive,
      failedRequiredProbes: Object.freeze(failedRequiredProbes),
      probes: Object.freeze(results),
      observation
    });
  }

  function listServiceIds() {
    return Object.freeze([...byService.keys()].sort());
  }

  return Object.freeze({
    probeService,
    listServiceIds,
    probeCount: probes.length,
    serviceCount: byService.size
  });
}
