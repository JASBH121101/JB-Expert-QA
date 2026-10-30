import { DEFAULT_SEVERITY_PENALTIES } from "./severities.js";

export function calculateScore(diagnostics, {
  weights = {},
  severityPenalties = DEFAULT_SEVERITY_PENALTIES,
  minimumScore = 80,
  failOnCritical = true,
  includedSpecialists = Object.keys(weights),
  executionErrors = 0
} = {}) {
  if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 100) {
    throw new TypeError("minimumScore must be a number between 0 and 100");
  }
  if (!Number.isInteger(executionErrors) || executionErrors < 0) {
    throw new TypeError("executionErrors must be a non-negative integer");
  }

  const activeNames = [...new Set(includedSpecialists)];
  const specialistScores = {};
  for (const name of activeNames) {
    if (!(name in weights)) {
      throw new TypeError(`Missing scoring weight for specialist "${name}"`);
    }
    const weight = Number(weights[name]);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new TypeError(`Invalid weight for specialist "${name}"`);
    }
    const relevant = diagnostics.filter((item) => item.specialist === name);
    const penalty = relevant.reduce(
      (sum, item) => sum + (severityPenalties[item.severity] ?? 0),
      0
    );
    specialistScores[name] = Math.max(0, 100 - penalty);
  }

  const totalWeight = activeNames.reduce((sum, name) => sum + Number(weights[name]), 0);
  const hasAssessments = activeNames.length > 0 && totalWeight > 0;
  const score = hasAssessments
    ? Math.round(activeNames.reduce(
        (sum, name) => sum + specialistScores[name] * Number(weights[name]),
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
