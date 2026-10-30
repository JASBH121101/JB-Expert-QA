import test from "node:test";
import assert from "node:assert/strict";
import {
  ExpertQAEngine,
  RuleRegistry,
  createDiagnostic,
  calculateScore
} from "../src/index.js";

const config = {
  profile: "test",
  weights: { "ui-ux": 50, responsive: 50 },
  severityPenalties: { critical: 25, high: 12, medium: 5, low: 2, info: 0 },
  thresholds: { failOnCritical: true }
};

test("registry rejects duplicate rule identifiers", () => {
  const registry = new RuleRegistry();
  const rule = { id: "test.rule", specialist: "ui-ux", evaluate: () => [] };
  registry.register(rule);
  assert.throws(() => registry.register(rule), /already registered/);
});

test("diagnostics require fields and valid severity", () => {
  assert.throws(() => createDiagnostic({ id: "x" }), /required/);
  assert.throws(() => createDiagnostic({
    id: "x", specialist: "ui-ux", title: "x", description: "x", severity: "urgent"
  }), /Unknown severity/);
});

test("engine runs rules and returns structured findings", async () => {
  const registry = new RuleRegistry();
  registry.register({
    id: "layout.overflow",
    specialist: "responsive",
    evaluate: () => ({
      id: "RESP-001",
      title: "Horizontal overflow",
      description: "Content exceeds the viewport width.",
      severity: "high",
      recommendation: "Inspect fixed widths and overflowing children."
    })
  });

  const report = await new ExpertQAEngine({ registry, config }).audit();
  assert.equal(report.summary.rulesExecuted, 1);
  assert.equal(report.summary.findings, 1);
  assert.equal(report.diagnostics[0].severity, "high");
  assert.equal(report.scoring.passed, true);
});

test("configured minimum score controls approval", () => {
  const result = calculateScore([], {
    weights: config.weights,
    minimumScore: 101
  });
  assert.equal(result.passed, false);
});

test("critical findings block approval", () => {
  const result = calculateScore([{
    specialist: "ui-ux",
    severity: "critical"
  }], { weights: config.weights, failOnCritical: true });
  assert.equal(result.passed, false);
  assert.equal(result.blockedByCritical, true);
});

test("rule execution errors are reported without crashing the audit", async () => {
  const registry = new RuleRegistry();
  registry.register({
    id: "test.failure",
    specialist: "ui-ux",
    evaluate() { throw new Error("simulated failure"); }
  });

  const report = await new ExpertQAEngine({ registry, config }).audit();
  assert.equal(report.summary.rulesWithErrors, 1);
  assert.equal(report.execution[0].status, "error");
});
