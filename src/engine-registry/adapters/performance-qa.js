import { ENGINE_VERSION } from "../../core/version.js";
import { redactSensitiveText } from "../../core/redaction.js";
import { auditUrl } from "../../adapters/playwright/audit-url.js";

const ADAPTER_ID = "jb.performance-qa-engine";
const MAX_FINDINGS = 30;
const MAX_URL_LENGTH = 2048;
const MAX_TIMEOUT_MS = 30000;
const SEVERITIES = Object.freeze(["critical", "high", "medium", "low", "info"]);
const CAPABILITIES = Object.freeze([
  "browser-resource-performance-audit",
  "large-transfer-detection",
  "slow-resource-detection",
  "image-dimension-stability",
  "dom-size-analysis",
  "bounded-findings",
  "public-target-url-safety"
]);

export const PERFORMANCE_QA_ADAPTER_ID = ADAPTER_ID;
export const PERFORMANCE_QA_ADAPTER_VERSION = ENGINE_VERSION;
export const PERFORMANCE_QA_ADAPTER_CAPABILITIES = CAPABILITIES;

export class PerformanceQaAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PerformanceQaAdapterError";
    this.code = code;
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRecord(value, label, allowedKeys) {
  if (!isPlainRecord(value)) {
    throw new PerformanceQaAdapterError("INVALID_RECORD", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (allowedKeys && !allowedKeys.has(key))) {
      throw new PerformanceQaAdapterError("UNSUPPORTED_FIELD", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new PerformanceQaAdapterError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function validateCommand(value) {
  const command = readRecord(value, "command", new Set(["url", "timeout"]));
  if (typeof command.url !== "string" || !command.url.trim() ||
      command.url.trim().length > MAX_URL_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(command.url)) {
    throw new PerformanceQaAdapterError(
      "INVALID_TARGET",
      "command.url must be a valid absolute HTTP(S) URL"
    );
  }

  let parsed;
  try {
    parsed = new URL(command.url.trim());
  } catch {
    throw new PerformanceQaAdapterError("INVALID_TARGET", "command.url must be a valid absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new PerformanceQaAdapterError("UNSUPPORTED_PROTOCOL", "Only HTTP and HTTPS targets are supported");
  }
  if (parsed.username || parsed.password) {
    throw new PerformanceQaAdapterError("EMBEDDED_CREDENTIALS", "URLs containing embedded credentials are not allowed");
  }

  const timeout = command.timeout ?? 20000;
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > MAX_TIMEOUT_MS) {
    throw new PerformanceQaAdapterError(
      "INVALID_TIMEOUT",
      "command.timeout must be an integer between 1000 and 30000 milliseconds"
    );
  }

  return Object.freeze({ url: parsed.href, timeout });
}

function validateExecutionOptions(value) {
  const options = readRecord(value ?? {}, "execution options", new Set(["signal"]));
  if (!Object.hasOwn(options, "signal")) return options;
  const signal = options.signal;
  if (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function") {
    throw new PerformanceQaAdapterError("INVALID_SIGNAL", "execution options.signal must be an AbortSignal");
  }
  return options;
}

function finiteInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function finiteMetric(value, maximum = 1_000_000_000) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
    ? Number(value.toFixed(2))
    : null;
}

function safeText(value, maximum) {
  return typeof value === "string" ? redactSensitiveText(value).slice(0, maximum) : "";
}

function safeIdentifier(value) {
  return typeof value === "string" ? value.replace(/[^a-z0-9._-]/gi, "-").slice(0, 120) : "";
}

function summarizeMetric(ruleId, evidence = {}) {
  if (ruleId === "performance.large-transfer") {
    return Object.freeze({
      transferSizeBytes: finiteInteger(evidence.transferSizeBytes, 10_000_000_000),
      initiatorType: safeText(evidence.initiatorType, 32)
    });
  }
  if (ruleId === "performance.slow-resource") {
    return Object.freeze({
      durationMs: finiteMetric(evidence.durationMs, 600_000),
      initiatorType: safeText(evidence.initiatorType, 32)
    });
  }
  if (ruleId === "performance.image-dimensions") {
    return Object.freeze({
      hasWidth: evidence.hasWidth === true,
      hasHeight: evidence.hasHeight === true
    });
  }
  if (ruleId === "performance.large-dom") {
    return Object.freeze({
      domNodeCount: finiteInteger(evidence.domNodeCount, 10_000_000),
      threshold: finiteInteger(evidence.threshold, 10_000_000)
    });
  }
  return Object.freeze({});
}

function summarizeReport(report) {
  const scoring = report?.scoring ?? {};
  const summary = report?.summary ?? {};
  const evidence = report?.evidence ?? {};
  const diagnostics = Array.isArray(report?.diagnostics) ? report.diagnostics : [];
  const severityCounts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  const observations = {
    largeTransfers: 0,
    slowResources: 0,
    imagesWithoutReservedDimensions: 0,
    largeDomTrees: 0,
    observedTransferBytes: 0,
    slowestResourceMs: null,
    largestDomNodeCount: null
  };

  for (const item of diagnostics) {
    if (SEVERITIES.includes(item?.severity)) severityCounts[item.severity] += 1;
    const ruleId = item?.ruleId;
    const metric = item?.evidence ?? {};
    if (ruleId === "performance.large-transfer") {
      observations.largeTransfers += 1;
      const bytes = finiteInteger(metric.transferSizeBytes, 10_000_000_000);
      observations.observedTransferBytes += bytes;
    } else if (ruleId === "performance.slow-resource") {
      observations.slowResources += 1;
      const duration = finiteMetric(metric.durationMs, 600_000);
      if (duration !== null) {
        observations.slowestResourceMs = Math.max(observations.slowestResourceMs ?? 0, duration);
      }
    } else if (ruleId === "performance.image-dimensions") {
      observations.imagesWithoutReservedDimensions += 1;
    } else if (ruleId === "performance.large-dom") {
      observations.largeDomTrees += 1;
      const count = finiteInteger(metric.domNodeCount, 10_000_000);
      observations.largestDomNodeCount = Math.max(observations.largestDomNodeCount ?? 0, count);
    }
  }

  // Do not return URLs, selectors, page titles, raw resource names, stack traces,
  // recommendations containing source context, or unbounded evidence objects.
  const findings = diagnostics.slice(0, MAX_FINDINGS).map((item) => Object.freeze({
    ruleId: safeIdentifier(item?.ruleId),
    severity: SEVERITIES.includes(item?.severity) ? item.severity : "info",
    title: safeText(item?.title, 180),
    description: safeText(item?.description, 240),
    metrics: summarizeMetric(item?.ruleId, item?.evidence)
  }));

  const rulesWithErrors = finiteInteger(summary.rulesWithErrors);
  const specialistScopeValid = Array.isArray(summary.specialists) &&
    summary.specialists.length === 1 && summary.specialists[0] === "performance";
  const networkPolicyValid = evidence.networkDnsPolicy?.dnsRevalidatedBeforeEachHttpRequest === true;
  const complete = specialistScopeValid && rulesWithErrors === 0 &&
    Array.isArray(report?.execution) && report.execution.length > 0 && networkPolicyValid;

  return Object.freeze({
    adapter: ADAPTER_ID,
    mode: "isolated-browser-performance-audit",
    engine: safeText(report?.engine, 100),
    version: safeText(report?.version, 32),
    generatedAt: safeText(report?.generatedAt, 40),
    complete,
    assessmentStatus: complete ? "complete" : "inconclusive",
    scoring: Object.freeze({
      score: Number.isFinite(scoring.score) ? scoring.score : null,
      minimumScore: Number.isFinite(scoring.minimumScore) ? scoring.minimumScore : null,
      scorePassed: scoring.passed === true,
      passed: complete && scoring.passed === true,
      blockedByCritical: scoring.blockedByCritical === true,
      blockedByExecutionErrors: scoring.blockedByExecutionErrors === true
    }),
    summary: Object.freeze({
      rulesExecuted: finiteInteger(summary.rulesExecuted),
      rulesWithErrors,
      findings: diagnostics.length,
      specialists: Object.freeze(["performance"]),
      bySeverity: Object.freeze({ ...severityCounts }),
      observations: Object.freeze({
        ...observations,
        observedTransferBytes: finiteInteger(observations.observedTransferBytes, 100_000_000_000)
      })
    }),
    browserAssessment: Object.freeze({
      sameOriginOnly: evidence.sameOriginOnly === true,
      blockedRequests: finiteInteger(evidence.blockedRequests),
      failedRequests: finiteInteger(evidence.failedRequests),
      httpErrors: finiteInteger(evidence.httpErrors),
      interactionExploration: false,
      screenshotsCaptured: false,
      axeScanCompleted: false,
      dnsRevalidatedBeforeEachHttpRequest: networkPolicyValid,
      browserConnectionDnsPinned: evidence.networkDnsPolicy?.browserConnectionDnsPinned === true
    }),
    findings: Object.freeze(findings),
    findingsTruncated: diagnostics.length > MAX_FINDINGS,
    limitations: Object.freeze([
      "The adapter audits one public page load; it does not crawl routes, authenticate, submit forms, or run concurrency/load stress tests.",
      "Resource metrics come from browser PerformanceResourceTiming entries. Cross-origin transfer-size details can be unavailable unless the resource permits timing access.",
      "Only the canonical performance specialist rules are executed; this is not a full Lighthouse, Core Web Vitals field-data, synthetic network-throttling, or production-capacity assessment.",
      "The URL safety guard revalidates DNS for intercepted HTTP requests, but Chromium connection-time DNS is not pinned to the validated address.",
      "Page JavaScript executes during normal navigation in a fresh, unauthenticated browser context."
    ])
  });
}

function assertAuditContract(report) {
  if (!report || !Array.isArray(report.execution) ||
      !Array.isArray(report.summary?.specialists) ||
      report.summary.specialists.length !== 1 ||
      report.summary.specialists[0] !== "performance" ||
      report.evidence?.networkDnsPolicy?.dnsRevalidatedBeforeEachHttpRequest !== true ||
      report.evidence?.interactionStatesChecked !== 0 ||
      report.evidence?.axeScanCompleted !== false ||
      report.evidence?.screenshotPath !== null) {
    throw new PerformanceQaAdapterError(
      "UNSAFE_AUDIT_RESULT",
      "Performance QA refuses a browser report that does not match its isolated specialist and network-safety contract"
    );
  }
}

/**
 * Wraps the canonical Playwright performance specialist. It performs one
 * unauthenticated page load, accepts public HTTP(S) targets only, applies the
 * existing URL safety guard, and never explores interactions or writes images.
 */
export function createPerformanceQaEngineAdapter({ audit = auditUrl } = {}) {
  if (typeof audit !== "function") {
    throw new PerformanceQaAdapterError("INVALID_AUDITOR", "Performance QA audit implementation must be a function");
  }

  async function run(input, executionOptions = {}) {
    const command = validateCommand(input);
    const options = validateExecutionOptions(executionOptions);
    if (options.signal?.aborted) {
      const error = new Error("Performance QA was cancelled before browser startup");
      error.name = "AbortError";
      throw error;
    }

    let report;
    try {
      report = await audit(command.url, {
        specialist: "performance",
        timeout: command.timeout,
        headless: true,
        runAxe: false,
        allowPrivateNetworks: false,
        sameOriginOnly: false,
        interactionExploration: false,
        screenshotPath: null,
        screenshotFullPage: false,
        viewport: { width: 1365, height: 900 },
        colorScheme: "light"
      });
    } catch {
      // Browser and DNS exceptions may contain submitted URL or query data.
      throw new PerformanceQaAdapterError(
        "AUDIT_FAILED",
        "Performance QA could not safely complete the isolated browser audit"
      );
    }

    assertAuditContract(report);
    return summarizeReport(report);
  }

  return Object.freeze({
    id: ADAPTER_ID,
    name: "Performance QA Engine",
    version: ENGINE_VERSION,
    category: "performance",
    targetType: "url",
    executionMode: "browser",
    capabilities: CAPABILITIES,
    description: "Bounded Playwright performance audit using the canonical performance specialist for large transfers, slow resources, image dimensions and DOM size; public HTTP(S) targets, no authentication, interactions, screenshots or baseline writes.",
    run
  });
}

/** Registers the trusted performance adapter without navigating to a URL. */
export function registerPerformanceQaEngine(registry) {
  if (!isPlainRecord(registry)) {
    throw new PerformanceQaAdapterError("INVALID_REGISTRY", "A JB QA engine registry instance is required");
  }
  for (const key of ["register", "has"]) {
    const descriptor = Object.getOwnPropertyDescriptor(registry, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new PerformanceQaAdapterError("INVALID_REGISTRY", "Registry must expose trusted register() and has() methods");
    }
  }

  const adapter = createPerformanceQaEngineAdapter();
  if (registry.has(adapter.id)) {
    throw new PerformanceQaAdapterError("DUPLICATE_ENGINE", "Performance QA Engine is already registered");
  }
  return registry.register(adapter);
}
