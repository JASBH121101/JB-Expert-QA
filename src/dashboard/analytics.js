const SEVERITY_ORDER = Object.freeze(["critical", "high", "medium", "low", "info", "other"]);
const SEVERITY_WEIGHT = Object.freeze({ critical: 5, high: 4, medium: 3, low: 2, info: 1, other: 0 });

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function timestamp(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function severity(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SEVERITY_ORDER.includes(normalized) ? normalized : "other";
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function targetIdentity(record) {
  return String(record.targetHash || record.targetLabel || "unknown-target");
}

function issueIdentity(finding) {
  return String(finding.ruleId || finding.id || finding.title || "unknown-rule")
    .trim().toLowerCase();
}

function safeMarkdown(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\|/g, "\\|")
    .slice(0, 240);
}

function assessmentFor(snapshots, severities) {
  if (!snapshots.length) return "NOT_ASSESSED";
  if (snapshots.some((record) => record.outcome === "not_passed")) return "NOT_PASSED";
  if (severities.critical > 0 || severities.high > 0) return "REVIEW_REQUIRED";
  if (SEVERITY_ORDER.some((key) => severities[key] > 0)) return "OBSERVATIONS";
  return "PASSED_WITHIN_RECORDED_SCOPE";
}

/**
 * Aggregate local dashboard history without treating mixed targets as one
 * project certification. The retained history is bounded by the caller.
 */
export function buildDashboardAnalytics(history, engineDefinitions = []) {
  if (!Array.isArray(history)) throw new TypeError("history must be an array");
  if (!Array.isArray(engineDefinitions)) throw new TypeError("engineDefinitions must be an array");

  const records = history
    .filter((item) => item && typeof item === "object" && !Array.isArray(item) &&
      typeof item.engineId === "string" && typeof item.id === "string")
    .slice()
    .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));

  const latestByEngineTarget = new Map();
  for (const record of records) {
    const key = record.engineId + "\n" + targetIdentity(record);
    const current = latestByEngineTarget.get(key);
    if (!current || timestamp(record.createdAt) > timestamp(current.createdAt)) {
      latestByEngineTarget.set(key, record);
    }
  }
  const snapshots = [...latestByEngineTarget.values()]
    .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));

  const severityCounts = Object.fromEntries(SEVERITY_ORDER.map((key) => [key, 0]));
  const findingGroups = new Map();
  let activeFindingCount = 0;
  let findingsNotClassified = 0;

  for (const record of snapshots) {
    activeFindingCount += safeCount(record.findingsCount);
    const findings = Array.isArray(record.findings) ? record.findings : [];
    for (const finding of findings) {
      const level = severity(finding?.severity);
      severityCounts[level] += 1;
      const key = issueIdentity(finding);
      const existing = findingGroups.get(key);
      if (existing) {
        existing.occurrences += 1;
        existing.severity = (SEVERITY_WEIGHT[level] ?? 0) > (SEVERITY_WEIGHT[existing.severity] ?? 0)
          ? level : existing.severity;
        existing.engines.add(record.engineId);
      } else {
        findingGroups.set(key, {
          ruleId: String(finding?.ruleId || finding?.id || "unclassified").slice(0, 160),
          title: String(finding?.title || "QA finding").slice(0, 240),
          severity: level,
          occurrences: 1,
          engines: new Set([record.engineId])
        });
      }
    }
    findingsNotClassified += Math.max(0, safeCount(record.findingsCount) - findings.length);
  }

  const availableEngines = engineDefinitions
    .filter((item) => item && typeof item.id === "string")
    .map((item) => ({ id: item.id, name: String(item.name || item.id) }));
  const knownIds = new Set(availableEngines.map((item) => item.id));
  for (const record of records) {
    if (!knownIds.has(record.engineId)) {
      availableEngines.push({ id: record.engineId, name: String(record.engineName || record.engineId) });
      knownIds.add(record.engineId);
    }
  }

  const engineCoverage = availableEngines.map((engine) => {
    const engineRecords = records.filter((record) => record.engineId === engine.id);
    const engineSnapshots = snapshots.filter((record) => record.engineId === engine.id);
    const latest = engineRecords[0] ?? null;
    const scores = engineRecords.map((record) => record.score).filter(finite);
    return {
      engineId: engine.id,
      engineName: engine.name,
      auditCount: engineRecords.length,
      currentTargetCount: engineSnapshots.length,
      activeFindings: engineSnapshots.reduce((sum, record) => sum + safeCount(record.findingsCount), 0),
      averageScore: scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : null,
      latestOutcome: latest?.outcome ?? null,
      latestRunAt: latest?.createdAt ?? null
    };
  });

  const currentOutcomes = {
    passed: snapshots.filter((record) => record.outcome === "passed").length,
    observations: snapshots.filter((record) => record.outcome === "passed_with_observations").length,
    notPassed: snapshots.filter((record) => record.outcome === "not_passed").length
  };
  const scores = snapshots.map((record) => record.score).filter(finite);
  const availableEngineCount = availableEngines.length;
  const usedEngineCount = engineCoverage.filter((engine) => engine.auditCount > 0).length;
  const topFindings = [...findingGroups.values()]
    .sort((a, b) => (SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]) ||
      (b.occurrences - a.occurrences) || a.title.localeCompare(b.title))
    .slice(0, 10)
    .map((item) => ({ ...item, engines: [...item.engines].sort() }));

  const scoreTrend = records.slice(0, 12).reverse().map((record) => ({
    id: record.id,
    createdAt: record.createdAt,
    engineId: record.engineId,
    engineName: String(record.engineName || record.engineId),
    targetLabel: String(record.targetLabel || "Unknown target"),
    score: finite(record.score) ? record.score : null,
    outcome: String(record.outcome || "unknown")
  }));

  const recent = records.slice(0, 10);
  const newFindingsLast10 = recent.reduce((sum, record) =>
    sum + safeCount(record.comparison?.newFindingsCount), 0);
  const resolvedFindingsLast10 = recent.reduce((sum, record) =>
    sum + safeCount(record.comparison?.resolvedFindingsCount), 0);

  return {
    generatedAt: new Date().toISOString(),
    retainedHistoryCount: records.length,
    currentSnapshotCount: snapshots.length,
    targetCount: new Set(snapshots.map(targetIdentity)).size,
    availableEngineCount,
    usedEngineCount,
    coveragePercent: availableEngineCount ? Math.round(usedEngineCount / availableEngineCount * 100) : 0,
    averageCurrentScore: scores.length
      ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : null,
    activeFindingCount,
    findingsNotClassified,
    currentOutcomes,
    cleanPassRate: snapshots.length ? Math.round(currentOutcomes.passed / snapshots.length * 100) : null,
    severityCounts,
    assessment: assessmentFor(snapshots, severityCounts),
    engineCoverage,
    topFindings,
    scoreTrend,
    recentChanges: { windowRuns: recent.length, newFindings: newFindingsLast10, resolvedFindings: resolvedFindingsLast10 }
  };
}

