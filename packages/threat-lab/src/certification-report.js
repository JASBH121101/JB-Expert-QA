import { assessThreatLabDifficulty } from "./difficulty.js";

export const UNIFIED_THREAT_LAB_REPORT_SCHEMA = "jb.threat-lab.unified-certification-report/v1";

const SOURCE_REPORT_SCHEMA = "jb.threat-lab.report/v2";
const DEFAULT_REQUIRED_TARGETS = Object.freeze([
  "jb-malware-engine",
  "jb-security-guard",
  "jb-expert-qa",
  "jb-advisor-engine"
]);
const VALID_STATUSES = new Set(["pass", "fail", "skip"]);

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableLabel(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{1,119}$/i.test(value)) {
    throw new TypeError(label + " must be a 2-120 character stable identifier");
  }
  return value;
}

/**
 * Combines independent Threat Lab v2 run reports without replacing their
 * original outcomes. Duplicate target/scenario pairs and conflicting target
 * versions are rejected. Structural target-scope skips remain visible but
 * are excluded from readiness by the existing Threat Lab difficulty assessor.
 */
export function createUnifiedThreatLabCertificationReport({
  reports,
  commit = null,
  runtime = process.version,
  platform = process.platform,
  architecture = process.arch,
  generatedAt = new Date().toISOString(),
  requiredTargets = DEFAULT_REQUIRED_TARGETS,
  difficulty = "superextreme"
} = {}) {
  if (!Array.isArray(reports) || reports.length < 1 || reports.length > 50) {
    throw new TypeError("reports must contain 1-50 independent Threat Lab v2 reports");
  }
  if (!Array.isArray(requiredTargets) || requiredTargets.length > 50 ||
      requiredTargets.some((item) => typeof item !== "string" || !item.trim()) ||
      new Set(requiredTargets).size !== requiredTargets.length) {
    throw new TypeError("requiredTargets must contain unique non-empty target IDs");
  }
  if (commit !== null && (typeof commit !== "string" || !/^[0-9a-f]{7,64}$/i.test(commit))) {
    throw new TypeError("commit must be a Git SHA or null");
  }
  if (typeof runtime !== "string" || runtime.length > 80 ||
      typeof platform !== "string" || platform.length > 80 ||
      typeof architecture !== "string" || architecture.length > 80 ||
      typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt))) {
    throw new TypeError("runtime, platform, architecture and generatedAt metadata are invalid");
  }

  const seenReportIds = new Set();
  const seenCases = new Set();
  const targetDefinitions = new Map();
  const unifiedResults = [];
  const sourceReports = [];

  for (const [index, source] of reports.entries()) {
    if (!isRecord(source) || !isRecord(source.report)) {
      throw new TypeError("reports[" + index + "] must contain reportId and report objects");
    }
    const report = source.report;
    if (report.schema !== SOURCE_REPORT_SCHEMA || !Array.isArray(report.results)) {
      throw new TypeError("reports[" + index + "] must use " + SOURCE_REPORT_SCHEMA);
    }
    const reportId = stableLabel(
      source.reportId ??
      report.metadata?.suite ??
      report.metadata?.product ??
      report.metadata?.profile ??
      "threat-lab-run-" + (index + 1),
      "reportId"
    );
    if (seenReportIds.has(reportId)) throw new Error("Duplicate Threat Lab source report: " + reportId);
    seenReportIds.add(reportId);

    const runTotals = { pass: 0, fail: 0, skip: 0 };
    for (const [resultIndex, result] of report.results.entries()) {
      if (!isRecord(result) || !isRecord(result.target) || !isRecord(result.scenario) ||
          typeof result.target.id !== "string" || typeof result.scenario.id !== "string" ||
          !VALID_STATUSES.has(result.status)) {
        throw new TypeError(reportId + " results[" + resultIndex + "] has an invalid result shape");
      }

      const targetId = stableLabel(result.target.id, "target.id");
      const scenarioId = stableLabel(result.scenario.id, "scenario.id");
      const targetKind = typeof result.target.kind === "string" ? result.target.kind : "unknown";
      const targetVersion = typeof result.target.version === "string" ? result.target.version : "unknown";
      const definition = targetDefinitions.get(targetId);
      if (definition && (definition.kind !== targetKind || definition.version !== targetVersion)) {
        throw new Error("Target " + targetId + " has conflicting kind/version across source reports");
      }
      if (!definition) targetDefinitions.set(targetId, { kind: targetKind, version: targetVersion });

      const caseKey = targetId + "\u0000" + scenarioId;
      if (seenCases.has(caseKey)) {
        throw new Error("Duplicate target/scenario result across source reports: " + targetId + " / " + scenarioId);
      }
      seenCases.add(caseKey);

      runTotals[result.status] += 1;
      unifiedResults.push({
        ...result,
        target: { ...result.target, id: targetId },
        scenario: { ...result.scenario, id: scenarioId },
        sourceReport: reportId
      });
    }

    sourceReports.push({
      reportId,
      lab: report.lab ?? null,
      startedAt: report.startedAt ?? null,
      completedAt: report.completedAt ?? null,
      metadata: isRecord(report.metadata) ? report.metadata : {},
      totals: runTotals,
      resultCount: report.results.length
    });
  }

  const missingTargets = requiredTargets.filter((id) => !targetDefinitions.has(id));
  const totals = unifiedResults.reduce((accumulator, result) => {
    accumulator[result.status] += 1;
    if (result.status === "skip" && result.skipReason === "target_scope") {
      accumulator.targetScopeSkips += 1;
    } else if (result.status === "skip") {
      accumulator.nonScopeSkips += 1;
    }
    return accumulator;
  }, { pass: 0, fail: 0, skip: 0, targetScopeSkips: 0, nonScopeSkips: 0 });

  const assessment = assessThreatLabDifficulty(unifiedResults, difficulty);
  const ready = missingTargets.length === 0 &&
    totals.fail === 0 &&
    totals.nonScopeSkips === 0 &&
    assessment.ready === true;

  const targetSummary = assessment.targets.map((target) => ({
    target: target.target,
    total: target.total,
    passed: target.passed,
    failed: target.failed,
    skipped: target.skipped,
    coveredLevels: target.coveredLevels,
    missingLevels: target.missingLevels,
    executionCoveragePct: target.executionCoveragePct,
    weightedScorePct: target.weightedScorePct,
    ready: target.ready
  }));

  return Object.freeze({
    schema: UNIFIED_THREAT_LAB_REPORT_SCHEMA,
    generatedAt,
    commit,
    runtime: { node: runtime, platform, architecture },
    scope: Object.freeze({
      sourceReports: reports.length,
      requiredTargets: [...requiredTargets],
      missingTargets,
      originalReportsPreserved: true,
      samplesExecuted: 0,
      networkRequests: 0,
      productionTargetsTested: false,
      interpretation: "This report aggregates only the registered, safe Threat Lab scenarios that actually ran. It is not proof of absence of malware, vulnerabilities or defects, and it is not production or third-party certification."
    }),
    totals: Object.freeze(totals),
    assessment: Object.freeze({
      requestedDifficulty: assessment.requestedDifficulty,
      requiredLevels: assessment.requiredLevels,
      ready,
      coveredLevels: assessment.coveredLevels,
      missingLevels: assessment.missingLevels,
      executionCoveragePct: assessment.executionCoveragePct,
      weightedScorePct: assessment.weightedScorePct,
      targets: targetSummary
    }),
    sourceReports: Object.freeze(sourceReports),
    results: Object.freeze(unifiedResults)
  });
}
