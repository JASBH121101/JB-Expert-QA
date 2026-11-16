import test from "node:test";
import assert from "node:assert/strict";
import {
  assessThreatLabDifficulty,
  createThreatLab,
  THREAT_LAB_DIFFICULTY_LEVELS
} from "../src/index.js";

const safety = {
  safe: true,
  network: false,
  destructive: false,
  executesSample: false
};

function registerScenario(lab, id, difficulty, appliesTo = ["engine-a"]) {
  lab.registerScenario({
    id,
    category: "difficulty-calibration",
    description: "A deterministic, inert scenario for validating difficulty progression.",
    difficulty,
    appliesTo,
    safety
  });
}

test("exports six ordered difficulty tiers with strictly increasing weights", () => {
  assert.deepEqual(
    THREAT_LAB_DIFFICULTY_LEVELS.map(({ id }) => id),
    ["basic", "intermediate", "advanced", "expert", "extreme", "superextreme"]
  );
  for (let index = 1; index < THREAT_LAB_DIFFICULTY_LEVELS.length; index += 1) {
    assert.ok(
      THREAT_LAB_DIFFICULTY_LEVELS[index].weight > THREAT_LAB_DIFFICULTY_LEVELS[index - 1].weight
    );
  }
});

test("assigns legacy scenarios to basic and rejects unknown difficulty labels", () => {
  const lab = createThreatLab();
  const adapter = { async runScenario() { return { status: "pass" }; } };
  lab.registerTarget({ id: "engine-a", kind: "test-engine", adapter });
  lab.registerScenario({
    id: "legacy-scenario",
    category: "compatibility",
    description: "Existing scenarios remain compatible and default to basic.",
    safety
  });
  assert.equal(lab.listScenarios()[0].difficulty, "basic");
  assert.throws(
    () => registerScenario(lab, "invalid-level", "nightmare"),
    /difficulty must be one of/
  );
});

test("filters progressively through the selected difficulty and reports weighted results", async () => {
  const lab = createThreatLab();
  lab.registerTarget({
    id: "engine-a",
    kind: "test-engine",
    adapter: {
      async runScenario({ scenario }) {
        if (scenario.difficulty === "advanced") {
          return { status: "fail", summary: "Expected hard case failed", findings: [{ code: "HARD_CASE_MISSED" }] };
        }
        if (scenario.difficulty === "intermediate") {
          return { status: "pass", summary: "Variation handled" };
        }
        return { status: "pass", summary: "Baseline handled" };
      }
    }
  });

  for (const level of THREAT_LAB_DIFFICULTY_LEVELS) {
    registerScenario(lab, "case-" + level.id, level.id);
  }

  const advanced = await lab.run({ difficulty: "advanced" });
  assert.deepEqual(advanced.difficulty, {
    requested: "advanced",
    includedLevels: ["basic", "intermediate", "advanced"]
  });
  assert.equal(advanced.results.length, 3);
  assert.deepEqual(advanced.totals, { pass: 2, fail: 1, skip: 0 });
  assert.equal(advanced.assessment.total, 3);
  assert.equal(advanced.assessment.executionCoveragePct, 100);
  assert.equal(advanced.assessment.weightedScorePct, 42.86);
  assert.deepEqual(advanced.assessment.missingLevels, []);
  assert.equal(advanced.assessment.targets[0].failed, 1);
  assert.equal(advanced.assessment.ready, false);

  const basic = await lab.run({ difficulty: "basic" });
  assert.equal(basic.results.length, 1);
  assert.deepEqual(basic.difficulty.includedLevels, ["basic"]);
});

test("does not count target-scope skips as missing executions or falsely certify incomplete engines", async () => {
  const lab = createThreatLab();
  for (const id of ["engine-a", "engine-b"]) {
    lab.registerTarget({
      id,
      kind: "test-engine",
      adapter: { async runScenario() { return { status: "pass" }; } }
    });
  }
  registerScenario(lab, "alpha-basic", "basic", ["engine-a"]);
  registerScenario(lab, "beta-advanced", "advanced", ["engine-b"]);

  const report = await lab.run();
  assert.equal(report.results.length, 4);
  assert.equal(report.results.filter((result) => result.skipReason === "target_scope").length, 2);
  assert.equal(report.assessment.targets.length, 2);
  assert.equal(report.assessment.ready, false);

  const alpha = report.assessment.targets.find((item) => item.target.id === "engine-a");
  const beta = report.assessment.targets.find((item) => item.target.id === "engine-b");
  assert.deepEqual(alpha.coveredLevels, ["basic"]);
  assert.deepEqual(alpha.missingLevels, ["intermediate", "advanced", "expert", "extreme", "superextreme"]);
  assert.deepEqual(beta.coveredLevels, ["advanced"]);
  assert.equal(alpha.ready, false);
  assert.equal(beta.ready, false);
});

test("adapter skips remain visible and prevent a tier from being certified", async () => {
  const lab = createThreatLab();
  lab.registerTarget({
    id: "engine-a",
    kind: "test-engine",
    adapter: { async runScenario() { return { status: "skip", summary: "Adapter lacks this capability" }; } }
  });
  registerScenario(lab, "unimplemented-case", "expert");

  const report = await lab.run({ difficulty: "expert" });
  assert.equal(report.results[0].skipReason, "adapter");
  assert.equal(report.assessment.skipped, 1);
  assert.equal(report.assessment.executionCoveragePct, 0);
  assert.equal(report.assessment.ready, false);
});

test("validates a requested difficulty before starting any adapter", async () => {
  const lab = createThreatLab();
  let calls = 0;
  lab.registerTarget({
    id: "engine-a",
    kind: "test-engine",
    adapter: { async runScenario() { calls += 1; return { status: "pass" }; } }
  });
  registerScenario(lab, "basic-case", "basic");
  await assert.rejects(lab.run({ difficulty: "impossible" }), /difficulty must be one of/);
  assert.equal(calls, 0);
});

test("difficulty assessment rejects malformed result input", () => {
  assert.throws(() => assessThreatLabDifficulty(null), /results must be an array/);
});
