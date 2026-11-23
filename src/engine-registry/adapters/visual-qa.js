import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { ENGINE_VERSION } from "../../core/version.js";
import { redactSensitiveText } from "../../core/redaction.js";
import { auditViewports, DEFAULT_VIEWPORTS, FULL_VIEWPORTS } from "../../adapters/playwright/audit-url.js";

const ADAPTER_ID = "jb.visual-qa-engine";
const MAX_URL_LENGTH = 2048;
const MAX_TIMEOUT_MS = 30000;
const MAX_FINDINGS = 100;
const MAX_FINDING_TEXT = 280;
const MAX_VIEWPORTS = 9;
const MAX_THEMES = 2;
const SEVERITIES = Object.freeze(["critical", "high", "medium", "low", "info"]);
const CAPABILITIES = Object.freeze([
  "browser-visual-layout-audit",
  "viewport-screenshot-capture",
  "pixel-baseline-comparison",
  "layout-overflow-detection",
  "theme-consistency-observation",
  "bounded-visual-findings",
  "read-only-baseline-comparison"
]);

export const VISUAL_QA_ADAPTER_ID = ADAPTER_ID;
export const VISUAL_QA_ADAPTER_VERSION = ENGINE_VERSION;
export const VISUAL_QA_ADAPTER_CAPABILITIES = CAPABILITIES;
export const VISUAL_QA_LIMITS = Object.freeze({
  maxViewports: MAX_VIEWPORTS,
  maxThemes: MAX_THEMES,
  maxResults: MAX_VIEWPORTS * MAX_THEMES,
  maxFindings: MAX_FINDINGS,
  maxTimeoutMs: MAX_TIMEOUT_MS,
  maxViewportPixels: 33_554_432,
  baselineWrites: false,
  interactionExploration: false,
  aiReview: false
});

