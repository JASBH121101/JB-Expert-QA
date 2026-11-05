import { randomUUID } from "node:crypto";
import { createAuthProtection } from "./auth-protection.js";
import { createAccountRecovery } from "./account-recovery.js";
import { createSecurityHeaders } from "./security-headers.js";
import { configureNodeHttpServer } from "./node-server-hardening.js";
import { createOriginProtection } from "./origin-protection.js";
import { createCsrfProtection } from "./csrf-protection.js";
import { createDistributedRateLimit } from "./distributed-rate-limit.js";
export { createAuthProtection } from "./auth-protection.js";
export { createAccountRecovery, createMemoryRecoveryStore } from "./account-recovery.js";
export { createSecurityHeaders } from "./security-headers.js";
export { configureNodeHttpServer } from "./node-server-hardening.js";
export { createOriginProtection } from "./origin-protection.js";
export { createCsrfProtection } from "./csrf-protection.js";
export { createDistributedRateLimit } from "./distributed-rate-limit.js";

export const SECURITY_GUARD_VERSION = "0.1.0";
export const SECURITY_GUARD_MODES = Object.freeze(["monitor", "balanced", "strict", "custom"]);

const SEVERITY_RANK = Object.freeze({ info: 0, low: 1, medium: 2, high: 3, critical: 4 });
const DEFAULT_BLOCK_SEVERITIES = Object.freeze(["high", "critical"]);
const DEFAULT_MAX_REQUEST_TARGET_LENGTH = 8192;
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_MAX_HEADER_COUNT = 100;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_RATE_LIMIT = Object.freeze({
  enabled: true,
  max: 120,
  windowMs: 60_000,
  maxKeys: 5000
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(name + " must be a positive integer no greater than " + maximum);
  }
  return value;
}

function decodeForInspection(value) {
  let decoded = value;
  for (let index = 0; index < 8; index += 1) {
    try {
      const next = decodeURIComponent(decoded.replace(/\+/g, "%20"));
      if (next === decoded) return { value: decoded, excessive: false, invalidUtf8: false };
      decoded = next;
    } catch {
      return { value: decoded, excessive: false, invalidUtf8: index === 0 };
    }
  }
  return { value: decoded, excessive: /%[0-9a-f]{2}/i.test(decoded), invalidUtf8: false };
}

function rawHeaderValues(request, headerName) {
  const normalizedName = headerName.toLowerCase();
  const values = [];
  if (Array.isArray(request.rawHeaders)) {
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      if (String(request.rawHeaders[index]).toLowerCase() === normalizedName) {
        values.push(String(request.rawHeaders[index + 1] ?? "").trim());
      }
    }
  }
  if (values.length === 0) {
    const normalized = request.headers?.[normalizedName];
    if (Array.isArray(normalized)) return normalized.map((value) => String(value).trim());
    if (normalized !== undefined && normalized !== null) {
      return String(normalized).split(",").map((value) => value.trim());
    }
  }
  return values;
}

function getHeaderMetrics(request) {
  if (Array.isArray(request.rawHeaders)) {
    let bytes = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 1) {
      const value = String(request.rawHeaders[index] ?? "");
      bytes += Buffer.byteLength(value);
    }
    return { count: Math.ceil(request.rawHeaders.length / 2), bytes };
  }

  const headers = isRecord(request.headers) ? Object.entries(request.headers) : [];
  let bytes = 0;
  for (const [name, value] of headers) {
    bytes += Buffer.byteLength(name);
    bytes += Buffer.byteLength(Array.isArray(value) ? value.join(",") : String(value ?? ""));
  }
  return { count: headers.length, bytes };
}

