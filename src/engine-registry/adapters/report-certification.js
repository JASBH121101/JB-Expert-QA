import { createHash, randomUUID } from "node:crypto";
import { redactSensitiveText } from "../../core/redaction.js";
import { buildDashboardAnalytics, buildConsolidatedReport } from "../../dashboard/analytics.js";

const ADAPTER_ID = "jb.report-certification-engine";
const MAX_HISTORY_RECORDS = 2000;
const MAX_ENGINE_DEFINITIONS = 64;
const MAX_FINDINGS_PER_RECORD = 100;
const MAX_TOTAL_FINDINGS = 5000;
const MAX_TEXT_LENGTH = 240;
const OUTCOMES = new Set(["passed", "passed_with_observations", "not_passed"]);
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const ASSESSMENTS = new Set([
  "NOT_ASSESSED",
  "NOT_PASSED",
  "REVIEW_REQUIRED",
  "OBSERVATIONS",
  "PASSED_WITHIN_RECORDED_SCOPE"
]);
const FORMATS = new Set(["json", "markdown", "html"]);
const ENGINE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const CAPABILITIES = Object.freeze([
  "multi-engine-report-aggregation",
  "scope-aware-certification",
  "severity-and-findings-summary",
  "engine-coverage-reporting",
  "json-markdown-html-export",
  "sha256-checkpoint-integrity",
  "bounded-local-report-generation"
]);

export const REPORT_CERTIFICATION_ADAPTER_ID = ADAPTER_ID;
export const REPORT_CERTIFICATION_ADAPTER_VERSION = "1.0.0";
export const REPORT_CERTIFICATION_ADAPTER_CAPABILITIES = CAPABILITIES;
export const REPORT_CERTIFICATION_LIMITS = Object.freeze({
  maxHistoryRecords: MAX_HISTORY_RECORDS,
  maxEngineDefinitions: MAX_ENGINE_DEFINITIONS,
  maxFindingsPerRecord: MAX_FINDINGS_PER_RECORD,
  maxTotalFindings: MAX_TOTAL_FINDINGS,
  maxFormats: FORMATS.size,
  externalNetworkRequests: 0,
  filesystemWrites: 0,
  crossEngineScoreAveraging: false
});

