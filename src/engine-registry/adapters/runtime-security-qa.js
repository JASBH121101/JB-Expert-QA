import { ENGINE_VERSION } from "../../core/version.js";
import { auditSecurityUrl } from "../../adapters/filesystem/audit-security-url.js";

const ADAPTER_ID = "jb.runtime-security-qa-engine";
const MAX_FINDINGS = 25;
const MAX_URL_LENGTH = 2048;
const SEVERITIES = Object.freeze(["critical", "high", "medium", "low", "info"]);
const CAPABILITIES = Object.freeze([
  "runtime-security-analysis",
  "transport-security-observation",
  "security-header-audit",
  "cookie-attribute-audit",
  "mixed-content-observation",
  "passive-browser-observation"
]);

export const RUNTIME_SECURITY_QA_ADAPTER_ID = ADAPTER_ID;
export const RUNTIME_SECURITY_QA_ADAPTER_VERSION = ENGINE_VERSION;
export const RUNTIME_SECURITY_QA_ADAPTER_CAPABILITIES = CAPABILITIES;

export class RuntimeSecurityQaAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RuntimeSecurityQaAdapterError";
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
    throw new RuntimeSecurityQaAdapterError("INVALID_RECORD", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (allowedKeys && !allowedKeys.has(key))) {
      throw new RuntimeSecurityQaAdapterError("UNSUPPORTED_FIELD", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new RuntimeSecurityQaAdapterError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
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
    throw new RuntimeSecurityQaAdapterError(
      "INVALID_TARGET",
      "command.url must be a valid absolute HTTP(S) URL"
    );
  }

  let parsed;
  try {
    parsed = new URL(command.url.trim());
  } catch {
    throw new RuntimeSecurityQaAdapterError("INVALID_TARGET", "command.url must be a valid absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new RuntimeSecurityQaAdapterError("UNSUPPORTED_PROTOCOL", "Only HTTP and HTTPS targets are supported");
  }
  if (parsed.username || parsed.password) {
    throw new RuntimeSecurityQaAdapterError("EMBEDDED_CREDENTIALS", "URLs containing embedded credentials are not allowed");
  }

  const timeout = command.timeout ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 60000) {
    throw new RuntimeSecurityQaAdapterError(
      "INVALID_TIMEOUT",
      "command.timeout must be an integer between 1000 and 60000 milliseconds"
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
    throw new RuntimeSecurityQaAdapterError("INVALID_SIGNAL", "execution options.signal must be an AbortSignal");
  }
  return options;
}

function finiteInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function textLimit(value, maximum) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function summarizeReport(report) {
  const scoring = report?.scoring ?? {};
  const summary = report?.summary ?? {};
  const assessment = report?.runtimeAssessment ?? {};
  const policy = assessment.networkDnsPolicy ?? {};
  const diagnostics = Array.isArray(report?.diagnostics) ? report.diagnostics : [];
  const severityCounts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));

  for (const item of diagnostics) {
    if (SEVERITIES.includes(item?.severity)) severityCounts[item.severity] += 1;
  }

  // Do not expose diagnostic IDs (cookie IDs can embed response cookie names),
  // evidence, recommendations, metadata, target URLs, or blocked request URLs.
  const findings = diagnostics.slice(0, MAX_FINDINGS).map((item) => Object.freeze({
    ruleId: textLimit(item?.ruleId, 140),
    specialist: textLimit(item?.specialist, 80),
    severity: SEVERITIES.includes(item?.severity) ? item.severity : "info",
    title: textLimit(item?.title, 180),
    description: textLimit(item?.description, 240)
  }));

  return Object.freeze({
    adapter: ADAPTER_ID,
    mode: "passive-browser-observation",
    engine: textLimit(report?.engine, 100),
    version: textLimit(report?.version, 32),
    generatedAt: textLimit(report?.generatedAt, 40),
    scoring: Object.freeze({
      score: Number.isFinite(scoring.score) ? scoring.score : null,
      minimumScore: Number.isFinite(scoring.minimumScore) ? scoring.minimumScore : null,
      passed: scoring.passed === true,
      blockedByCritical: scoring.blockedByCritical === true,
      blockedByExecutionErrors: scoring.blockedByExecutionErrors === true
    }),
    summary: Object.freeze({
      rulesExecuted: finiteInteger(summary.rulesExecuted),
      rulesWithErrors: finiteInteger(summary.rulesWithErrors),
      findings: diagnostics.length,
      specialists: Object.freeze(
        Array.isArray(summary.specialists)
          ? summary.specialists.filter((item) => typeof item === "string").slice(0, 16)
          : []
      ),
      bySeverity: Object.freeze({ ...severityCounts })
    }),
    target: Object.freeze({
      status: Number.isInteger(report?.target?.status) &&
        report.target.status >= 100 && report.target.status <= 599
        ? report.target.status : null,
      initialHttps: typeof report?.target?.initialUrl === "string" &&
        report.target.initialUrl.startsWith("https://"),
      finalHttps: typeof report?.target?.finalUrl === "string" &&
        report.target.finalUrl.startsWith("https://")
    }),
    runtimeAssessment: Object.freeze({
      requestsMadeByAuditor: assessment.requestsMadeByAuditor === true,
      exploitPayloadsSent: assessment.exploitPayloadsSent === true,
      authenticatedSessionUsed: assessment.authenticatedSessionUsed === true,
      databaseConnections: finiteInteger(assessment.databaseConnections),
      blockedRequests: Array.isArray(assessment.blockedRequests)
        ? assessment.blockedRequests.length : 0,
      mixedContentRequests: finiteInteger(assessment.mixedContentRequests),
      cookieValuesReported: assessment.cookieValuesReported === true,
      networkDnsPolicy: Object.freeze({
        dnsRevalidatedBeforeEachHttpRequest: policy.dnsRevalidatedBeforeEachHttpRequest === true,
        browserConnectionDnsPinned: policy.browserConnectionDnsPinned === true,
        redirectHopsFullyInspected: policy.redirectHopsFullyInspected === true
      })
    }),
    findings: Object.freeze(findings),
    findingsTruncated: diagnostics.length > MAX_FINDINGS,
    limitations: Object.freeze([
      "The auditor loads the supplied page normally and observes its main-document response; it does not attempt exploitation.",
      "It does not authenticate, submit forms, crawl linked pages, or test role-based access controls.",
      "DNS is revalidated before intercepted HTTP requests, but Chromium connection-time DNS is not pinned by this auditor.",
      "Playwright does not expose each intermediate redirect hop to this route handler for independent validation.",
      "Only headers and cookies visible on the main-document response are assessed; other API and subresource responses are not comprehensively audited."
    ])
  });
}

