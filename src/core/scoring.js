import { DEFAULT_SEVERITY_PENALTIES } from "./severities.js";

export function calculateScore(diagnostics, {
  weights = {},
  severityPenalties = DEFAULT_SEVERITY_PENALTIES,
  failOnCritical = true
} = {}) {
  const specialistScores = {};
  const names = Object.keys(weights);

  for (const name of names) {
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

  const totalWeight = names.reduce((sum, name) => sum + Number(weights[name]), 0);
  const score = totalWeight === 0
    ? 100
    : Math.round(names.reduce(
        (sum, name) => sum + specialistScores[name] * Number(weights[name]),
        0
      ) / totalWeight);

  const hasCritical = diagnostics.some((item) => item.severity === "critical");
  return Object.freeze({
    score,
    specialistScores: Object.freeze(specialistScores),
    passed: score >= 80 && !(failOnCritical && hasCritical),
    blockedByCritical: Boolean(failOnCritical && hasCritical)
  });
}