export class ReportCertificationAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReportCertificationAdapterError";
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
    throw new ReportCertificationAdapterError("INVALID_RECORD", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (allowedKeys && !allowedKeys.has(key))) {
      throw new ReportCertificationAdapterError("UNSUPPORTED_FIELD", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ReportCertificationAdapterError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function safeText(value, label, maximum = MAX_TEXT_LENGTH, required = false) {
  if (value === undefined || value === null) {
    if (required) {
      throw new ReportCertificationAdapterError("INVALID_FIELD", label + " is required");
    }
    return "";
  }
  if (typeof value !== "string") {
    throw new ReportCertificationAdapterError("INVALID_FIELD", label + " must be a string");
  }
  const clean = redactSensitiveText(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
  if (required && !clean) {
    throw new ReportCertificationAdapterError("INVALID_FIELD", label + " is required");
  }
  return clean;
}

function safeCount(value, label, fallback = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReportCertificationAdapterError("INVALID_COUNT", label + " must be a non-negative safe integer");
  }
  return Math.min(value, maximum);
}

function normalizeFinding(value, index) {
  const item = readRecord(value, "finding[" + index + "]", new Set([
    "id", "ruleId", "title", "severity"
  ]));
  const severity = safeText(item.severity, "finding.severity", 16, true).toLowerCase();
  if (!SEVERITIES.has(severity)) {
    throw new ReportCertificationAdapterError("INVALID_SEVERITY", "Finding severity is not supported");
  }
  return Object.freeze({
    id: safeText(item.id, "finding.id", 120),
    ruleId: safeText(item.ruleId, "finding.ruleId", 160),
    title: safeText(item.title, "finding.title", 240, true),
    severity
  });
}

function normalizeHistory(value) {
  if (!Array.isArray(value) || value.length > MAX_HISTORY_RECORDS) {
    throw new ReportCertificationAdapterError(
      "INVALID_HISTORY",
      "history must be an array of at most " + MAX_HISTORY_RECORDS + " records"
    );
  }
  const records = [];
  let totalFindings = 0;

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ReportCertificationAdapterError("INVALID_HISTORY", "history cannot contain holes or accessors");
    }
    const item = readRecord(descriptor.value, "history[" + index + "]", new Set([
      "id", "engineId", "engineName", "targetHash", "targetLabel", "createdAt",
      "outcome", "score", "findingsCount", "findings", "findingsOmitted", "comparison"
    ]));

    const id = safeText(item.id, "history.id", 128, true);
    const engineId = safeText(item.engineId, "history.engineId", 128, true);
    if (!ENGINE_ID_PATTERN.test(engineId)) {
      throw new ReportCertificationAdapterError("INVALID_ENGINE_ID", "history.engineId has an invalid format");
    }
    const createdAt = safeText(item.createdAt, "history.createdAt", 40, true);
    if (!Number.isFinite(Date.parse(createdAt))) {
      throw new ReportCertificationAdapterError("INVALID_TIMESTAMP", "history.createdAt must be a valid timestamp");
    }

    const outcome = safeText(item.outcome, "history.outcome", 32, true);
    if (!OUTCOMES.has(outcome)) {
      throw new ReportCertificationAdapterError("INVALID_OUTCOME", "history.outcome is not a recognized audit outcome");
    }

    const score = item.score ?? null;
    if (score !== null && (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100)) {
      throw new ReportCertificationAdapterError("INVALID_SCORE", "history.score must be between 0 and 100 or null");
    }

    const findingsValue = item.findings ?? [];
    if (!Array.isArray(findingsValue) || findingsValue.length > MAX_FINDINGS_PER_RECORD) {
      throw new ReportCertificationAdapterError(
        "INVALID_FINDINGS",
        "Each history record must contain at most " + MAX_FINDINGS_PER_RECORD + " finding details"
      );
    }
    const findings = [];
    for (let findingIndex = 0; findingIndex < findingsValue.length; findingIndex += 1) {
      const findingDescriptor = Object.getOwnPropertyDescriptor(findingsValue, String(findingIndex));
      if (!findingDescriptor || !Object.hasOwn(findingDescriptor, "value")) {
        throw new ReportCertificationAdapterError("INVALID_FINDINGS", "findings cannot contain holes or accessors");
      }
      findings.push(normalizeFinding(findingDescriptor.value, findingIndex));
    }
    totalFindings += findings.length;
    if (totalFindings > MAX_TOTAL_FINDINGS) {
      throw new ReportCertificationAdapterError("FINDING_LIMIT", "Report exceeds the total finding-detail limit");
    }

    const findingsCount = safeCount(item.findingsCount, "history.findingsCount", findings.length);
    const comparisonValue = item.comparison ?? {};
    const comparison = readRecord(comparisonValue, "history.comparison", new Set([
      "newFindingsCount", "resolvedFindingsCount"
    ]));

    // Target labels are replaced with a stable digest so raw URLs, project paths
    // or user-provided labels are not copied into consolidated exports.
    const targetIdentityValue = item.targetHash ?? item.targetLabel ?? "unknown-target";
    if (typeof targetIdentityValue !== "string") {
      throw new ReportCertificationAdapterError("INVALID_TARGET_IDENTITY", "Target identity must be a string");
    }
    const targetDigest = createHash("sha256").update(targetIdentityValue).digest("hex");
    const targetLabel = targetIdentityValue === "unknown-target"
      ? "Unknown target"
      : "Target " + targetDigest.slice(0, 12);

    records.push(Object.freeze({
      id,
      engineId,
      engineName: safeText(item.engineName ?? engineId, "history.engineName", 120, true),
      targetHash: targetDigest,
      targetLabel,
      createdAt,
      outcome,
      score,
      findingsCount: Math.max(findingsCount, findings.length),
      findings: Object.freeze(findings),
      findingsOmitted: safeCount(item.findingsOmitted, "history.findingsOmitted"),
      comparison: Object.freeze({
        newFindingsCount: safeCount(comparison.newFindingsCount, "comparison.newFindingsCount"),
        resolvedFindingsCount: safeCount(comparison.resolvedFindingsCount, "comparison.resolvedFindingsCount")
      })
    }));
  }
  return Object.freeze(records);
}