function assertSafeAuditReport(report) {
  const assessment = report?.runtimeAssessment;
  const policy = assessment?.networkDnsPolicy;
  if (!assessment || !policy ||
      assessment.requestsMadeByAuditor !== true ||
      assessment.exploitPayloadsSent !== false ||
      assessment.authenticatedSessionUsed !== false ||
      assessment.databaseConnections !== 0 ||
      assessment.cookieValuesReported !== false ||
      policy.dnsRevalidatedBeforeEachHttpRequest !== true ||
      policy.browserConnectionDnsPinned !== false ||
      policy.redirectHopsFullyInspected !== false ||
      !Array.isArray(assessment.blockedRequests)) {
    throw new RuntimeSecurityQaAdapterError(
      "UNSAFE_AUDIT_BEHAVIOR",
      "Runtime Security QA refuses a report that does not match the canonical passive-audit safety contract"
    );
  }
}

/**
 * Wraps the canonical Runtime Security Auditor. Private/reserved destinations
 * remain blocked. Private-network access, authenticated sessions, exploit
 * requests, custom browser settings and custom network guards are not exposed.
 */
export function createRuntimeSecurityQaEngineAdapter() {
  async function run(input, executionOptions = {}) {
    const command = validateCommand(input);
    const options = validateExecutionOptions(executionOptions);
    if (options.signal?.aborted) {
      const error = new Error("Runtime Security QA was cancelled before browser startup");
      error.name = "AbortError";
      throw error;
    }

    let report;
    try {
      report = await auditSecurityUrl(command.url, {
        timeout: command.timeout,
        headless: true,
        allowPrivateNetworks: false
      });
    } catch {
      // URL, DNS, browser and network errors can contain the submitted URL.
      // Keep the public error generic so query tokens and credentials do not leak.
      throw new RuntimeSecurityQaAdapterError(
        "AUDIT_FAILED",
        "Runtime Security QA could not safely complete the passive browser audit"
      );
    }

    assertSafeAuditReport(report);
    return summarizeReport(report);
  }

  return Object.freeze({
    id: ADAPTER_ID,
    name: "Runtime Security QA Engine",
    version: ENGINE_VERSION,
    category: "security",
    targetType: "url",
    executionMode: "browser",
    capabilities: CAPABILITIES,
    description: "Passive browser observation of HTTPS, security headers, authentication-cookie attributes and mixed content; public destinations only, no authenticated session or exploit payloads.",
    run
  });
}

/** Registers the trusted runtime security adapter without making network requests. */
export function registerRuntimeSecurityQaEngine(registry) {
  if (!isPlainRecord(registry)) {
    throw new RuntimeSecurityQaAdapterError("INVALID_REGISTRY", "A JB QA engine registry instance is required");
  }
  for (const key of ["register", "has"]) {
    const descriptor = Object.getOwnPropertyDescriptor(registry, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new RuntimeSecurityQaAdapterError("INVALID_REGISTRY", "Registry must expose trusted register() and has() methods");
    }
  }

  const adapter = createRuntimeSecurityQaEngineAdapter();
  if (registry.has(adapter.id)) {
    throw new RuntimeSecurityQaAdapterError("DUPLICATE_ENGINE", "Runtime Security QA Engine is already registered");
  }
  return registry.register(adapter);
}
