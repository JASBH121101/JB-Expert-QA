import test from "node:test";
import assert from "node:assert/strict";
import { ExpertQAEngine, RuleRegistry } from "../src/index.js";

const config = {
  profile: "regression-matrix",
  weights: { responsive: 100 },
  severityPenalties: { critical: 25, high: 12, medium: 5, low: 2, info: 0 },
  thresholds: { minimumScore: 80, failOnCritical: true }
};

function makeFinding(id, title) {
  return {
    id,
    title,
    description: "Deterministic regression fixture.",
    severity: "low",
    metadata: { fixture: "regression-matrix" }
  };
}

test("registry snapshots rule definitions against later caller mutation", () => {
  const registry = new RuleRegistry();
  const rule = {
    id: "regression.stable",
    specialist: "responsive",
    evaluate: () => []
  };

  registry.register(rule);
  rule.id = "regression.changed";
  rule.specialist = "ui-ux";
  rule.evaluate = () => {
    throw new Error("mutated caller rule must not replace registered behavior");
  };

  const registered = registry.get("regression.stable");
  assert.ok(registered);
  assert.equal(registered.id, "regression.stable");
  assert.equal(registered.specialist, "responsive");
  assert.deepEqual(registered.evaluate(), []);
  assert.equal(registry.get("regression.changed"), null);
  assert.ok(Object.isFrozen(registered));
});

test("repeated audits preserve deterministic finding, scoring and rule order", async () => {
  const registry = new RuleRegistry();
  registry.register({
    id: "regression.alpha",
    specialist: "responsive",
    evaluate: () => [makeFinding("REG-001", "First fixture")]
  });
  registry.register({
    id: "regression.beta",
    specialist: "responsive",
    evaluate: () => [makeFinding("REG-002", "Second fixture")]
  });

  const engine = new ExpertQAEngine({ registry, config });
  const first = await engine.audit();
  const second = await engine.audit();

  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.deepEqual(first.scoring, second.scoring);
  assert.deepEqual(
    first.execution.map(({ ruleId, status }) => ({ ruleId, status })),
    second.execution.map(({ ruleId, status }) => ({ ruleId, status }))
  );
  assert.deepEqual(
    first.diagnostics.map(({ id, ruleId }) => ({ id, ruleId })),
    [
      { id: "REG-001", ruleId: "regression.alpha" },
      { id: "REG-002", ruleId: "regression.beta" }
    ]
  );
  assert.equal(first.scoring.passed, true);
});

test("audit reports detach finding records from mutable fixture objects", async () => {
  const fixture = makeFinding("REG-DETACH", "Original fixture title");
  const registry = new RuleRegistry();
  registry.register({
    id: "regression.fixture",
    specialist: "responsive",
    evaluate: () => fixture
  });

  const report = await new ExpertQAEngine({ registry, config }).audit();
  fixture.title = "Mutated after audit";
  fixture.metadata.fixture = "mutated";

  assert.equal(report.diagnostics[0].title, "Original fixture title");
  assert.equal(report.diagnostics[0].metadata.fixture, "regression-matrix");
  assert.ok(Object.isFrozen(report.diagnostics[0]));
  assert.ok(Object.isFrozen(report.diagnostics[0].metadata));
});