export class VisualQaAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VisualQaAdapterError";
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
    throw new VisualQaAdapterError("INVALID_RECORD", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (allowedKeys && !allowedKeys.has(key))) {
      throw new VisualQaAdapterError("UNSUPPORTED_FIELD", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new VisualQaAdapterError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function validateCommand(value) {
  const command = readRecord(value, "command", new Set([
    "url", "matrix", "themes", "timeout", "baselineDir",
    "visualThreshold", "maxDiffPixelRatio", "updateBaselines"
  ]));

  if (typeof command.url !== "string" || !command.url.trim() ||
      command.url.trim().length > MAX_URL_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(command.url)) {
    throw new VisualQaAdapterError("INVALID_TARGET", "command.url must be a valid absolute HTTP(S) URL");
  }

  let parsed;
  try {
    parsed = new URL(command.url.trim());
  } catch {
    throw new VisualQaAdapterError("INVALID_TARGET", "command.url must be a valid absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new VisualQaAdapterError("UNSUPPORTED_PROTOCOL", "Only HTTP and HTTPS targets are supported");
  }
  if (parsed.username || parsed.password) {
    throw new VisualQaAdapterError("EMBEDDED_CREDENTIALS", "URLs containing embedded credentials are not allowed");
  }

  const matrix = command.matrix ?? "default";
  if (!["default", "full"].includes(matrix)) {
    throw new VisualQaAdapterError("INVALID_MATRIX", "matrix must be default or full");
  }
  const viewports = matrix === "full" ? FULL_VIEWPORTS : DEFAULT_VIEWPORTS;

  const suppliedThemes = command.themes ?? ["light"];
  if (!Array.isArray(suppliedThemes) || suppliedThemes.length < 1 || suppliedThemes.length > MAX_THEMES) {
    throw new VisualQaAdapterError("INVALID_THEMES", "themes must contain light, dark, or both without duplicates");
  }
  const themes = [];
  for (let index = 0; index < suppliedThemes.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(suppliedThemes, String(index));
    if (!descriptor) {
      throw new VisualQaAdapterError("INVALID_THEMES", "themes cannot contain sparse entries");
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new VisualQaAdapterError("ACCESSOR_NOT_ALLOWED", "themes cannot contain getters or setters");
    }
    if (!["light", "dark"].includes(descriptor.value) || themes.includes(descriptor.value)) {
      throw new VisualQaAdapterError("INVALID_THEMES", "themes must contain light, dark, or both without duplicates");
    }
    themes.push(descriptor.value);
  }

  const timeout = command.timeout ?? 20000;
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > MAX_TIMEOUT_MS) {
    throw new VisualQaAdapterError("INVALID_TIMEOUT", "command.timeout must be an integer between 1000 and 30000 milliseconds");
  }

  const baselineDir = command.baselineDir ?? null;
  if (baselineDir !== null &&
      (typeof baselineDir !== "string" || !baselineDir.trim() ||
       baselineDir.trim().length > 4096 || !isAbsolute(baselineDir.trim()) ||
       /[\u0000-\u001f\u007f]/.test(baselineDir))) {
    throw new VisualQaAdapterError("INVALID_BASELINE_DIRECTORY", "baselineDir must be an absolute directory path");
  }

  if (command.updateBaselines !== undefined && command.updateBaselines !== false) {
    throw new VisualQaAdapterError("BASELINE_WRITES_DISABLED", "Visual QA adapter does not permit baseline updates");
  }

  const visualThreshold = command.visualThreshold ?? 0.1;
  const maxDiffPixelRatio = command.maxDiffPixelRatio ?? 0.005;
  for (const [name, value] of [["visualThreshold", visualThreshold], ["maxDiffPixelRatio", maxDiffPixelRatio]]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new VisualQaAdapterError("INVALID_VISUAL_THRESHOLD", name + " must be a number between 0 and 1");
    }
  }

  return Object.freeze({
    url: parsed.href,
    matrix,
    viewports,
    themes: Object.freeze(themes),
    timeout,
    baselineDir: baselineDir ? baselineDir.trim() : null,
    visualThreshold,
    maxDiffPixelRatio
  });
}

function validateExecutionOptions(value) {
  const options = readRecord(value ?? {}, "execution options", new Set(["signal"]));
  if (!Object.hasOwn(options, "signal")) return options;
  const signal = options.signal;
  if (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function") {
    throw new VisualQaAdapterError("INVALID_SIGNAL", "execution options.signal must be an AbortSignal");
  }
  return options;
}

function finiteInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function safeText(value, maximum = MAX_FINDING_TEXT) {
  return typeof value === "string" ? redactSensitiveText(value).slice(0, maximum) : "";
}

function safeIdentifier(value) {
  return typeof value === "string" ? value.replace(/[^a-z0-9._-]/gi, "-").slice(0, 120) : "";
}

function safeDimensions(value) {
  if (!value || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) ||
      value.width < 1 || value.height < 1 ||
      value.width * value.height > VISUAL_QA_LIMITS.maxViewportPixels) return null;
  return Object.freeze({ width: value.width, height: value.height });
}

function safeVisualComparison(value) {
  if (!value || typeof value !== "object") return null;
  const status = ["compared", "baseline-missing", "baseline-updated", "dimension-mismatch"].includes(value.status)
    ? value.status : "unknown";
  return Object.freeze({
    status,
    passed: value.passed === true,
    diffPixels: value.diffPixels === null ? null : finiteInteger(value.diffPixels, VISUAL_QA_LIMITS.maxViewportPixels),
    totalPixels: finiteInteger(value.totalPixels, VISUAL_QA_LIMITS.maxViewportPixels),
    diffPixelRatio: typeof value.diffPixelRatio === "number" &&
      Number.isFinite(value.diffPixelRatio) && value.diffPixelRatio >= 0 && value.diffPixelRatio <= 1
      ? value.diffPixelRatio : null,
    baselineDimensions: safeDimensions(value.baselineDimensions),
    actualDimensions: safeDimensions(value.actualDimensions)
  });
}

