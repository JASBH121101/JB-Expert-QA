const LEVEL_DEFINITIONS = [
  {
    id: "basic",
    rank: 1,
    weight: 1,
    objective: "Verify known, deterministic behavior and essential safety controls."
  },
  {
    id: "intermediate",
    rank: 2,
    weight: 2,
    objective: "Exercise variations, normalization, malformed inputs, and common boundary conditions."
  },
  {
    id: "advanced",
    rank: 3,
    weight: 4,
    objective: "Combine multiple signals, input families, state transitions, and cross-feature behavior."
  },
  {
    id: "expert",
    rank: 4,
    weight: 8,
    objective: "Probe chained failures, false-positive resistance, recovery paths, and invariant preservation."
  },
  {
    id: "extreme",
    rank: 5,
    weight: 16,
    objective: "Stress adversarial combinations, concurrency, resource ceilings, and degraded dependencies using bounded local fixtures."
  },
  {
    id: "superextreme",
    rank: 6,
    weight: 32,
    objective: "Validate compound failure paths, long sequences, adversarial edge cases, and recovery invariants under strict disposable test boundaries."
  }
];

export const THREAT_LAB_DIFFICULTY_LEVELS = Object.freeze(
  LEVEL_DEFINITIONS.map((level) => Object.freeze({ ...level }))
);

const LEVELS_BY_ID = new Map(
  THREAT_LAB_DIFFICULTY_LEVELS.map((level) => [level.id, level])
);

export function normalizeDifficulty(value, fallback = "basic") {
  const selected = value ?? fallback;
  if (selected === null) return null;
  if (typeof selected !== "string" || !LEVELS_BY_ID.has(selected)) {
    throw new TypeError(
      "difficulty must be one of: " + THREAT_LAB_DIFFICULTY_LEVELS.map((level) => level.id).join(", ")
    );
  }
  return selected;
}

function percentage(numerator, denominator) {
  if (denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function summarizeResults(results, requiredLevels) {
  const byLevel = requiredLevels.map((level) => {
    const entries = results.filter((result) => result.scenario?.difficulty === level.id);
    const passed = entries.filter((result) => result.status === "pass").length;
    const failed = entries.filter((result) => result.status === "fail").length;
    const skipped = entries.filter((result) => result.status === "skip").length;
    const executed = passed + failed;
    const weightAvailable = entries.length * level.weight;
    const weightEarned = passed * level.weight;

    return {
      id: level.id,
      rank: level.rank,
      weight: level.weight,
      total: entries.length,
      passed,
      failed,
      skipped,
      executionCoveragePct: percentage(executed, entries.length),
      weightedScorePct: percentage(weightEarned, weightAvailable),
      complete: entries.length > 0 && failed === 0 && skipped === 0
    };
  });

  const total = byLevel.reduce((sum, level) => sum + level.total, 0);
  const passed = byLevel.reduce((sum, level) => sum + level.passed, 0);
  const failed = byLevel.reduce((sum, level) => sum + level.failed, 0);
  const skipped = byLevel.reduce((sum, level) => sum + level.skipped, 0);
  const executed = passed + failed;
  const weightedAvailable = byLevel.reduce((sum, level) => sum + level.total * level.weight, 0);
  const weightedEarned = byLevel.reduce((sum, level) => sum + level.passed * level.weight, 0);

  return {
    total,
    passed,
    failed,
    skipped,
    executionCoveragePct: percentage(executed, total),
    weightedScorePct: percentage(weightedEarned, weightedAvailable),
    coveredLevels: byLevel.filter((level) => level.total > 0).map((level) => level.id),
    missingLevels: byLevel.filter((level) => level.total === 0).map((level) => level.id),
    levels: byLevel,
    ready: byLevel.length > 0 && byLevel.every((level) => level.complete)
  };
}

/**
 * Scores only target-applicable scenarios. A target-scope skip is structural
 * matrix output, not an unexecuted test. Adapter and report-budget skips remain
 * visible and prevent certification readiness.
 */
export function assessThreatLabDifficulty(results, requestedDifficulty = "superextreme") {
  if (!Array.isArray(results)) throw new TypeError("results must be an array");
  const selected = normalizeDifficulty(requestedDifficulty, "superextreme");
  const selectedLevel = LEVELS_BY_ID.get(selected);
  const requiredLevels = THREAT_LAB_DIFFICULTY_LEVELS.filter(
    (level) => level.rank <= selectedLevel.rank
  );
  const applicable = results.filter((result) => result?.skipReason !== "target_scope");
  const overall = summarizeResults(applicable, requiredLevels);
  const targetIds = [...new Set(applicable.map((result) => result?.target?.id).filter(Boolean))];

  const targets = targetIds.map((id) => {
    const targetResults = applicable.filter((result) => result.target?.id === id);
    const first = targetResults[0]?.target ?? {};
    return {
      target: { id: first.id, kind: first.kind ?? "unknown", version: first.version ?? "unknown" },
      ...summarizeResults(targetResults, requiredLevels)
    };
  });

  return {
    requestedDifficulty: selected,
    requiredLevels: requiredLevels.map((level) => level.id),
    ...overall,
    ready: targets.length > 0 && targets.every((target) => target.ready),
    targets
  };
}
