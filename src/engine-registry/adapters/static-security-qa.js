import { ENGINE_VERSION } from "../../core/version.js";
import { createAuditEngineRegistry } from "../../audit-engines/index.js";

const ADAPTER_ID = "jb.static-security-qa-engine";
const MAX_FINDINGS = 25;
const SCAN_LIMITS = Object.freeze({
  maxFiles: 2500,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 20_000_000,
  maxDepth: 20
});
const CAPABILITIES = Object.freeze([
  "static-security-analysis",
  "secret-pattern-detection",
  "dependency-risk-analysis",
  "security-defense-rules",
  "read-only"
]);
const SEVERITIES = Object.freeze(["critical", "high", "medium", "low", "info"]);

export const STATIC_SECURITY_QA_ADAPTER_ID = ADAPTER_ID;
export const STATIC_SECURITY_QA_ADAPTER_VERSION = ENGINE_VERSION;
export const STATIC_SECURITY_QA_ADAPTER_CAPABILITIES = CAPABILITIES;

export class StaticSecurityQaAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StaticSecurityQaAdapterError";
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
    throw new StaticSecurityQaAdapterError("INVALID_RECORD", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (allowedKeys && !allowedKeys.has(key))) {
      throw new StaticSecurityQaAdapterError("UNSUPPORTED_FIELD", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new StaticSecurityQaAdapterError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function validateScanOptions(value) {
  if (value === undefined) return Object.freeze({});
  const options = readRecord(value, "scanOptions", new Set(Object.keys(SCAN_LIMITS)));
  for (const [key, maximum] of Object.entries(SCAN_LIMITS)) {
    if (!Object.hasOwn(options, key)) continue;
    const number = options[key];
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
      throw new StaticSecurityQaAdapterError(
        "INVALID_SCAN_LIMIT",
        "scanOptions." + key + " must be an integer between 1 and " + maximum
      );
    }
  }
  return Object.freeze({ ...options });
}

function validateCommand(value) {
  const command = readRecord(value, "command", new Set(["path", "productionOnly", "scanOptions"]));
  if (typeof command.path !== "string" || !command.path.trim() ||
      command.path.trim().length > 4096 || /[\u0000-\u001f\u007f]/.test(command.path)) {
    throw new StaticSecurityQaAdapterError(
      "INVALID_TARGET",
      "command.path must be a valid non-empty project directory path"
    );
  }
  if (Object.hasOwn(command, "productionOnly") && typeof command.productionOnly !== "boolean") {
    throw new StaticSecurityQaAdapterError("INVALID_SCOPE", "command.productionOnly must be a boolean");
  }
  return Object.freeze({
    path: command.path.trim(),
    productionOnly: command.productionOnly ?? false,
    scanOptions: validateScanOptions(command.scanOptions)
  });
}

function validateExecutionOptions(value) {
  const options = readRecord(value ?? {}, "execution options", new Set(["signal"]));
  if (!Object.hasOwn(options, "signal")) return options;
  const signal = options.signal;
  if (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function") {
    throw new StaticSecurityQaAdapterError("INVALID_SIGNAL", "execution options.signal must be an AbortSignal");
  }
  return options;
}

function textLimit(value, maximum) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function summarizeReport(report) {
  const scoring = report?.scoring ?? {};
  const summary = report?.summary ?? {};
  const assessment = report?.securityAssessment ?? {};
  const scan = report?.projectScan ?? {};
  const advisories = report?.dependencyAdvisories ?? {};
  const diagnostics = Array.isArray(report?.diagnostics) ? report.diagnostics : [];
  const severityCounts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));

  for (const item of diagnostics) {
    if (SEVERITIES.includes(item?.severity)) severityCounts[item.severity] += 1;
  }

  // Evidence, recommendations and metadata are intentionally omitted. Those
  // structures may contain source-derived text and are not needed for routing.
  const findings = diagnostics.slice(0, MAX_FINDINGS).map((item) => Object.freeze({
    id: textLimit(item?.id, 180),
    specialist: textLimit(item?.specialist, 80),
    ruleId: textLimit(item?.ruleId, 140),
    severity: SEVERITIES.includes(item?.severity) ? item.severity : "info",
    title: textLimit(item?.title, 180),
    description: textLimit(item?.description, 240),
    location: textLimit(item?.location, 240),
    status: textLimit(item?.status, 24)
  }));

  return Object.freeze({
    adapter: ADAPTER_ID,
    readOnly: true,
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
      rulesExecuted: Number.isSafeInteger(summary.rulesExecuted) ? summary.rulesExecuted : 0,
      rulesWithErrors: Number.isSafeInteger(summary.rulesWithErrors) ? summary.rulesWithErrors : 0,
      findings: diagnostics.length,
      specialists: Object.freeze(
        Array.isArray(summary.specialists)
          ? summary.specialists.filter((item) => typeof item === "string").slice(0, 24)
          : []
      ),
      bySeverity: Object.freeze(severityCounts)
    }),
    securityAssessment: Object.freeze({
      mode: textLimit(assessment.mode, 32),
      scope: textLimit(assessment.scope, 40),
      complete: assessment.complete === true,
      excludedNonProductionFiles: Number.isSafeInteger(assessment.excludedNonProductionFiles)
        ? assessment.excludedNonProductionFiles : 0,
      incompleteReasons: Object.freeze(
        Array.isArray(assessment.incompleteReasons)
          ? assessment.incompleteReasons.filter((item) => typeof item === "string").slice(0, 12)
          : []
      ),
      networkRequests: Number.isSafeInteger(assessment.networkRequests) ? assessment.networkRequests : 0,
      onlineDependencyAdvisories: assessment.onlineDependencyAdvisories === true,
      databaseConnections: Number.isSafeInteger(assessment.databaseConnections)
        ? assessment.databaseConnections : 0,
      projectCodeExecuted: assessment.projectCodeExecuted === true,
      credentialContentsRead: assessment.credentialContentsRead === true
    }),
    projectScan: Object.freeze({
      filesRead: Number.isSafeInteger(scan.filesRead) ? scan.filesRead : 0,
      totalBytes: Number.isSafeInteger(scan.totalBytes) ? scan.totalBytes : 0,
      packageManifests: Number.isSafeInteger(scan.packageManifests) ? scan.packageManifests : 0,
      lockFiles: Number.isSafeInteger(scan.lockFiles) ? scan.lockFiles : 0,
      environmentFiles: Number.isSafeInteger(scan.environmentFiles) ? scan.environmentFiles : 0,
      sensitiveFiles: Number.isSafeInteger(scan.sensitiveFiles) ? scan.sensitiveFiles : 0,
      oversizedFiles: Number.isSafeInteger(scan.oversizedFiles) ? scan.oversizedFiles : 0,
      unreadableFiles: Number.isSafeInteger(scan.unreadableFiles) ? scan.unreadableFiles : 0,
      skippedSymlinks: Number.isSafeInteger(scan.skippedSymlinks) ? scan.skippedSymlinks : 0,
      truncated: scan.truncated === true
    }),
    dependencyAdvisories: Object.freeze({
      enabled: advisories.enabled === true,
      status: textLimit(advisories.status, 32),
      packagesDiscovered: Number.isSafeInteger(advisories.packagesDiscovered) ? advisories.packagesDiscovered : 0,
      packagesQueried: Number.isSafeInteger(advisories.packagesQueried) ? advisories.packagesQueried : 0,
      vulnerabilitiesFound: Number.isSafeInteger(advisories.vulnerabilitiesFound) ? advisories.vulnerabilitiesFound : 0,
      networkRequests: Number.isSafeInteger(advisories.networkRequests) ? advisories.networkRequests : 0
    }),
    findings: Object.freeze(findings),
    findingsTruncated: diagnostics.length > MAX_FINDINGS
  });
}