function summarizeReport(report, { expectedViewports, themes, baselineEnabled }) {
  if (!report || !Array.isArray(report.viewports) ||
      report.viewports.length !== expectedViewports.length * themes.length ||
      !report.summary || !Array.isArray(report.themeComparisons)) {
    throw new VisualQaAdapterError(
      "UNSAFE_AUDIT_RESULT",
      "Visual QA refuses a browser report that does not match the requested viewport matrix"
    );
  }

  const severityCounts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  const findings = [];
  let rulesWithErrors = 0;
  let screenshotsCaptured = 0;
  let visualComparisons = 0;
  let baselineMissing = 0;
  let visualFailures = 0;
  let viewportsPassed = 0;

  const viewports = report.viewports.map((item) => {
    if (!item || typeof item.name !== "string" || !themes.includes(item.theme) ||
        !Array.isArray(item.execution) || !Array.isArray(item.findings)) {
      throw new VisualQaAdapterError("UNSAFE_AUDIT_RESULT", "Visual QA returned an invalid viewport result");
    }

    const dimensions = safeDimensions(item.viewport);
    if (!dimensions) {
      throw new VisualQaAdapterError("UNSAFE_AUDIT_RESULT", "Visual QA returned unsafe viewport dimensions");
    }
    rulesWithErrors += item.execution.filter((entry) => entry?.status === "error").length;

    if (typeof item.screenshotPath === "string" && item.screenshotPath) screenshotsCaptured += 1;
    const comparison = safeVisualComparison(item.visualComparison);
    if (comparison?.status === "compared") visualComparisons += 1;
    if (comparison?.status === "baseline-missing") baselineMissing += 1;
    if (comparison?.status === "compared" && !comparison.passed) visualFailures += 1;
    if (item.passed === true) viewportsPassed += 1;

    for (const finding of item.findings) {
      if (SEVERITIES.includes(finding?.severity)) severityCounts[finding.severity] += 1;
      if (findings.length < MAX_FINDINGS) {
        findings.push(Object.freeze({
          id: safeIdentifier(finding?.id),
          ruleId: safeIdentifier(finding?.ruleId),
          specialist: safeIdentifier(finding?.specialist),
          severity: SEVERITIES.includes(finding?.severity) ? finding.severity : "info",
          title: safeText(finding?.title, 180),
          description: safeText(finding?.description, MAX_FINDING_TEXT),
          viewport: safeText(item.name, 80),
          theme: item.theme
        }));
      }
    }

    return Object.freeze({
      name: safeText(item.name, 80),
      theme: item.theme,
      viewport: dimensions,
      passed: item.passed === true,
      score: typeof item.score === "number" && Number.isFinite(item.score)
        ? Math.max(0, Math.min(100, item.score)) : null,
      findingsCount: item.findings.length,
      screenshotCaptured: typeof item.screenshotPath === "string" && item.screenshotPath.length > 0,
      visualComparison: comparison
    });
  });

  const totalFindings = report.viewports.reduce((sum, item) => sum + item.findings.length, 0);
  const executionComplete = rulesWithErrors === 0 &&
    report.viewports.every((item) => item.execution.length > 0);
  const matrixComplete = viewports.length === expectedViewports.length * themes.length &&
    screenshotsCaptured === expectedViewports.length * themes.length;
  const baselineComparisonComplete = !baselineEnabled ||
    report.viewports.every((item) => item.visualComparison?.status === "compared");
  const complete = executionComplete && matrixComplete && baselineComparisonComplete;
  const passed = complete && report.passed === true && viewportsPassed === viewports.length &&
    visualFailures === 0 && baselineMissing === 0;

  return Object.freeze({
    adapter: ADAPTER_ID,
    mode: "bounded-browser-visual-qa",
    engine: safeText(report.engine, 100),
    version: safeText(report.version, 32),
    generatedAt: safeText(report.generatedAt, 40),
    complete,
    assessmentStatus: complete ? "complete" : "inconclusive",
    passed,
    matrix: Object.freeze({
      profile: expectedViewports.length === FULL_VIEWPORTS.length ? "full" : "default",
      viewportCount: expectedViewports.length,
      themes: themes,
      totalResults: expectedViewports.length * themes.length
    }),
    summary: Object.freeze({
      viewportsChecked: viewports.length,
      passedViewports: viewportsPassed,
      failedViewports: viewports.length - viewportsPassed,
      screenshotsCaptured,
      visualComparisons,
      baselineMissing,
      visualFailures,
      baselineWrites: 0,
      totalFindings,
      findingsReturned: findings.length,
      findingsTruncated: totalFindings > findings.length,
      rulesWithErrors,
      bySeverity: Object.freeze({ ...severityCounts }),
      themePairsCompared: finiteInteger(report.summary.themePairsCompared, MAX_VIEWPORTS)
    }),
    viewports: Object.freeze(viewports),
    findings: Object.freeze(findings),
    limitations: Object.freeze([
      "The adapter captures one unauthenticated page state per selected viewport and theme; it does not crawl routes or explore interactive states.",
      "Pixel comparison is performed only when a baseline directory is supplied. Missing or unreadable baseline evidence is not treated as a pass.",
      "Baseline directories are read-only through this adapter; baseline creation and updates are intentionally disabled.",
      "AI screenshot review is not invoked. Findings come from the deterministic canonical browser and specialist rules.",
      "The browser URL safety guard blocks private and reserved destinations; cross-origin public resources may load as part of the page.",
      "Each browser navigation is capped by the requested timeout; the canonical viewport loop does not expose mid-run AbortSignal cancellation."
    ])
  });
}

