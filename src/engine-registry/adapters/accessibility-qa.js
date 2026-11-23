import { ENGINE_VERSION } from "../../core/version.js";
import { redactSensitiveText } from "../../core/redaction.js";
import { auditUrl } from "../../adapters/playwright/audit-url.js";

const ADAPTER_ID = "jb.accessibility-qa-engine";
const MAX_FINDINGS = 30;
const MAX_URL_LENGTH = 2048;
const MAX_TIMEOUT_MS = 30000;
const SEVERITIES = Object.freeze(["critical", "high", "medium", "low", "info"]);
const CAPABILITIES = Object.freeze([
  "wcag-automated-audit",
  "axe-core",
  "image-alternative-text",
  "programmatic-form-labels",
  "document-language",
  "heading-hierarchy",
  "same-origin-browser-audit"
]);

export const ACCESSIBILITY_QA_ADAPTER_ID = ADAPTER_ID;
export const ACCESSIBILITY_QA_ADAPTER_VERSION = ENGINE_VERSION;
export const ACCESSIBILITY_QA_ADAPTER_CAPABILITIES = CAPABILITIES;

export class AccessibilityQaAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AccessibilityQaAdapterError";
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
    throw new AccessibilityQaAdapterError("INVALID_RECORD", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (allowedKeys && !allowedKeys.has(key))) {
      throw new AccessibilityQaAdapterError("UNSUPPORTED_FIELD", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new AccessibilityQaAdapterError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
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
    throw new AccessibilityQaAdapterError(
      "INVALID_TARGET",
      "command.url must be a valid absolute HTTP(S) URL"
    );
  }

  let parsed;
  try {
    parsed = new URL(command.url.trim());
  } catch {
    throw new AccessibilityQaAdapterError("INVALID_TARGET", "command.url must be a valid absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new AccessibilityQaAdapterError("UNSUPPORTED_PROTOCOL", "Only HTTP and HTTPS targets are supported");
  }
  if (parsed.username || parsed.password) {
    throw new AccessibilityQaAdapterError("EMBEDDED_CREDENTIALS", "URLs containing embedded credentials are not allowed");
  }

  const timeout = command.timeout ?? 20000;
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > MAX_TIMEOUT_MS) {
    throw new AccessibilityQaAdapterError(
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
    throw new AccessibilityQaAdapterError("INVALID_SIGNAL", "execution options.signal must be an AbortSignal");
  }
  return options;
}

function finiteInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function safeText(value, maximum) {
  return typeof value === "string"
    ? redactSensitiveText(value).slice(0, maximum)
    : "";
}

function safeIdentifier(value) {
  return typeof value === "string"
    ? value.replace(/[^a-z0-9._-]/gi, "-").slice(0, 120)
    : "";
}

function summarizeReport(report) {
  const scoring = report?.scoring ?? {};
  const summary = report?.summary ?? {};
  const evidence = report?.evidence ?? {};
  const diagnostics = Array.isArray(report?.diagnostics) ? report.diagnostics : [];
  const severityCounts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));

  for (const item of diagnostics) {
    if (SEVERITIES.includes(item?.severity)) severityCounts[item.severity] += 1;
  }

  // Findings deliberately omit selectors, locations, evidence, recommendations,
  // target URLs, page titles and runtime error text.
  const findings = diagnostics.slice(0, MAX_FINDINGS).map((item) => Object.freeze({
    id: safeIdentifier(item?.id),
    severity: SEVERITIES.includes(item?.severity) ? item.severity : "info",
    title: safeText(item?.title, 180),
    description: safeText(item?.description, 240),
    affectedNodes: finiteInteger(item?.evidence?.affectedNodes)
  }));

  const axeCompleted = evidence.axeScanCompleted === true &&
    Number.isSafeInteger(evidence.axeViolations) && evidence.axeViolations >= 0;
  const specialistScopeValid = Array.isArray(summary.specialists) &&
    summary.specialists.length === 1 && summary.specialists[0] === "accessibility";
  const ruleErrors = finiteInteger(summary.rulesWithErrors);
  const complete = axeCompleted && specialistScopeValid && ruleErrors === 0;

  return Object.freeze({
    adapter: ADAPTER_ID,
    mode: "passive-accessibility-browser-audit",
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
      rulesWithErrors: ruleErrors,
      findings: diagnostics.length,
      bySeverity: Object.freeze({ ...severityCounts })
    }),
    axeCore: Object.freeze({
      completed: axeCompleted,
      violations: axeCompleted ? evidence.axeViolations : null
    }),
    browserAssessment: Object.freeze({
      sameOriginOnly: evidence.sameOriginOnly === true,
      blockedRequests: finiteInteger(evidence.blockedRequests),
      pageErrors: finiteInteger(evidence.pageErrors),
      interactionExploration: false,
      dnsRevalidatedBeforeEachHttpRequest:
        evidence.networkDnsPolicy?.dnsRevalidatedBeforeEachHttpRequest === true,
      browserConnectionDnsPinned:
        evidence.networkDnsPolicy?.browserConnectionDnsPinned === true
    }),
    findings: Object.freeze(findings),
    findingsTruncated: diagnostics.length > MAX_FINDINGS,
    limitations: Object.freeze([
      "axe-core automates only the rules it can evaluate; manual keyboard, screen-reader, content-quality and usability review remains necessary.",
      "The audit covers one loaded page and does not crawl linked routes or test authenticated states.",
      "Only same-origin HTTP(S) requests are allowed; cross-origin resources and cross-origin redirects are blocked and may affect rendering.",
      "Page JavaScript runs during normal navigation, but the adapter does not explore controls, submit forms, or interact with the page.",
      "Browser connection-time DNS is not pinned to the address validated by the URL guard."
    ])
  });
}