function detectRequestThreats(request, settings) {
  const findings = [];
  const rawTarget = typeof request.url === "string" ? request.url : "/";
  const method = typeof request.method === "string" ? request.method.toUpperCase() : "UNKNOWN";

  if (rawTarget.length > settings.maxRequestTargetLength) {
    findings.push({
      id: "JBG-REQ-001",
      severity: "high",
      reason: "request-target-too-long",
      statusCode: 414
    });
  } else if (/[\u0000-\u001f\u007f]/.test(rawTarget)) {
    findings.push({
      id: "JBG-REQ-002",
      severity: "high",
      reason: "malformed-request-target",
      statusCode: 400
    });
  } else {
    if (/%(?![0-9a-f]{2})/i.test(rawTarget)) {
      findings.push({
        id: "JBG-REQ-003",
        severity: "high",
        reason: "malformed-percent-encoding",
        statusCode: 400
      });
    }

    const decoded = decodeForInspection(rawTarget);
    const inspectedTarget = decoded.value.slice(0, settings.maxRequestTargetLength);
    if (decoded.invalidUtf8) {
      findings.push({
        id: "JBG-REQ-003",
        severity: "high",
        reason: "invalid-url-encoding",
        statusCode: 400
      });
    }
    if (decoded.excessive) {
      findings.push({
        id: "JBG-REQ-005",
        severity: "high",
        reason: "excessive-url-encoding-depth",
        statusCode: 400
      });
    }
    if (/[\u0000-\u001f\u007f]/.test(inspectedTarget)) {
      findings.push({
        id: "JBG-REQ-004",
        severity: "high",
        reason: "encoded-control-character",
        statusCode: 400
      });
    }

    if (/<\s*(?:script|iframe|object|svg)\b|javascript\s*:|data\s*:\s*text\/html|on(?:error|load|click|mouseover)\s*=/i.test(inspectedTarget)) {
      findings.push({
        id: "JBG-XSS-001",
        severity: "high",
        reason: "xss-pattern",
        statusCode: 403
      });
    }

    if (/(?:['"]\s*(?:or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+|\bunion\s+(?:all\s+)?select\b|;\s*(?:drop|alter|truncate)\s+table\b|\b(?:sleep|benchmark)\s*\(\s*\d+)/i.test(inspectedTarget)) {
      findings.push({
        id: "JBG-SQLI-001",
        severity: "high",
        reason: "sql-injection-pattern",
        statusCode: 403
      });
    }

    if (/(?:^|[\\/])\.\.(?:[\\/]|$)|%2e%2e|%00|\u0000/i.test(inspectedTarget)) {
      findings.push({
        id: "JBG-PATH-001",
        severity: "high",
        reason: "path-traversal-pattern",
        statusCode: 403
      });
    }
  }

  const headerMetrics = getHeaderMetrics(request);
  if (headerMetrics.bytes > settings.maxHeaderBytes || headerMetrics.count > settings.maxHeaderCount) {
    findings.push({
      id: "JBG-HTTP-001",
      severity: "medium",
      reason: "request-headers-over-limit",
      statusCode: 431
    });
  }

  const contentLengthValues = rawHeaderValues(request, "content-length");
  const transferEncodingValues = rawHeaderValues(request, "transfer-encoding");
  const hasContentLength = contentLengthValues.length > 0;
  const hasTransferEncoding = transferEncodingValues.length > 0;

  if (Array.isArray(request.rawHeaders) && request.rawHeaders.length % 2 !== 0) {
    findings.push({
      id: "JBG-HTTP-004",
      severity: "high",
      reason: "malformed-raw-header-list",
      statusCode: 400
    });
  }
  if (hasContentLength && hasTransferEncoding) {
    findings.push({
      id: "JBG-HTTP-005",
      severity: "critical",
      reason: "ambiguous-content-length-and-transfer-encoding",
      statusCode: 400
    });
  }
  if (contentLengthValues.length > 1 && new Set(contentLengthValues).size > 1) {
    findings.push({
      id: "JBG-HTTP-006",
      severity: "critical",
      reason: "conflicting-content-length-headers",
      statusCode: 400
    });
  }
  if (transferEncodingValues.length > 1 &&
      new Set(transferEncodingValues.map((value) => value.toLowerCase())).size > 1) {
    findings.push({
      id: "JBG-HTTP-007",
      severity: "high",
      reason: "conflicting-transfer-encoding-headers",
      statusCode: 400
    });
  }

  if (hasContentLength) {
    const normalizedLengths = contentLengthValues.map((value) => value.trim());
    if (normalizedLengths.some((value) => !/^\d+$/.test(value))) {
      findings.push({
        id: "JBG-HTTP-002",
        severity: "high",
        reason: "invalid-content-length",
        statusCode: 400
      });
    } else {
      const distinctLengths = [...new Set(normalizedLengths)];
      if (distinctLengths.length === 1) {
        const contentLength = Number(distinctLengths[0]);
        if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
          findings.push({
            id: "JBG-HTTP-002",
            severity: "high",
            reason: "invalid-content-length",
            statusCode: 400
          });
        } else if (contentLength > settings.maxBodyBytes) {
          findings.push({
            id: "JBG-HTTP-003",
            severity: "high",
            reason: "request-body-over-limit",
            statusCode: 413
          });
        }
      }
    }
  }

  if (method.length > 32 || !/^[A-Z!#$%&'*+.^_`|~-]+$/.test(method)) {
    findings.push({
      id: "JBG-HTTP-004",
      severity: "medium",
      reason: "invalid-http-method",
      statusCode: 400
    });
  }

  return findings;
}

function getDefaultClientKey(request) {
  // Forwarded headers are intentionally ignored unless the integrator supplies
  // a keyGenerator that trusts a specifically configured reverse proxy.
  return String(request.socket?.remoteAddress ?? "unknown").slice(0, 256);
}

function normalizeOptions(options) {
  if (!isRecord(options)) throw new TypeError("Security Guard options must be an object");
  const allowedOptions = new Set([
    "mode", "rateLimit", "maxRequestTargetLength", "maxHeaderBytes",
    "maxHeaderCount", "maxBodyBytes", "blockSeverities", "keyGenerator",
    "onEvent", "includePath", "securityHeaders"
  ]);
  for (const key of Object.keys(options)) {
    if (!allowedOptions.has(key)) throw new TypeError("Unknown Security Guard option: " + key);
  }

  const mode = options.mode ?? "monitor";
  if (!SECURITY_GUARD_MODES.includes(mode)) {
    throw new TypeError("mode must be one of: " + SECURITY_GUARD_MODES.join(", "));
  }

  const rateLimitInput = options.rateLimit ?? {};
  if (!isRecord(rateLimitInput)) throw new TypeError("rateLimit must be an object");
  for (const key of Object.keys(rateLimitInput)) {
    if (!["enabled", "max", "windowMs", "maxKeys"].includes(key)) {
      throw new TypeError("Unknown rateLimit option: " + key);
    }
  }
  const rateLimit = { ...DEFAULT_RATE_LIMIT, ...rateLimitInput };
  if (typeof rateLimit.enabled !== "boolean") throw new TypeError("rateLimit.enabled must be a boolean");
  rateLimit.max = positiveInteger(rateLimit.max, "rateLimit.max", 1_000_000);
  rateLimit.windowMs = positiveInteger(rateLimit.windowMs, "rateLimit.windowMs", 86_400_000);
  rateLimit.maxKeys = positiveInteger(rateLimit.maxKeys, "rateLimit.maxKeys", 100_000);

  const limits = {
    maxRequestTargetLength: positiveInteger(
      options.maxRequestTargetLength ?? DEFAULT_MAX_REQUEST_TARGET_LENGTH,
      "maxRequestTargetLength",
      65_536
    ),
    maxHeaderBytes: positiveInteger(
      options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES,
      "maxHeaderBytes",
      1_048_576
    ),
    maxHeaderCount: positiveInteger(
      options.maxHeaderCount ?? DEFAULT_MAX_HEADER_COUNT,
      "maxHeaderCount",
      10_000
    ),
    maxBodyBytes: positiveInteger(
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      "maxBodyBytes",
      100 * 1024 * 1024
    )
  };

  const blockSeverities = options.blockSeverities ?? (
    mode === "strict" ? ["low", "medium", "high", "critical"] : DEFAULT_BLOCK_SEVERITIES
  );
  if (!Array.isArray(blockSeverities) ||
      blockSeverities.some((severity) => !Object.hasOwn(SEVERITY_RANK, severity)) ||
      new Set(blockSeverities).size !== blockSeverities.length) {
    throw new TypeError("blockSeverities must contain unique supported severity names");
  }

  const keyGenerator = options.keyGenerator ?? getDefaultClientKey;
  if (typeof keyGenerator !== "function") throw new TypeError("keyGenerator must be a function");

  const onEvent = options.onEvent ?? (() => {});
  if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");

  if (options.includePath !== undefined && typeof options.includePath !== "boolean") {
    throw new TypeError("includePath must be a boolean");
  }

  return Object.freeze({
    mode,
    ...limits,
    rateLimit: Object.freeze(rateLimit),
    blockSeverities: Object.freeze([...blockSeverities]),
    keyGenerator,
    onEvent,
    includePath: options.includePath ?? false
  });
}

function safeNotify(onEvent, event) {
  try {
    const result = onEvent(Object.freeze({
      ...event,
      ruleIds: Object.freeze([...event.ruleIds])
    }));
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Logging must never crash or bypass the protected application.
  }
}

export function createSecurityGuard(options = {}) {
  const settings = normalizeOptions(options);
  const securityHeaders = createSecurityHeaders(options.securityHeaders ?? {});
  const rateState = new Map();
  const overflowState = { incidentId: null, alerted: false, windowStartedAt: 0 };
  const counters = {
    requests: 0,
    inspected: 0,
    incidents: 0,
    blocked: 0,
    observed: 0,
    byRule: Object.create(null)
  };

  function getRateLimitFinding(request, now) {
    if (!settings.rateLimit.enabled) return null;

    let clientKey;
    try {
      clientKey = String(settings.keyGenerator(request) ?? "unknown").slice(0, 256);
    } catch {
      clientKey = "unknown";
    }

    let entry = rateState.get(clientKey);
    if (!entry && rateState.size >= settings.rateLimit.maxKeys) {
      // Only scan for expired keys at capacity; never evict a live client's bucket.
      for (const [knownKey, knownEntry] of rateState) {
        if (now - knownEntry.windowStartedAt >= settings.rateLimit.windowMs) {
          rateState.delete(knownKey);
        }
      }
      if (overflowState.incidentId &&
          now - overflowState.windowStartedAt >= settings.rateLimit.windowMs) {
        overflowState.incidentId = null;
        overflowState.alerted = false;
        overflowState.windowStartedAt = 0;
      }
      entry = rateState.get(clientKey);
    }

    if (!entry && rateState.size >= settings.rateLimit.maxKeys) {
      // Identity rotation must not erase accumulated counters. Unknown keys
      // fail closed while the bounded table contains only live buckets.
      if (!overflowState.incidentId) {
        overflowState.incidentId = randomUUID();
        overflowState.windowStartedAt = now;
      }
      return {
        finding: {
          id: "JBG-RATE-002",
          severity: "high",
          reason: "rate-limit-capacity-exceeded",
          statusCode: 429
        },
        shouldEmit: !overflowState.alerted,
        incidentId: overflowState.incidentId,
        markAlerted() { overflowState.alerted = true; }
      };
    }

    if (!entry || now - entry.windowStartedAt >= settings.rateLimit.windowMs) {
      entry = {
        windowStartedAt: now,
        count: 0,
        alerted: false,
        incidentId: null
      };
      rateState.set(clientKey, entry);
    }

    entry.count += 1;
    if (entry.count <= settings.rateLimit.max) return null;

    if (!entry.incidentId) entry.incidentId = randomUUID();
    return {
      finding: {
        id: "JBG-RATE-001",
        severity: "high",
        reason: "rate-limit-exceeded",
        statusCode: 429
      },
      shouldEmit: !entry.alerted,
      incidentId: entry.incidentId,
      markAlerted() { entry.alerted = true; }
    };
  }

  function getStats() {
    return Object.freeze({
      version: SECURITY_GUARD_VERSION,
      mode: settings.mode,
      requests: counters.requests,
      inspected: counters.inspected,
      incidents: counters.incidents,
      blocked: counters.blocked,
      observed: counters.observed,
      rateLimitKeys: rateState.size,
      byRule: Object.freeze({ ...counters.byRule })
    });
  }

  function reset() {
    rateState.clear();
    overflowState.incidentId = null;
    overflowState.alerted = false;
    overflowState.windowStartedAt = 0;
    counters.requests = 0;
    counters.inspected = 0;
    counters.incidents = 0;
    counters.blocked = 0;
    counters.observed = 0;
    for (const key of Object.keys(counters.byRule)) delete counters.byRule[key];
  }

  function middleware(request, response, next) {
    if (!request || !response || typeof next !== "function") {
      throw new TypeError("Security Guard middleware requires (request, response, next)");
    }

    counters.requests += 1;
    counters.inspected += 1;

    const now = Date.now();
    const findings = detectRequestThreats(request, settings);
    const rateLimitResult = getRateLimitFinding(request, now);
    if (rateLimitResult) findings.push(rateLimitResult.finding);

    if (findings.length === 0) {
      next();
      return;
    }

    for (const finding of findings) {
      counters.byRule[finding.id] = (counters.byRule[finding.id] ?? 0) + 1;
    }

    const shouldBlock = settings.mode !== "monitor" &&
      findings.some((finding) => settings.blockSeverities.includes(finding.severity));
    const incidentId = rateLimitResult?.incidentId ?? randomUUID();

    const event = {
      id: incidentId,
      timestamp: new Date(now).toISOString(),
      component: "jb-security-guard",
      action: shouldBlock ? "blocked" : "observed",
      mode: settings.mode,
      severity: findings.reduce((highest, finding) =>
        SEVERITY_RANK[finding.severity] > SEVERITY_RANK[highest] ? finding.severity : highest, "info"),
      ruleIds: findings.map((finding) => finding.id),
      method: typeof request.method === "string" ? request.method.toUpperCase().slice(0, 32) : "UNKNOWN"
    };

    if (settings.includePath && typeof request.url === "string") {
      event.path = request.url.split("?", 1)[0].slice(0, 256);
    }

    const hasNonRateLimitFinding = findings.some((finding) =>
      finding.id !== "JBG-RATE-001" && finding.id !== "JBG-RATE-002"
    );
    const shouldEmitEvent = hasNonRateLimitFinding || !rateLimitResult || rateLimitResult.shouldEmit;
    if (shouldEmitEvent) {
      counters.incidents += 1;
      safeNotify(settings.onEvent, event);
      rateLimitResult?.markAlerted();
    }

    if (!shouldBlock) {
      counters.observed += 1;
      next();
      return;
    }

    counters.blocked += 1;
    const selectedStatus = findings
      .filter((finding) => settings.blockSeverities.includes(finding.severity))
      .sort((left, right) => (right.statusCode === 429 ? 1 : 0) - (left.statusCode === 429 ? 1 : 0))[0]?.statusCode ?? 403;

    if (response.headersSent || response.writableEnded) {
      response.destroy?.();
      return;
    }

    response.statusCode = selectedStatus;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      error: "request_blocked",
      message: "Request rejected by security policy",
      incidentId
    }));

  }

  return Object.freeze({
    middleware,
    securityHeaders: securityHeaders.middleware,
    getStats,
    reset,
    createAuthProtection: (options = {}) => createAuthProtection({
      mode: settings.mode,
      blockSeverities: settings.blockSeverities,
      onEvent: settings.onEvent,
      ...options
    }),
    createAccountRecovery: (options = {}) => createAccountRecovery({
      onEvent: settings.onEvent,
      ...options
    }),
    createOriginProtection: (options = {}) => createOriginProtection({
      onEvent: settings.onEvent,
      ...options
    }),
    createCsrfProtection: (options = {}) => createCsrfProtection({
      onEvent: settings.onEvent,
      ...options
    }),
    createDistributedRateLimit: (options = {}) => createDistributedRateLimit({
      onEvent: settings.onEvent,
      ...options
    })
  });
}
