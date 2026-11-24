import test from "node:test";
import assert from "node:assert/strict";
import {
  createAutonomousExecutionPollingScheduler,
  AutonomousExecutionPollingSchedulerError
} from "../src/agent/execution-polling-scheduler.js";

function createSupervisor({ drain, start, close } = {}) {
  const calls = { start: 0, drain: 0, close: 0 };
  let state = "idle";
  const supervisor = {
    getStatus() {
      return Object.freeze({ state, accepting: state === "idle" || state === "running" });
    },
    start() {
      calls.start += 1;
      if (start) start();
      state = "running";
    },
    async drain(options) {
      calls.drain += 1;
      return drain ? drain(options) : {
        processed: 0, completed: 0, failed: 0, cancelled: 0
      };
    },
    async close() {
      calls.close += 1;
      if (close) await close();
      state = "closed";
    }
  };
  return { supervisor, calls };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for scheduler state");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("scheduler construction is inert and start begins bounded local polling", async () => {
  const { supervisor, calls } = createSupervisor({
    drain: async (options) => {
      assert.deepEqual(options, { maxJobs: 2 });
      return { processed: 2, completed: 1, failed: 1, cancelled: 0 };
    }
  });
  const scheduler = createAutonomousExecutionPollingScheduler({
    supervisor,
    schedulerId: "local-scheduler-test",
    intervalMs: 1000,
    maxJobsPerTick: 2
  });

  assert.equal(calls.start, 0);
  assert.equal(calls.drain, 0);
  assert.equal(scheduler.getStatus().state, "idle");

  scheduler.start();
  await waitFor(() => scheduler.getStatus().ticks === 1 && !scheduler.getStatus().active);
  const status = scheduler.getStatus();
  assert.equal(status.state, "running");
  assert.equal(status.processedJobs, 2);
  assert.equal(status.completedJobs, 1);
  assert.equal(status.failedJobs, 1);
  assert.equal(status.tickFailures, 0);
  assert.equal(calls.start, 1);
  assert.equal(calls.drain, 1);

  await scheduler.stop();
  assert.equal(scheduler.getStatus().state, "stopped");
  assert.equal(calls.drain, 1, "stop must clear the next polling timer");
});

test("scheduler never overlaps queue drains and stop waits for the active batch", async () => {
  let release;
  const { supervisor, calls } = createSupervisor({
    drain: () => new Promise((resolve) => { release = resolve; })
  });
  const scheduler = createAutonomousExecutionPollingScheduler({
    supervisor,
    intervalMs: 10,
    maxJobsPerTick: 1
  });

  scheduler.start();
  await waitFor(() => scheduler.getStatus().active);
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(stopped, false);
  assert.equal(calls.drain, 1);
  release({ processed: 1, completed: 1, failed: 0, cancelled: 0 });
  await stopping;
  assert.equal(stopped, true);
  assert.equal(scheduler.getStatus().state, "stopped");
  assert.equal(calls.drain, 1);
});

test("scheduler records sanitized tick failures and continues bounded polling", async () => {
  let attempts = 0;
  const { supervisor } = createSupervisor({
    drain: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("sensitive execution payload must not appear in status");
        error.code = "QUEUE_TEMPORARY_FAILURE";
        throw error;
      }
      return { processed: 0, completed: 0, failed: 0, cancelled: 0 };
    }
  });
  const scheduler = createAutonomousExecutionPollingScheduler({
    supervisor,
    intervalMs: 10
  });

  scheduler.start();
  await waitFor(() => scheduler.getStatus().tickFailures === 1);
  assert.equal(scheduler.getStatus().lastErrorCode, "QUEUE_TEMPORARY_FAILURE");
  assert.equal(JSON.stringify(scheduler.getStatus()).includes("sensitive execution payload"), false);
  await waitFor(() => scheduler.getStatus().ticks >= 2);
  assert.equal(scheduler.getStatus().lastErrorCode, null);
  await scheduler.stop();
});

test("scheduler rejects malformed options and untrusted supervisor capabilities", () => {
  assert.throws(
    () => createAutonomousExecutionPollingScheduler({ supervisor: {} }),
    (error) => error instanceof AutonomousExecutionPollingSchedulerError && error.code === "INVALID_DEPENDENCY"
  );
  assert.throws(
    () => createAutonomousExecutionPollingScheduler({
      supervisor: createSupervisor().supervisor,
      intervalMs: 9
    }),
    (error) => error.code === "INVALID_INTERVAL"
  );
  assert.throws(
    () => createAutonomousExecutionPollingScheduler({
      supervisor: createSupervisor().supervisor,
      maxJobsPerTick: 51
    }),
    (error) => error.code === "INVALID_BATCH_LIMIT"
  );
  const options = { supervisor: createSupervisor().supervisor };
  Object.defineProperty(options, "intervalMs", { get() { throw new Error("must not run"); } });
  assert.throws(
    () => createAutonomousExecutionPollingScheduler(options),
    (error) => error.code === "ACCESSOR_NOT_ALLOWED"
  );
});

test("runOnce is single-flight and close owns supervisor shutdown", async () => {
  let release;
  const { supervisor, calls } = createSupervisor({
    drain: () => new Promise((resolve) => { release = resolve; })
  });
  const scheduler = createAutonomousExecutionPollingScheduler({ supervisor });
  scheduler.start();
  await waitFor(() => scheduler.getStatus().active);
  await assert.rejects(
    scheduler.runOnce(),
    (error) => error.code === "SCHEDULER_BUSY"
  );
  release({ processed: 0, completed: 0, failed: 0, cancelled: 0 });
  await waitFor(() => !scheduler.getStatus().active);
  await scheduler.close();
  assert.equal(scheduler.getStatus().state, "closed");
  assert.equal(calls.close, 1);
  await scheduler.close();
  assert.equal(calls.close, 1);
});

test("scheduler rejects inconsistent drain statistics", async () => {
  const { supervisor } = createSupervisor({
    drain: async () => ({ processed: 2, completed: 1, failed: 0, cancelled: 0 })
  });
  const scheduler = createAutonomousExecutionPollingScheduler({ supervisor, intervalMs: 1000 });
  scheduler.start();
  await waitFor(() => scheduler.getStatus().tickFailures === 1);
  assert.equal(scheduler.getStatus().lastErrorCode, "INVALID_DRAIN_RESULT");
  await scheduler.stop();
});