export function buildConsolidatedReport(history, engineDefinitions = [], generatedAt = new Date()) {
  const analytics = buildDashboardAnalytics(history, engineDefinitions);
  const date = generatedAt instanceof Date ? generatedAt.toISOString() : new Date(generatedAt).toISOString();
  const lines = [
    "# JB Expert QA — Consolidated QA Intelligence Report",
    "",
    "- Generated: " + date,
    "- Assessment: **" + analytics.assessment + "**",
    "- Retained audit records: " + analytics.retainedHistoryCount,
    "- Latest engine/target snapshots: " + analytics.currentSnapshotCount,
    "- Distinct target labels in scope: " + analytics.targetCount,
    "- Engine coverage: " + analytics.usedEngineCount + "/" + analytics.availableEngineCount +
      " registered engines (" + analytics.coveragePercent + "%)",
    "- Average score across latest snapshots: " +
      (analytics.averageCurrentScore === null ? "Not available" : analytics.averageCurrentScore + "/100"),
    "- Active findings reported by latest snapshots: " + analytics.activeFindingCount,
    "- Findings not classifiable from retained finding detail: " + analytics.findingsNotClassified,
    "",
    "## Assessment and scope",
    "",
    analytics.assessment === "NOT_ASSESSED"
      ? "No saved audit snapshot is available. No assessment can be made."
      : analytics.assessment === "NOT_PASSED"
        ? "At least one latest engine/target snapshot did not pass."
        : analytics.assessment === "REVIEW_REQUIRED"
          ? "Critical or high-severity findings remain in the latest saved snapshots and require review."
          : analytics.assessment === "OBSERVATIONS"
            ? "Findings remain in the latest saved snapshots. Review the severity and engine breakdown below."
            : "No findings were recorded in the latest saved snapshots. This result applies only to the recorded scope.",
    "",
    "This report consolidates the dashboard's bounded local history. Each current snapshot is the newest saved run for one engine and target identity. Engine coverage means an engine appears somewhere in retained history; it does not mean every engine audited the same target.",
    "",
    "## Current outcome distribution",
    "",
    "| Outcome | Latest snapshots |",
    "| --- | ---: |",
    "| Passed with no recorded findings | " + analytics.currentOutcomes.passed + " |",
    "| Passed with observations | " + analytics.currentOutcomes.observations + " |",
    "| Not passed | " + analytics.currentOutcomes.notPassed + " |",
    "",
    "## Active finding severity",
    "",
    "| Severity | Count |",
    "| --- | ---: |",
    ...SEVERITY_ORDER.map((key) => "| " + key + " | " + analytics.severityCounts[key] + " |"),
    "",
    "## Engine coverage and current status",
    "",
    "| Engine | Historical runs | Current target snapshots | Active findings | Average score | Latest outcome |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...analytics.engineCoverage.map((engine) =>
      "| " + safeMarkdown(engine.engineName) + " | " + engine.auditCount + " | " +
      engine.currentTargetCount + " | " + engine.activeFindings + " | " +
      (engine.averageScore === null ? "—" : engine.averageScore + "/100") + " | " +
      safeMarkdown(engine.latestOutcome || "Not run") + " |"),
    "",
    "## Most recurrent findings in current snapshots",
    "",
    "| Rule / finding | Severity | Occurrences | Engines |",
    "| --- | --- | ---: | --- |",
    ...(analytics.topFindings.length
      ? analytics.topFindings.map((finding) =>
        "| " + safeMarkdown(finding.ruleId) + " — " + safeMarkdown(finding.title) + " | " +
        finding.severity + " | " + finding.occurrences + " | " +
        safeMarkdown(finding.engines.join(", ")) + " |")
      : ["| No retained findings | — | 0 | — |"]),
    "",
    "## Score trend — latest retained runs",
    "",
    "| Executed | Engine | Target | Score | Outcome |",
    "| --- | --- | --- | ---: | --- |",
    ...(analytics.scoreTrend.length
      ? analytics.scoreTrend.slice().reverse().map((item) =>
        "| " + safeMarkdown(item.createdAt) + " | " + safeMarkdown(item.engineName) + " | " +
        safeMarkdown(item.targetLabel) + " | " + (item.score === null ? "—" : item.score + "/100") +
        " | " + safeMarkdown(item.outcome) + " |")
      : ["| No audit records | — | — | — | — |"]),
    "",
    "## Recent finding changes",
    "",
    "- New findings across the latest " + analytics.recentChanges.windowRuns + " retained runs: " + analytics.recentChanges.newFindings,
    "- Resolved findings across the latest " + analytics.recentChanges.windowRuns + " retained runs: " + analytics.recentChanges.resolvedFindings,
    "",
    "## Limitations",
    "",
    "- Dashboard history is bounded; this report covers only records retained locally.",
    "- Finding details are capped per run. Counts may exceed the severities visible in this report.",
    "- Scores and findings are heuristic outputs from the individual auditors and are not directly comparable across different engines or targets.",
    "- This internal report is not a third-party certification, penetration test, accessibility conformance statement, or proof of production readiness.",
    ""
  ];
  return lines.join("\n");
}