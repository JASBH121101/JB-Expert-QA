import { snapshotArray, snapshotPlainRecord } from "./safe-record.js";

import { DEFAULT_SEVERITY_PENALTIES, SEVERITIES } from "./severities.js";

export function calculateScore(diagnostics, options = {}) {
  const safeOptions = snapshotPlainRecord(options, "scoring options");
  const weights = snapshotPlainRecord(safeOptions.weights ?? {}, "weights");
  const severityPenalties = snapshotPlainRecord(
    safeOptions.severityPenalties ?? DEFAULT_SEVERITY_PENALTIES,
    "severityPenalties"
  );
  const minimumScore = safeOptions.minimumScore ?? 80;
  const failOnCritical = safeOptions.failOnCritical ?? true;
  const includedSpecialists = snapshotArray(
    safeOptions.includedSpecialists ?? Object.keys(weights),
    "includedSpecialists"
  );
  const executionErrors = safeOptions.executionErrors ?? 0;
  const safeDiagnostics = snapshotArray(diagnostics, "diagnostics").map((item, index) =>
    snapshotPlainRecord(item, "diagnostics[" + index + "]")
  );
  if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 100) {
    throw new TypeError("minimumScore must be a number between 0 and 100");
  }
  if (typeof failOnCritical !== "boolean") {
    throw new TypeError("failOnCritical must be a boolean");
  }
  if (!Number.isInteger(executionErrors) || executionErrors < 0) {
    throw new TypeError("executionErrors must be a non-negative integer");
  }
  if (!Array.isArray(includedSpecialists) ||
      includedSpecialists.some((name) => typeof name !== "string" || !name.trim())) {
    throw new TypeError("includedSpecialists must be an array of non-empty names");
  }

  for (const [name, weight] of Object.entries(weights)) {
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
      throw new TypeError("Invalid weight for specialist \"" + name + "\"");
    }
  }
  for (const [severity, penalty] of Object.entries(severityPenalties)) {
    if (!SEVERITIES.includes(severity)) {
      throw new TypeError("Unknown severity penalty: \"" + severity + "\"");
    }
    if (typeof penalty !== "number" || !Number.isFinite(penalty) || penalty < 0) {
      throw new TypeError("Invalid penalty for severity \"" + severity + "\"");
    }
  }
  for (const item of safeDiagnostics) {
    if (!item || !SEVERITIES.includes(item.severity) ||
        typeof item.specialist !== "string" || !item.specialist.trim()) {
      throw new TypeError("Each diagnostic must have a valid specialist and severity");
    }
  }

  const activeNames = [...new Set(includedSpecialists)];
  const specialistScores = {};
  const unweightedSpecialists = [];
  for (const name of activeNames) {
    if (!Object.hasOwn(weights, name)) unweightedSpecialists.push(name);
    const relevant = safeDiagnostics.filter((item) => item.specialist === name);
    const penalty = relevant.reduce(
      (sum, item) => sum + (severityPenalties[item.severity] ?? 0),
      0
    );
    Object.defineProperty(specialistScores, name, {
      value: Math.max(0, 100 - penalty),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }

  const totalWeight = activeNames.reduce((sum, name) => sum + (Object.hasOwn(weights, name) ? weights[name] : 0), 0);
  if (!Number.isFinite(totalWeight)) {
    throw new TypeError("total weight must be a finite positive number");
  }
  const hasAssessments = activeNames.length > 0 && totalWeight > 0;
  const score = hasAssessments
    ? Math.round(activeNames.reduce(
        (sum, name) => sum + specialistScores[name] * (weights[name] ?? 0),
        0
      ) / totalWeight)
    : null;

  const hasCritical = safeDiagnostics.some((item) => item.severity === "critical");
  const blockedByCritical = Boolean(failOnCritical && hasCritical);
  const blockedByExecutionErrors = executionErrors > 0;
  const blockedByUnweightedFindings = unweightedSpecialists.some((name) =>
    safeDiagnostics.some((item) => item.specialist === name)
  );
  return Object.freeze({
    score,
    minimumScore,
    assessedSpecialists: Object.freeze(activeNames),
    specialistScores: Object.freeze(specialistScores),
    unweightedSpecialists: Object.freeze(unweightedSpecialists),
    passed: hasAssessments && score >= minimumScore && !blockedByCritical && !blockedByExecutionErrors && !blockedByUnweightedFindings,
    blockedByCritical,
    blockedByExecutionErrors,
    blockedByUnweightedFindings,
    noRulesExecuted: activeNames.length === 0
  });
}
