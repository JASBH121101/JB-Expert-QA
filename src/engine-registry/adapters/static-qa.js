import { ENGINE_VERSION } from "../../core/version.js";
import { createAuditEngineRegistry } from "../../audit-engines/index.js";

const ADAPTER_ID = "jb.static-qa-engine";
const MAX_FINDINGS = 25;
const MAX_SCAN_OPTIONS = Object.freeze({
  maxFiles: 2500,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 20_000_000,
  maxDepth: 20
});
const CAPABILITIES = Object.freeze([
  "project-source-audit",
  "dependency-manifest-audit",
  "dead-code-audit",
  "language-audit",
  "read-only"
]);

export const STATIC_QA_ADAPTER_ID = ADAPTER_ID;
export const STATIC_QA_ADAPTER_VERSION = ENGINE_VERSION;
export const STATIC_QA_ADAPTER_CAPABILITIES = CAPABILITIES;

export class StaticQaAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StaticQaAdapterError";
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
    throw new StaticQaAdapterError("INVALID_RECORD", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (allowedKeys && !allowedKeys.has(key))) {
      throw new StaticQaAdapterError("UNSUPPORTED_FIELD", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new StaticQaAdapterError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function validateScanOptions(value) {
  if (value === undefined) return Object.freeze({});
  const options = readRecord(value, "scanOptions", new Set(Object.keys(MAX_SCAN_OPTIONS)));
  for (const [key, max] of Object.entries(MAX_SCAN_OPTIONS)) {
    if (!Object.hasOwn(options, key)) continue;
    const number = options[key];
    if (!Number.isSafeInteger(number) || number < 1 || number > max) {
      throw new StaticQaAdapterError(
        "INVALID_SCAN_LIMIT",
        "scanOptions." + key + " must be an integer between 1 and " + max
      );
    }
  }
  return Object.freeze({ ...options });
}

function validateCommand(value) {
  const command = readRecord(value, "command", new Set(["path", "scanOptions"]));
  if (typeof command.path !== "string" || !command.path.trim() ||
      command.path.trim().length > 4096 || /[\u0000-\u001f\u007f]/.test(command.path)) {
    throw new StaticQaAdapterError("INVALID_TARGET", "command.path must be a valid non-empty project directory path");
  }
  return Object.freeze({
    path: command.path.trim(),
    scanOptions: validateScanOptions(command.scanOptions)
  });
}

function validateExecutionOptions(value) {
  const options = readRecord(value ?? {}, "execution options", new Set(["signal"]));
  if (!Object.hasOwn(options, "signal")) return options;
  const signal = options.signal;
  if (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function") {
    throw new StaticQaAdapterError("INVALID_SIGNAL", "execution options.signal must be an AbortSignal");
  }
  return options;
}

function textLimit(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function summarizeReport(report) {
  const scoring = report?.scoring ?? {};
  const summary = report?.summary ?? {};
  const scope = report?.analysisScope ?? {};
  const diagnostics = Array.isArray(report?.diagnostics) ? report.diagnostics : [];
  const severityCounts = Object.create(null);
  for (const item of diagnostics) {
    if (typeof item?.severity === "string") {
      severityCounts[item.severity] = (severityCounts[item.severity] ?? 0) + 1;
    }
  }

  const findings = diagnostics.slice(0, MAX_FINDINGS).map((item) => Object.freeze({
    id: textLimit(item?.id, 120),
    specialist: textLimit(item?.specialist, 80),
    ruleId: textLimit(item?.ruleId, 120),
    severity: textLimit(item?.severity, 24),
    title: textLimit(item?.title, 180),
    description: textLimit(item?.description, 240),
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
          ? summary.specialists.filter((item) => typeof item === "string").slice(0, 32)
          : []
      ),
      bySeverity: Object.freeze({ ...severityCounts })
    }),
    analysisScope: Object.freeze({
      complete: scope.complete === true,
      filesAnalyzed: Number.isSafeInteger(scope.filesAnalyzed) ? scope.filesAnalyzed : 0,
      sourceFiles: Number.isSafeInteger(scope.sourceFiles) ? scope.sourceFiles : 0,
      assessmentStatus: textLimit(scope.assessmentStatus, 32)
    }),
    dependencyAdvisories: Object.freeze({
      enabled: report?.dependencyAdvisoryLookup === true,
      status: textLimit(report?.dependencyAdvisoryStatus, 32),
      networkRequests: Number.isSafeInteger(report?.networkRequests) ? report.networkRequests : 0
    }),
    findings: Object.freeze(findings),
    findingsTruncated: diagnostics.length > MAX_FINDINGS
  });
}

/**
 * Wraps the canonical local-static auditor in the central engine-adapter contract.
 * It never installs dependencies, executes inspected project code, or enables
 * external dependency-advisory lookups.
 */
export function createStaticQaEngineAdapter() {
  const auditRegistry = createAuditEngineRegistry();

  async function run(input, executionOptions = {}) {
    const command = validateCommand(input);
    const options = validateExecutionOptions(executionOptions);
    if (options.signal?.aborted) {
      const error = new Error("Static QA was cancelled before the filesystem audit started");
      error.name = "AbortError";
      throw error;
    }

    const report = await auditRegistry.run(
      "static",
      { path: command.path },
      { scanOptions: command.scanOptions }
    );

    // Static QA is intentionally offline in this adapter. Fail closed if a
    // future default enables external vulnerability queries unexpectedly.
    if (report?.dependencyAdvisoryLookup === true || report?.networkRequests > 0) {
      throw new StaticQaAdapterError(
        "NETWORK_LOOKUP_DETECTED",
        "Static QA adapter refuses reports that performed external advisory lookups"
      );
    }
    return summarizeReport(report);
  }

  return Object.freeze({
    id: ADAPTER_ID,
    name: "Static QA Engine",
    version: ENGINE_VERSION,
    category: "audit",
    targetType: "path",
    executionMode: "in-process",
    capabilities: CAPABILITIES,
    description: "Read-only local source, dependency-manifest, dead-code and language audit; no source upload, dependency installation or external advisory lookup.",
    run
  });
}

/** Registers the trusted read-only Static QA adapter without invoking its auditor. */
export function registerStaticQaEngine(registry) {
  if (!isPlainRecord(registry)) {
    throw new StaticQaAdapterError("INVALID_REGISTRY", "A JB QA engine registry instance is required");
  }
  for (const key of ["register", "has"]) {
    const descriptor = Object.getOwnPropertyDescriptor(registry, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new StaticQaAdapterError("INVALID_REGISTRY", "Registry must expose trusted register() and has() methods");
    }
  }

  const adapter = createStaticQaEngineAdapter();
  if (registry.has(adapter.id)) {
    throw new StaticQaAdapterError("DUPLICATE_ENGINE", "Static QA Engine is already registered");
  }
  return registry.register(adapter);
}