/**
 * Formal engine-registry adapter over the canonical auditViewports implementation.
 * Screenshots are kept in an ephemeral directory and removed after the bounded
 * report is summarized. Existing baselines are read-only; this adapter never
 * creates or modifies baselines, invokes AI providers, or explores controls.
 */
export function createVisualQaEngineAdapter({ audit = auditViewports, tempDirectory = tmpdir } = {}) {
  if (typeof audit !== "function" || typeof tempDirectory !== "function") {
    throw new VisualQaAdapterError("INVALID_AUDITOR", "Visual QA requires a trusted audit function and temporary-directory provider");
  }

  async function run(input, executionOptions = {}) {
    const command = validateCommand(input);
    const options = validateExecutionOptions(executionOptions);
    if (options.signal?.aborted) {
      const error = new Error("Visual QA was cancelled before browser startup");
      error.name = "AbortError";
      throw error;
    }

    let screenshotDir = null;
    try {
      screenshotDir = await mkdtemp(join(tempDirectory(), "jbqa-visual-"));
      const report = await audit(command.url, {
        viewports: command.viewports,
        themes: command.themes,
        timeout: command.timeout,
        screenshotDir,
        screenshotFullPage: false,
        baselineDir: command.baselineDir,
        diffDir: null,
        updateBaselines: false,
        visualThreshold: command.visualThreshold,
        maxDiffPixelRatio: command.maxDiffPixelRatio,
        interactionExploration: false,
        runAxe: false,
        headless: true,
        allowPrivateNetworks: false,
        viewport: { width: 1365, height: 900 }
      });
      return summarizeReport(report, {
        expectedViewports: command.viewports,
        themes: command.themes,
        baselineEnabled: Boolean(command.baselineDir)
      });
    } catch (error) {
      if (error instanceof VisualQaAdapterError) throw error;
      throw new VisualQaAdapterError(
        "AUDIT_FAILED",
        "Visual QA could not safely complete the bounded browser and screenshot audit"
      );
    } finally {
      if (screenshotDir) await rm(screenshotDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return Object.freeze({
    id: ADAPTER_ID,
    name: "Visual QA Engine",
    version: ENGINE_VERSION,
    category: "visual",
    targetType: "url",
    executionMode: "browser",
    capabilities: CAPABILITIES,
    description: "Bounded viewport and theme screenshots using the canonical visual/layout audit and optional read-only PNG baselines; ephemeral screenshots, no baseline writes, AI calls, authentication or interaction exploration.",
    run
  });
}

/** Registers the trusted visual adapter without capturing screenshots or navigating. */
export function registerVisualQaEngine(registry) {
  if (!isPlainRecord(registry)) {
    throw new VisualQaAdapterError("INVALID_REGISTRY", "A JB QA engine registry instance is required");
  }
  for (const key of ["register", "has"]) {
    const descriptor = Object.getOwnPropertyDescriptor(registry, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new VisualQaAdapterError("INVALID_REGISTRY", "Registry must expose trusted register() and has() methods");
    }
  }

  const adapter = createVisualQaEngineAdapter();
  if (registry.has(adapter.id)) {
    throw new VisualQaAdapterError("DUPLICATE_ENGINE", "Visual QA Engine is already registered");
  }
  return registry.register(adapter);
}
