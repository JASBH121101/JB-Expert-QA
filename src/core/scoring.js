import { DEFAULT_SEVERITY_PENALTIES, SEVERITIES } from "./severities.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function calculateScore(diagnostics, {
  weights = {},
  severityPenalties = DEFAULT_SEVERITY_PENALTIES,
  minimumScore = 80,
  failOnCritical = true,
  includedSpecialists = Object.keys(weights),
  executionErrors = 0
} = {}) {
  if (!Array.isArray(diagnostics)) {
    throw new TypeError("diagnostics must be an array");
  }
  if (!isRecord(weights)) {
    throw new TypeError("weights must be an object");
  }
  if (!isRecord(severityPenalties)) {
    throw new TypeError("severityPenalties must be an object");
  }
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
  for (const item of diagnostics) {
    if (!item || !SEVERITIES.includes(item.severity) ||
        typeof item.specialist !== "string" || !item.specialist.trim()) {
      throw new TypeError("Each diagnostic must have a valid specialist and severity");
    }
  }

  const activeNames = [...new Set(includedSpecialists)];
  const specialistScores = {};
  for (const name of activeNames) {
    if (!Object.hasOwn(weights, name)) {
      throw new TypeError("Missing scoring weight for specialist \"" + name + "\"");
    }
    const relevant = diagnostics.filter((item) => item.specialist === name);
    const penalty = relevant.reduce(
      (sum, item) => sum + (severityPenalties[item.severity] ?? 0),
      0
    );
    specialistScores[name] = Math.max(0, 100 - penalty);
  }

  const totalWeight = activeNames.reduce((sum, name) => sum + weights[name], 0);
  const hasAssessments = activeNames.length > 0 && totalWeight > 0;
  const score = hasAssessments
    ? Math.round(activeNames.reduce(
        (sum, name) => sum + specialistScores[name] * weights[name],
        0
      ) / totalWeight)
    : null;

  const hasCritical = diagnostics.some((item) => item.severity === "critical");
  const blockedByCritical = Boolean(failOnCritical && hasCritical);
  const blockedByExecutionErrors = executionErrors > 0;
  return Object.freeze({
    score,
    minimumScore,
    assessedSpecialists: Object.freeze(activeNames),
    specialistScores: Object.freeze(specialistScores),
    passed: hasAssessments && score >= minimumScore && !blockedByCritical && !blockedByExecutionErrors,
    blockedByCritical,
    blockedByExecutionErrors,
    noRulesExecuted: activeNames.length === 0
  });
}
