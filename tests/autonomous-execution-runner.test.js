import assert from "node:assert/strict";
import test from "node:test";
import { createAutonomousExecutionRunner, AutonomousExecutionRunnerError } from "../src/agent/autonomous-execution-runner.js";

function supervisor({ drain = async () => ({ processed: 0 }), start = () => ({ state: "running" }) } = {}) {
  let state = "idle";
  let starts = 0;
  let drains = 0;
  return {
    value: {
      getStatus: () => ({ state, queue: { queued: 0 } }),
      start: () => { starts += 1; state = "running"; return start(); },
      drain: async (options) => { drains += 1; return drain(options); }
    },
    get starts() { return starts; },
    get drains() { return drains; }
  };
}

test("runner construction is inert and explicit start begins bounded loop", async () => {
  const sup = supervisor({ drain: async (options) => ({ processed: options.maxJobs }) });
  const runner = createAutonomousExecutionRunner({ supervisor: sup.value, pollIntervalMs: 100, maxJobsPerTick: 2 });
  assert.equal(runner.getStatus().state, "idle");
  assert.equal(sup.starts, 0);
  runner.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sup.starts, 1);
  assert.equal(sup.drains, 1);
  assert.equal(runner.getStatus().processed, 2);
  await runner.stop();
  assert.equal(runner.getStatus().state, "stopped");
});

test("runner stop wakes idle loop and does not hang", async () => {
  const sup = supervisor();
  const runner = createAutonomousExecutionRunner({ supervisor: sup.value, pollIntervalMs: 5000 });
  runner.start();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const stopped = await runner.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.stopRequested, true);
});

test("runner fail-closes after consecutive drain errors and does not restart", async () => {
  const sup = supervisor({ drain: async () => { const e = new Error("private"); e.code = "EXPECTED_FAIL"; throw e; } });
  const runner = createAutonomousExecutionRunner({ supervisor: sup.value, pollIntervalMs: 100, maxConsecutiveErrors: 1 });
  runner.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = runner.getStatus();
  assert.equal(status.state, "failed");
  assert.equal(status.lastErrorCode, "EXPECTED_FAIL");
  assert.throws(() => runner.start(), (e) => e.code === "RUNNER_TERMINAL");
});

test("runner validates configuration and trusted supervisor methods", () => {
  assert.throws(() => createAutonomousExecutionRunner({ supervisor: {}, pollIntervalMs: 10 }), (e) => e.code === "INVALID_SUPERVISOR");
  const sup = supervisor();
  assert.throws(() => createAutonomousExecutionRunner({ supervisor: sup.value, maxJobsPerTick: 101 }), (e) => e.code === "INVALID_BATCH_SIZE");
  assert.throws(() => createAutonomousExecutionRunner({ supervisor: sup.value, maxConsecutiveErrors: 21 }), (e) => e.code === "INVALID_ERROR_THRESHOLD");
});