/**
 * Wraps the canonical local-static Security Auditor. Dependency advisory
 * lookups are forced off and the adapter fails closed if the native report
 * ever indicates external requests or database access.
 */
export function createStaticSecurityQaEngineAdapter() {
  const auditRegistry = createAuditEngineRegistry();

  async function run(input, executionOptions = {}) {
    const command = validateCommand(input);
    const options = validateExecutionOptions(executionOptions);
    if (options.signal?.aborted) {
      const error = new Error("Static Security QA was cancelled before the filesystem audit started");
      error.name = "AbortError";
      throw error;
    }

    const report = await auditRegistry.run(
      "security",
      { path: command.path },
      {
        onlineAdvisories: false,
        productionOnly: command.productionOnly,
        scanOptions: command.scanOptions
      }
    );

    if (report?.securityAssessment?.onlineDependencyAdvisories === true ||
        report?.securityAssessment?.networkRequests > 0 ||
        report?.securityAssessment?.databaseConnections > 0 ||
        report?.securityAssessment?.projectCodeExecuted === true ||
        report?.securityAssessment?.credentialContentsRead === true) {
      throw new StaticSecurityQaAdapterError(
        "UNSAFE_AUDIT_BEHAVIOR",
        "Static Security QA refuses a report that violates its offline, read-only execution boundary"
      );
    }

    return summarizeReport(report);
  }

  return Object.freeze({
    id: ADAPTER_ID,
    name: "Static Security QA Engine",
    version: ENGINE_VERSION,
    category: "security",
    targetType: "path",
    executionMode: "in-process",
    capabilities: CAPABILITIES,
    description: "Read-only local static security audit; no project-code execution, credential-content reads, database connections or external advisory lookups.",
    run
  });
}

/** Registers the trusted static security adapter without scanning a project. */
export function registerStaticSecurityQaEngine(registry) {
  if (!isPlainRecord(registry)) {
    throw new StaticSecurityQaAdapterError("INVALID_REGISTRY", "A JB QA engine registry instance is required");
  }
  for (const key of ["register", "has"]) {
    const descriptor = Object.getOwnPropertyDescriptor(registry, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new StaticSecurityQaAdapterError("INVALID_REGISTRY", "Registry must expose trusted register() and has() methods");
    }
  }

  const adapter = createStaticSecurityQaEngineAdapter();
  if (registry.has(adapter.id)) {
    throw new StaticSecurityQaAdapterError("DUPLICATE_ENGINE", "Static Security QA Engine is already registered");
  }
  return registry.register(adapter);
}
