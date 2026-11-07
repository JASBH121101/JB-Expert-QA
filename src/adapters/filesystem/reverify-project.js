import { auditProject } from "./audit-project.js";
import { auditSecurityProject } from "./audit-security-project.js";
import { compareReverification } from "../../core/reverification.js";

function requiredReport(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.diagnostics)) {
    throw new TypeError("previousReport must contain a diagnostics array");
  }
  if (report.execution !== undefined && !Array.isArray(report.execution)) {
    throw new TypeError("previousReport.execution must be an array when provided");
  }
}

function selectedRuleIds(report) {
  const ids = new Set();
  for (const finding of report.diagnostics) {
    if (typeof finding?.ruleId === "string" && finding.ruleId.trim()) ids.add(finding.ruleId);
  }
  for (const item of report.execution ?? []) {
    if (item?.status === "error" && typeof item.ruleId === "string" && item.ruleId.trim()) {
      ids.add(item.ruleId);
    }
  }
  return [...ids].sort();
}

function failedExecutionRuleIds(report) {
  return new Set((report.execution ?? [])
    .filter((item) => item?.status === "error" && typeof item.ruleId === "string")
    .map((item) => item.ruleId));
}

async function runTargetedReverification(audit, rootPath, {
  previousReport,
  auditOptions = {}
} = {}, profile) {
  requiredReport(previousReport);
  if (!auditOptions || typeof auditOptions !== "object" || Array.isArray(auditOptions)) {
    throw new TypeError("auditOptions must be an object");
  }

  const ruleIds = selectedRuleIds(previousReport);
  const previousExecutionErrors = [...failedExecutionRuleIds(previousReport)].sort();
  if (ruleIds.length === 0) {
    return Object.freeze({
      engine: "JB Expert QA",
      profile,
      status: "not-needed",
      scope: "targeted-only",
      fullAuditRequired: true,
      generatedAt: new Date().toISOString(),
      selection: Object.freeze({ type: "targeted-rules", ruleIds: Object.freeze([]) }),
      summary: Object.freeze({
        previousFindings: previousReport.diagnostics.length,
        currentFindings: 0,
        resolved: 0,
        unchanged: 0,
        newFindings: 0,
        previousExecutionErrors: previousExecutionErrors.length,
        currentExecutionErrors: 0,
        executionErrorsCleared: previousExecutionErrors.length
      }),
      comparison: null,
      currentReport: null,
      message: "The previous report contains no finding rule IDs or failed rule executions; no rules were run."
    });
  }

  const currentReport = await audit(rootPath, { ...auditOptions, ruleIds });
  const comparison = compareReverification(previousReport, currentReport, { ruleIds });
  const currentExecutionErrors = [...failedExecutionRuleIds(currentReport)].sort();
  const currentErrorSet = new Set(currentExecutionErrors);
  const clearedExecutionErrors = previousExecutionErrors.filter((id) => !currentErrorSet.has(id));

  return Object.freeze({
    engine: "JB Expert QA",
    profile,
    status: currentReport.summary.rulesWithErrors > 0 ? "review-required" : "completed",
    scope: "targeted-only",
    fullAuditRequired: true,
    generatedAt: new Date().toISOString(),
    selection: Object.freeze({
      type: "targeted-rules",
      ruleIds: Object.freeze(ruleIds),
      rulesExecuted: currentReport.summary.rulesExecuted,
      rulesWithErrors: currentReport.summary.rulesWithErrors
    }),
    summary: Object.freeze({
      previousFindings: comparison.summary.previous,
      currentFindings: comparison.summary.current,
      resolved: comparison.summary.resolved,
      unchanged: comparison.summary.unchanged,
      newFindings: comparison.summary.newFindings,
      previousExecutionErrors: previousExecutionErrors.length,
      currentExecutionErrors: currentExecutionErrors.length,
      executionErrorsCleared: clearedExecutionErrors.length
    }),
    comparison,
    execution: Object.freeze({
      previousErrors: Object.freeze(previousExecutionErrors),
      currentErrors: Object.freeze(currentExecutionErrors),
      clearedErrors: Object.freeze(clearedExecutionErrors)
    }),
    currentReport
  });
}

/**
 * Re-run only project rules that produced findings or execution errors in a prior audit.
 * The previous report is treated as immutable input; project files are re-scanned normally.
 */
export function reverifyProject(rootPath, options = {}) {
  return runTargetedReverification(auditProject, rootPath, options, "project");
}

/**
 * Re-run only security rules that produced findings or execution errors in a prior audit.
 * Keep onlineAdvisories disabled unless the original audit explicitly used the OSV lookup.
 */
export function reverifySecurityProject(rootPath, options = {}) {
  return runTargetedReverification(auditSecurityProject, rootPath, options, "security");
}
