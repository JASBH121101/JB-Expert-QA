import test from "node:test";
import assert from "node:assert/strict";
import { buildConsolidatedReport, buildDashboardAnalytics } from "../src/dashboard/analytics.js";

const engines = [
  { id: "static", name: "Static QA" },
  { id: "live-site", name: "Live Site QA" },
  { id: "responsive", name: "Responsive QA" }
];

function record(id, engineId, targetHash, createdAt, values = {}) {
  return {
    id,
    engineId,
    engineName: engines.find((engine) => engine.id === engineId)?.name ?? engineId,
    targetHash,
    targetLabel: "Project: demo",
    createdAt,
    outcome: "passed",
    score: 95,
    findingsCount: 0,
    findings: [],
    ...values
  };
}

test("analytics keeps the newest snapshot per engine and target identity", () => {
  const history = [
    record("run-3", "static", "project-A", "2026-11-23T03:00:00.000Z", { score: 90, findingsCount: 1,
      findings: [{ id: "S-1", ruleId: "static.no-alt", title: "Missing alt", severity: "medium" }] }),
    record("run-1", "static", "project-A", "2026-11-23T01:00:00.000Z", { score: 65, outcome: "not_passed", findingsCount: 2 }),
    record("run-2", "live-site", "project-A", "2026-11-23T02:00:00.000Z", { score: 80, findingsCount: 1,
      findings: [{ id: "W-1", ruleId: "web.header", title: "Header warning", severity: "high" }] })
  ];
  const result = buildDashboardAnalytics(history, engines);
  assert.equal(result.retainedHistoryCount, 3);
  assert.equal(result.currentSnapshotCount, 2);
  assert.equal(result.activeFindingCount, 2);
  assert.equal(result.averageCurrentScore, 85);
  assert.equal(result.currentOutcomes.passed, 2);
  assert.equal(result.currentOutcomes.notPassed, 0);
  assert.equal(result.severityCounts.medium, 1);
  assert.equal(result.severityCounts.high, 1);
  assert.equal(result.assessment, "REVIEW_REQUIRED");
});

test("analytics reports engine coverage, unclassified findings and recent history deltas", () => {
  const history = [
    record("run-1", "static", "A", "2026-11-23T01:00:00.000Z", {
      findingsCount: 4,
      findings: [{ id: "S-1", ruleId: "static.rule", title: "Finding", severity: "critical" }],
      findingsOmitted: 3,
      comparison: { newFindingsCount: 2, resolvedFindingsCount: 1 }
    })
  ];
  const result = buildDashboardAnalytics(history, engines);
  assert.equal(result.usedEngineCount, 1);
  assert.equal(result.availableEngineCount, 3);
  assert.equal(result.coveragePercent, 33);
  assert.equal(result.findingsNotClassified, 3);
  assert.equal(result.recentChanges.newFindings, 2);
  assert.equal(result.recentChanges.resolvedFindings, 1);
  assert.equal(result.engineCoverage.find((item) => item.engineId === "responsive").auditCount, 0);
});

test("top findings are ranked by severity before frequency and combine repeated rules", () => {
  const history = [
    record("run-2", "live-site", "B", "2026-11-23T02:00:00.000Z", {
      findingsCount: 2,
      findings: [
        { id: "H-1", ruleId: "security.header", title: "Header issue", severity: "high" },
        { id: "H-2", ruleId: "security.header", title: "Header issue", severity: "critical" }
      ]
    }),
    record("run-1", "static", "A", "2026-11-23T01:00:00.000Z", {
      findingsCount: 1,
      findings: [{ id: "L-1", ruleId: "style.spacing", title: "Spacing issue", severity: "low" }]
    })
  ];
  const result = buildDashboardAnalytics(history, engines);
  assert.equal(result.topFindings[0].ruleId, "security.header");
  assert.equal(result.topFindings[0].occurrences, 2);
  assert.equal(result.topFindings[0].severity, "critical");
  assert.deepEqual(result.topFindings[0].engines, ["live-site"]);
});

test("empty history produces a NOT_ASSESSED report, never a false pass", () => {
  const result = buildDashboardAnalytics([], engines);
  assert.equal(result.assessment, "NOT_ASSESSED");
  assert.equal(result.averageCurrentScore, null);
  assert.equal(result.cleanPassRate, null);
  assert.equal(result.currentSnapshotCount, 0);
  const report = buildConsolidatedReport([], engines, new Date("2026-11-23T00:00:00.000Z"));
  assert.match(report, /NOT_ASSESSED/);
  assert.match(report, /No saved audit snapshot is available/);
  assert.match(report, /does not mean every engine audited the same target/);
});

test("findings whose detail was capped remain observations, not a clean pass", () => {
  const history = [
    record("run-1", "static", "A", "2026-11-23T01:00:00.000Z", {
      outcome: "passed_with_observations",
      findingsCount: 125,
      findings: [],
      findingsOmitted: 125
    })
  ];
  const result = buildDashboardAnalytics(history, engines);
  assert.equal(result.activeFindingCount, 125);
  assert.equal(result.findingsNotClassified, 125);
  assert.equal(result.assessment, "OBSERVATIONS");
  assert.equal(result.cleanPassRate, 0);
});