function assertAuditContract(report) {
  if (!report || report.evidence?.sameOriginOnly !== true ||
      report.evidence?.axeScanCompleted !== true ||
      !Array.isArray(report.summary?.specialists) ||
      report.summary.specialists.length !== 1 ||
      report.summary.specialists[0] !== "accessibility" ||
      !Array.isArray(report.execution)) {
    throw new AccessibilityQaAdapterError(
      "UNSAFE_AUDIT_RESULT",
      "Accessibility QA refuses a browser report that does not match its isolated Axe and specialist-scope contract"
    );
  }
}

/**
 * Wraps the canonical Playwright/axe-core accessibility specialist.
 * Public destinations only, same-origin network access, no authentication,
 * screenshots, interaction exploration or user-overridable browser options.
 */
export function createAccessibilityQaEngineAdapter() {
  async function run(input, executionOptions = {}) {
    const command = validateCommand(input);
    const options = validateExecutionOptions(executionOptions);
    if (options.signal?.aborted) {
      const error = new Error("Accessibility QA was cancelled before browser startup");
      error.name = "AbortError";
      throw error;
    }

    let report;
    try {
      report = await auditUrl(command.url, {
        specialist: "accessibility",
        timeout: command.timeout,
        headless: true,
        runAxe: true,
        allowPrivateNetworks: false,
        sameOriginOnly: true,
        interactionExploration: false,
        viewport: { width: 1365, height: 900 }
      });
    } catch {
      // Browser and DNS exceptions may contain the submitted URL or query data.
      throw new AccessibilityQaAdapterError(
        "AUDIT_FAILED",
        "Accessibility QA could not safely complete the isolated browser audit"
      );
    }

    assertAuditContract(report);
    return summarizeReport(report);
  }

  return Object.freeze({
    id: ADAPTER_ID,
    name: "Accessibility QA Engine",
    version: ENGINE_VERSION,
    category: "accessibility",
    targetType: "url",
    executionMode: "browser",
    capabilities: CAPABILITIES,
    description: "Isolated Playwright and axe-core accessibility audit using the canonical accessibility specialist; public destinations, same-origin requests only, no authenticated session or interaction exploration.",
    run
  });
}

/** Registers the trusted accessibility adapter without navigating to a URL. */
export function registerAccessibilityQaEngine(registry) {
  if (!isPlainRecord(registry)) {
    throw new AccessibilityQaAdapterError("INVALID_REGISTRY", "A JB QA engine registry instance is required");
  }
  for (const key of ["register", "has"]) {
    const descriptor = Object.getOwnPropertyDescriptor(registry, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new AccessibilityQaAdapterError("INVALID_REGISTRY", "Registry must expose trusted register() and has() methods");
    }
  }

  const adapter = createAccessibilityQaEngineAdapter();
  if (registry.has(adapter.id)) {
    throw new AccessibilityQaAdapterError("DUPLICATE_ENGINE", "Accessibility QA Engine is already registered");
  }
  return registry.register(adapter);
}