function normalizeEngineDefinitions(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_ENGINE_DEFINITIONS) {
    throw new ReportCertificationAdapterError(
      "INVALID_ENGINE_DEFINITIONS",
      "engineDefinitions must be an array of at most " + MAX_ENGINE_DEFINITIONS + " entries"
    );
  }
  const seen = new Set();
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ReportCertificationAdapterError("INVALID_ENGINE_DEFINITIONS", "engineDefinitions cannot contain holes or accessors");
    }
    const item = readRecord(descriptor.value, "engineDefinitions[" + index + "]", new Set(["id", "name"]));
    const id = safeText(item.id, "engineDefinitions.id", 128, true);
    if (!ENGINE_ID_PATTERN.test(id) || seen.has(id)) {
      throw new ReportCertificationAdapterError("INVALID_ENGINE_DEFINITIONS", "Engine IDs must be valid and unique");
    }
    seen.add(id);
    result.push(Object.freeze({
      id,
      name: safeText(item.name ?? id, "engineDefinitions.name", 120, true)
    }));
  }
  return Object.freeze(result);
}

function normalizeFormat(value) {
  const format = value ?? "json";
  if (typeof format !== "string" || !FORMATS.has(format)) {
    throw new ReportCertificationAdapterError("INVALID_FORMAT", "format must be json, markdown or html");
  }
  return format;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function renderHtml(certificate, analytics) {
  const engineRows = analytics.engineCoverage.map((engine) => "<tr>" + [
    engine.engineName,
    engine.auditCount,
    engine.currentTargetCount,
    engine.activeFindings,
    engine.averageScore === null ? "—" : engine.averageScore + "/100",
    engine.latestOutcome || "Not run"
  ].map((value) => "<td>" + escapeHtml(value) + "</td>").join("") + "</tr>").join("");
  const findingRows = analytics.topFindings.map((finding) => "<tr>" + [
    finding.ruleId,
    finding.title,
    finding.severity,
    finding.occurrences,
    finding.engines.join(", ")
  ].map((value) => "<td>" + escapeHtml(value) + "</td>").join("") + "</tr>").join("");
  const severityRows = Object.entries(analytics.severityCounts).map(([level, count]) =>
    "<tr><td>" + escapeHtml(level) + "</td><td>" + escapeHtml(count) + "</td></tr>"
  ).join("");

  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>JB Expert QA Certification Report</title>",
    "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:1200px;margin:32px auto;padding:0 20px;color:#172033}h1,h2{line-height:1.2}.status{font-weight:700}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{text-align:left;padding:10px;border-bottom:1px solid #dce1ea;overflow-wrap:anywhere}th{background:#f2f4f8}.meta{color:#586174}</style>",
    "</head><body>",
    "<h1>JB Expert QA — Certification Report</h1>",
    '<p class="status">Assessment: ' + escapeHtml(certificate.assessment) + "</p>",
    '<p class="meta">Generated: ' + escapeHtml(certificate.generatedAt) + " · Certification ID: " + escapeHtml(certificate.certificationId) + "</p>",
    "<h2>Scope</h2><ul>",
    "<li>Retained audit records: " + escapeHtml(analytics.retainedHistoryCount) + "</li>",
    "<li>Latest engine/target snapshots: " + escapeHtml(analytics.currentSnapshotCount) + "</li>",
    "<li>Distinct targets: " + escapeHtml(analytics.targetCount) + "</li>",
    "<li>Engine coverage: " + escapeHtml(analytics.usedEngineCount) + "/" + escapeHtml(analytics.availableEngineCount) + " (" + escapeHtml(analytics.coveragePercent) + "%)</li>",
    "<li>Active findings: " + escapeHtml(analytics.activeFindingCount) + "</li>",
    "<li>Average score across snapshots: " + escapeHtml(analytics.averageCurrentScore === null ? "Not available" : analytics.averageCurrentScore + "/100 (not comparable across engines)") + "</li>",
    "</ul>",
    "<h2>Engine coverage and status</h2><table><thead><tr><th>Engine</th><th>Historical runs</th><th>Current snapshots</th><th>Findings</th><th>Average score</th><th>Latest outcome</th></tr></thead><tbody>",
    engineRows || '<tr><td colspan="6">No registered engines in the report scope.</td></tr>',
    "</tbody></table>",
    "<h2>Finding severity</h2><table><thead><tr><th>Severity</th><th>Count</th></tr></thead><tbody>",
    severityRows,
    "</tbody></table>",
    "<h2>Most recurrent findings</h2><table><thead><tr><th>Rule</th><th>Finding</th><th>Severity</th><th>Occurrences</th><th>Engines</th></tr></thead><tbody>",
    findingRows || '<tr><td colspan="5">No retained findings.</td></tr>',
    "</tbody></table>",
    "<h2>Checkpoint</h2><p>SHA-256: <code>" + escapeHtml(certificate.checkpoint.digest) + "</code></p>",
    "<p class=\"meta\">This report covers only bounded local history. Engine coverage does not imply every engine assessed the same target. Scores are heuristic and not directly comparable across engines or targets. This is not a third-party certification, penetration test or proof of production readiness.</p>",
    "</body></html>"
  ].join("\n");
}

