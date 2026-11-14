import test from "node:test";
import assert from "node:assert/strict";
import { createThreatLab, THREAT_LAB_REPORT_SCHEMA } from "../src/index.js";
import { EICAR_TEST_STRING, createInertSuspiciousTextFixture, createSyntheticFixture } from "../src/fixtures.js";

test("registers independent targets and executes a scenario matrix", async () => {
  const lab = createThreatLab();
  const calls = [];
  lab.registerTarget({
    id: "malware-engine",
    kind: "security-engine",
    version: "0.6.2",
    capabilities: ["static-file-triage"],
    adapter: { async runScenario({ scenario }) { calls.push(scenario.id); return { status: "pass", summary: "Expected outcome observed" }; } }
  });
  lab.registerTarget({
    id: "nexora-app",
    kind: "application",
    adapter: { async runScenario() { return { status: "skip", summary: "Adapter not configured for this case" }; } }
  });
  lab.registerScenario({
    id: "benign-upload",
    category: "file-handling",
    description: "Verify a benign synthetic file is accepted under the target's policy.",
    safety: { safe: true, network: false, destructive: false, executesSample: false }
  });
  const report = await lab.run();
  assert.equal(report.schema, THREAT_LAB_REPORT_SCHEMA);
  assert.deepEqual(report.totals, { pass: 1, fail: 0, skip: 1 });
  assert.deepEqual(calls, ["benign-upload"]);
  assert.equal(report.results.length, 2);
});

test("rejects scenarios that are not explicitly safe and offline", () => {
  const lab = createThreatLab();
  const base = { id: "unsafe-case", category: "security", description: "unsafe", safety: { safe: true, network: true, destructive: false } };
  assert.throws(() => lab.registerScenario(base), /Scenario rejected/);
  assert.throws(() => lab.registerScenario({
    ...base,
    id: "missing-execution-boundary",
    safety: { safe: true, network: false, destructive: false }
  }), /Scenario rejected/);
  assert.throws(() => lab.registerScenario({
    ...base,
    id: "sample-execution-enabled",
    safety: { safe: true, network: false, destructive: false, executesSample: true }
  }), /Scenario rejected/);
  assert.throws(() => lab.registerScenario({
    ...base,
    id: "not-safe",
    safety: { safe: false, network: false, destructive: false, executesSample: false }
  }), /Scenario rejected/);
});

test("records adapter exceptions as failed checks without aborting the matrix", async () => {
  const lab = createThreatLab();
  lab.registerTarget({ id: "broken-adapter", kind: "test", adapter: { async runScenario() { throw new Error("controlled failure"); } } });
  lab.registerScenario({ id: "safe-check", category: "regression", description: "Inert regression case", safety: { safe: true, network: false, destructive: false, executesSample: false } });
  const report = await lab.run();
  assert.equal(report.totals.fail, 1);
  assert.equal(report.results[0].findings[0].code, "LAB_ADAPTER_ERROR");
});

test("fixtures are inert data and reject unknown types", () => {
  assert.match(EICAR_TEST_STRING, /EICAR-STANDARD-ANTIVIRUS-TEST-FILE/);
  assert.equal(createSyntheticFixture().executable, false);
  assert.equal(createInertSuspiciousTextFixture("sql-pattern").network, false);
  assert.throws(() => createInertSuspiciousTextFixture("unknown"), /Unsupported fixture/);
});

test("rejects duplicate target and scenario identifiers", () => {
  const lab = createThreatLab();
  const target = { id: "sample-target", kind: "test", adapter: { async runScenario() { return { status: "pass" }; } } };
  lab.registerTarget(target);
  assert.throws(() => lab.registerTarget(target), /already registered/);
  const scenario = { id: "sample-case", category: "test", description: "case", safety: { safe: true, network: false, destructive: false, executesSample: false } };
  lab.registerScenario(scenario);
  assert.throws(() => lab.registerScenario(scenario), /already registered/);
});

test("target-scoped scenarios skip unrelated engines without invoking their adapters", async () => {
  const lab = createThreatLab();
  const calls = [];
  lab.registerTarget({
    id: "engine-a",
    kind: "static-engine",
    adapter: { async runScenario({ scenario }) { calls.push("a:" + scenario.id); return { status: "pass" }; } }
  });
  lab.registerTarget({
    id: "engine-b",
    kind: "runtime-engine",
    adapter: { async runScenario({ scenario }) { calls.push("b:" + scenario.id); return { status: "pass" }; } }
  });
  lab.registerScenario({
    id: "static-only-check",
    category: "static",
    description: "Only the static engine should run this check.",
    appliesTo: ["engine-a"],
    safety: { safe: true, network: false, destructive: false, executesSample: false }
  });
  lab.registerScenario({
    id: "runtime-kind-check",
    category: "runtime",
    description: "Target kinds can be used to scope a reusable check.",
    appliesTo: ["runtime-engine"],
    safety: { safe: true, network: false, destructive: false, executesSample: false }
  });

  const report = await lab.run();
  assert.deepEqual(calls, ["a:static-only-check", "b:runtime-kind-check"]);
  assert.deepEqual(report.totals, { pass: 2, fail: 0, skip: 2 });
});
