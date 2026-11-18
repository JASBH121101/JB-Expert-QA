import test from "node:test";
import assert from "node:assert/strict";

import {
  createUnifiedThreatLabCertificationReport,
  UNIFIED_THREAT_LAB_REPORT_SCHEMA
} from "../src/certification-report.js";

const LEVELS = ["basic", "intermediate", "advanced", "expert", "extreme", "superextreme"];

function sourceReport(reportId, targetId = "jb-malware-engine", statusByLevel = {}) {
  return {
    reportId,
    report: {
      schema: "jb.threat-lab.report/v2",
      lab: { name: "JB Threat Lab", version: "0.2.0" },
      startedAt: "2026-11-18T10:00:00.000Z",
      completedAt: "2026-11-18T10:00:01.000Z",
      metadata: { suite: reportId, networkRequests: 0, productionTargets: false },
      totals: { pass: 6, fail: 0, skip: 0 },
      results: LEVELS.map((difficulty) => {
        const status = statusByLevel[difficulty] ?? "pass";
        return {
          target: { id: targetId, kind: "security-engine", version: "0.6.2" },
          scenario: {
            id: "scenario-" + targetId + "-" + difficulty,
            category: "calibration",
            difficulty
          },
          status,
          skipReason: status === "skip" ? "adapter" : null,
          summary: "Synthetic unit fixture",
          findings: [],
          metrics: {},
          durationMs: 1
        };
      })
    }
  };
}

test("unified report consolidates multiple engine reports and six difficulty tiers", () => {
  const report = createUnifiedThreatLabCertificationReport({
    reports: [
      sourceReport("malware-suite"),
      sourceReport("advisor-suite", "jb-advisor-engine")
    ],
    requiredTargets: ["jb-malware-engine", "jb-advisor-engine"],
    commit: "a".repeat(40)
  });

  assert.equal(report.schema, UNIFIED_THREAT_LAB_REPORT_SCHEMA);
  assert.equal(report.scope.sourceReports, 2);
  assert.deepEqual(report.scope.missingTargets, []);
  assert.deepEqual(report.totals, {
    pass: 12,
    fail: 0,
    skip: 0,
    targetScopeSkips: 0,
    nonScopeSkips: 0
  });
  assert.equal(report.assessment.ready, true);
  assert.deepEqual(report.assessment.targets.map((item) => item.target.id).sort(), [
    "jb-advisor-engine",
    "jb-malware-engine"
  ]);
});

test("missing required engine and missing difficulty level cannot be certified ready", () => {
  const incomplete = sourceReport("incomplete", "jb-malware-engine");
  incomplete.report.results = incomplete.report.results.filter((item) =>
    item.scenario.difficulty !== "superextreme"
  );

  const report = createUnifiedThreatLabCertificationReport({
    reports: [incomplete],
    requiredTargets: ["jb-malware-engine", "jb-security-guard"]
  });

  assert.deepEqual(report.scope.missingTargets, ["jb-security-guard"]);
  assert.ok(report.assessment.targets[0].missingLevels.includes("superextreme"));
  assert.equal(report.assessment.ready, false);
});

test("adapter skip and failed results prevent readiness", () => {
  const skipped = sourceReport("adapter-skip", "jb-malware-engine", { expert: "skip" });
  const report = createUnifiedThreatLabCertificationReport({
    reports: [skipped],
    requiredTargets: ["jb-malware-engine"]
  });
  assert.equal(report.totals.nonScopeSkips, 1);
  assert.equal(report.assessment.ready, false);

  const failed = sourceReport("failed-run", "jb-malware-engine", { extreme: "fail" });
  const failedReport = createUnifiedThreatLabCertificationReport({
    reports: [failed],
    requiredTargets: ["jb-malware-engine"]
  });
  assert.equal(failedReport.totals.fail, 1);
  assert.equal(failedReport.assessment.ready, false);
});

test("duplicate target/scenario results are rejected instead of double-counted", () => {
  const first = sourceReport("first");
  const second = sourceReport("second");
  second.report.results[0].scenario.id = first.report.results[0].scenario.id;
  assert.throws(() => createUnifiedThreatLabCertificationReport({
    reports: [first, second],
    requiredTargets: ["jb-malware-engine"]
  }), /Duplicate target\/scenario result/);
});

test("conflicting target versions across reports are rejected", () => {
  const first = sourceReport("first");
  const second = sourceReport("second");
  second.report.results[0].target.version = "0.7.0";
  assert.throws(() => createUnifiedThreatLabCertificationReport({
    reports: [first, second],
    requiredTargets: ["jb-malware-engine"]
  }), /conflicting kind\/version/);
});

test("malformed or unsupported source report schemas are rejected", () => {
  const invalid = sourceReport("invalid");
  invalid.report.schema = "jb.threat-lab.report/v1";
  assert.throws(() => createUnifiedThreatLabCertificationReport({
    reports: [invalid],
    requiredTargets: ["jb-malware-engine"]
  }), /must use jb.threat-lab.report\/v2/);
});

test("structural target-scope skips remain visible but do not reduce applicable coverage", () => {
  const complete = sourceReport("complete");
  complete.report.results.push({
    target: { id: "jb-security-guard", kind: "runtime-security", version: "0.1.0" },
    scenario: { id: "malware-only-scenario", category: "malware", difficulty: "basic" },
    status: "skip",
    skipReason: "target_scope",
    summary: "Scenario is not assigned to this target",
    findings: [],
    metrics: {},
    durationMs: 0
  });
  const report = createUnifiedThreatLabCertificationReport({
    reports: [complete],
    requiredTargets: ["jb-malware-engine"]
  });
  assert.equal(report.totals.targetScopeSkips, 1);
  assert.equal(report.totals.nonScopeSkips, 0);
  assert.equal(report.assessment.ready, true);
});