function deriveAssessmentExplanation(assessment) {
  switch (assessment) {
    case "NOT_ASSESSED":
      return "No saved audit snapshot is available; no certification decision can be made.";
    case "NOT_PASSED":
      return "At least one latest engine/target snapshot did not pass.";
    case "REVIEW_REQUIRED":
      return "Critical or high-severity findings remain in the latest saved snapshots.";
    case "OBSERVATIONS":
      return "Findings or observations remain in the latest saved snapshots.";
    case "PASSED_WITHIN_RECORDED_SCOPE":
      return "No findings were recorded in the latest saved snapshots; this is limited to the recorded scope.";
    default:
      return "The assessment state is not recognized.";
  }
}

function createCheckpoint(analytics, generatedAt, idFactory) {
  const checkpointPayload = {
    generatedAt,
    retainedHistoryCount: analytics.retainedHistoryCount,
    currentSnapshotCount: analytics.currentSnapshotCount,
    targetCount: analytics.targetCount,
    usedEngineCount: analytics.usedEngineCount,
    availableEngineCount: analytics.availableEngineCount,
    assessment: analytics.assessment,
    currentOutcomes: analytics.currentOutcomes,
    severityCounts: analytics.severityCounts,
    topFindings: analytics.topFindings
  };
  const digest = createHash("sha256").update(JSON.stringify(checkpointPayload)).digest("hex");
  return Object.freeze({
    id: idFactory(),
    createdAt: generatedAt,
    digestAlgorithm: "sha256",
    digest,
    recordCount: analytics.retainedHistoryCount,
    snapshotCount: analytics.currentSnapshotCount,
    targetCount: analytics.targetCount,
    assessment: analytics.assessment
  });
}

function normalizeClock(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw new ReportCertificationAdapterError("INVALID_CLOCK", "Report clock could not be read");
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ReportCertificationAdapterError("INVALID_CLOCK", "Report clock must return a valid Date");
  }
  return value.toISOString();
}

