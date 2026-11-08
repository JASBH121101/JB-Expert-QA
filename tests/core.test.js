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

test("registry supports project-specific specialist identifiers", () => {
  const registry = new RuleRegistry();
  registry.register({
    id: "erp.inventory.low-stock",
    specialist: "erp-inventory",
    evaluate: () => []
  });
  assert.deepEqual(registry.listSpecialists(), ["erp-inventory"]);
  assert.equal(registry.list({ specialist: "erp-inventory" }).length, 1);
});

test("registry rejects malformed specialist identifiers", () => {
  const registry = new RuleRegistry();
  assert.throws(() => registry.register({
    id: "invalid.specialist",
    specialist: "ERP Inventory",
    evaluate: () => []
  }), /valid specialist id/);
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
  assert.equal(report.version, "0.7.0");
  assert.deepEqual(report.summary.specialists, ["responsive"]);
});

test("engine supports project-specific specialists when their weight is configured", async () => {
  const registry = new RuleRegistry();
  registry.register({
    id: "erp.inventory.integrity",
    specialist: "erp-inventory",
    evaluate: () => []
  });
  const report = await new ExpertQAEngine({
    registry,
    config: { weights: { "erp-inventory": 100 } }
  }).audit();
  assert.equal(report.scoring.score, 100);
  assert.equal(report.scoring.passed, true);
});

test("configured minimum score controls approval", () => {
  const result = calculateScore([{
    specialist: "responsive",
    severity: "medium"
  }], {
    weights: config.weights,
    minimumScore: 98
  });
  assert.equal(result.score, 98);
  assert.equal(result.passed, true);
});

test("only specialists included in the audit affect its score", () => {
  const result = calculateScore([{
    specialist: "responsive",
    severity: "high"
  }], {
    weights: { responsive: 20, "ui-ux": 20, accessibility: 15, performance: 15, functional: 20, consistency: 10 },
    includedSpecialists: ["responsive"]
  });
  assert.equal(result.score, 88);
  assert.deepEqual(result.assessedSpecialists, ["responsive"]);
});

test("audit cannot pass when a rule execution fails", async () => {
  const registry = new RuleRegistry();
  registry.register({
    id: "test.failure",
    specialist: "ui-ux",
    evaluate() { throw new Error("simulated failure"); }
  });
  const report = await new ExpertQAEngine({ registry, config }).audit();
  assert.equal(report.scoring.passed, false);
  assert.equal(report.scoring.blockedByExecutionErrors, true);
});

test("audit with no registered rules cannot pass", async () => {
  const report = await new ExpertQAEngine({
    registry: new RuleRegistry(),
    config
  }).audit();
  assert.equal(report.scoring.score, null);
  assert.equal(report.scoring.passed, false);
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

test("rule timeouts bound stalled asynchronous specialists and fail the audit closed", async () => {
  const registry = new RuleRegistry();
  let receivedSignal;
  registry.register({
    id: "test.stalled",
    specialist: "ui-ux",
    evaluate(_context, { signal }) {
      receivedSignal = signal;
      return new Promise(() => {});
    }
  });

  const report = await new ExpertQAEngine({
    registry,
    config: { weights: { "ui-ux": 100 }, execution: { ruleTimeoutMs: 10 } }
  }).audit();

  assert.equal(report.summary.rulesWithErrors, 1);
  assert.equal(report.execution[0].status, "error");
  assert.match(report.execution[0].error, /timed out after 10 ms/);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(report.scoring.blockedByExecutionErrors, true);
  assert.equal(report.scoring.passed, false);
});

test("rule execution errors redact credentials and bound report text", async () => {
  const registry = new RuleRegistry();
  registry.register({
    id: "test.secret-error",
    specialist: "ui-ux",
    evaluate() {
      throw new Error("failed https://example.invalid/path?token=url-secret Authorization: Bearer bearer-secret api_key=key-secret " + "x".repeat(2000));
    }
  });
  const report = await new ExpertQAEngine({
    registry,
    config: { weights: { "ui-ux": 100 } }
  }).audit();

  const error = report.execution[0].error;
  assert.equal(error.includes("url-secret"), false);
  assert.equal(error.includes("bearer-secret"), false);
  assert.equal(error.includes("key-secret"), false);
  assert.ok(error.length <= 512);
  assert.match(error, /REDACTED/);
});

test("execution timeout configuration is validated and bounded", () => {
  assert.throws(() => new ExpertQAEngine({
    registry: new RuleRegistry(),
    config: { execution: { ruleTimeoutMs: 0 } }
  }), /between 1 and 120000/);
  assert.throws(() => new ExpertQAEngine({
    registry: new RuleRegistry(),
    config: { execution: { unexpected: true } }
  }), /Unknown execution option/);
});