export function createReportCertificationEngineAdapter({
  clock = () => new Date(),
  idFactory = randomUUID
} = {}) {
  if (typeof clock !== "function" || typeof idFactory !== "function") {
    throw new ReportCertificationAdapterError("INVALID_DEPENDENCY", "clock and idFactory must be functions");
  }

  async function run(input) {
    const command = readRecord(input, "command", new Set(["history", "engineDefinitions", "format"]));
    const history = normalizeHistory(command.history ?? []);
    const engineDefinitions = normalizeEngineDefinitions(command.engineDefinitions);
    const format = normalizeFormat(command.format);
    const generatedAt = normalizeClock(clock());
    let certificationId;
    try {
      certificationId = safeText(idFactory(), "certificationId", 128, true);
    } catch {
      throw new ReportCertificationAdapterError("INVALID_ID_FACTORY", "Certification ID could not be generated");
    }

    const analytics = buildDashboardAnalytics(history, engineDefinitions);
    const assessment = ASSESSMENTS.has(analytics.assessment) ? analytics.assessment : "NOT_ASSESSED";
    const checkpoint = createCheckpoint(analytics, generatedAt, () => certificationId);

    const certificate = Object.freeze({
      certificationId,
      adapter: ADAPTER_ID,
      adapterVersion: REPORT_CERTIFICATION_ADAPTER_VERSION,
      generatedAt,
      assessment,
      explanation: deriveAssessmentExplanation(assessment),
      claim: "Assessment of bounded retained local audit history only; not a third-party certification or proof of production readiness.",
      scope: Object.freeze({
        retainedHistoryCount: analytics.retainedHistoryCount,
        currentSnapshotCount: analytics.currentSnapshotCount,
        targetCount: analytics.targetCount,
        usedEngineCount: analytics.usedEngineCount,
        availableEngineCount: analytics.availableEngineCount,
        coveragePercent: analytics.coveragePercent
      }),
      outcomes: analytics.currentOutcomes,
      averageCurrentScore: analytics.averageCurrentScore,
      scoresComparableAcrossEngines: false,
      findings: Object.freeze({
        activeCount: analytics.activeFindingCount,
        notClassified: analytics.findingsNotClassified,
        bySeverity: analytics.severityCounts,
        top: analytics.topFindings
      }),
      engineCoverage: Object.freeze(analytics.engineCoverage),
      checkpoint,
      limitations: Object.freeze([
        "Only records supplied to this invocation are assessed; omitted or expired local history is outside the result.",
        "Latest snapshots are selected per engine and target identity. Different engines may have assessed different targets.",
        "Scores and findings are heuristic outputs and are not directly comparable across engines or targets.",
        "A PASSED_WITHIN_RECORDED_SCOPE result is not a third-party certification, penetration test, accessibility conformance statement, or proof of production readiness.",
        "No report artifact is written to disk and no external service or network request is used."
      ])
    });

    const reportModel = {
      engine: "JB Expert QA",
      generatedAt,
      assessment,
      scope: certificate.scope,
      analytics,
      certificate,
      markdown: buildConsolidatedReport(history, engineDefinitions, new Date(generatedAt))
    };

    let artifact;
    if (format === "json") {
      artifact = JSON.stringify(reportModel, null, 2);
    } else if (format === "markdown") {
      artifact = [
        reportModel.markdown,
        "",
        "## Certification checkpoint",
        "",
        "- Certification ID: " + certificationId,
        "- Assessment: " + assessment,
        "- SHA-256: " + checkpoint.digest,
        "- Scope: " + checkpoint.recordCount + " records / " + checkpoint.snapshotCount +
          " current snapshots / " + checkpoint.targetCount + " targets",
        "",
        certificate.claim,
        ""
      ].join("\n");
    } else {
      artifact = renderHtml(certificate, analytics);
    }

    return Object.freeze({
      adapter: ADAPTER_ID,
      format,
      certification: certificate,
      analytics,
      artifact
    });
  }

  return Object.freeze({
    id: ADAPTER_ID,
    name: "Report & Certification Engine",
    version: REPORT_CERTIFICATION_ADAPTER_VERSION,
    category: "reporting",
    targetType: "payload",
    executionMode: "in-process",
    capabilities: CAPABILITIES,
    description: "Aggregates bounded local audit history into scope-aware certification states, severity summaries, engine coverage, JSON/Markdown/HTML report artifacts and a SHA-256 checkpoint; no disk writes, external services or cross-engine score averaging.",
    run
  });
}

/** Registers reporting metadata only. It does not read dashboard storage or execute audits. */
export function registerReportCertificationEngine(registry, options = {}) {
  if (!isPlainRecord(registry)) {
    throw new ReportCertificationAdapterError("INVALID_REGISTRY", "A JB QA engine registry instance is required");
  }
  for (const key of ["register", "has"]) {
    const descriptor = Object.getOwnPropertyDescriptor(registry, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new ReportCertificationAdapterError("INVALID_REGISTRY", "Registry must expose trusted register() and has() methods");
    }
  }
  const adapter = createReportCertificationEngineAdapter(options);
  if (registry.has(adapter.id)) {
    throw new ReportCertificationAdapterError("DUPLICATE_ENGINE", "Report & Certification Engine is already registered");
  }
  return registry.register(adapter);
}
