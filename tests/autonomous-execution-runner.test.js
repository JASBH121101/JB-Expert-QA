import assert from "node:assert/strict";
import test from "node:test";
import { createAutonomousExecutionRunner } from "../src/agent/autonomous-execution-runner.js";
import { createExecutionEventJournal } from "../src/agent/execution-event-journal.js";
import { createExecutionJobQueue } from "../src/agent/execution-job-queue.js";
import { createExecutionWorker } from "../src/agent/execution-worker.js";
import { createExecutionLifecycleSupervisor } from "../src/agent/execution-supervisor.js";

function supervisor({
  drain = async () => ({ processed: 0 }),
  start = () => ({ state: "running" }),
  persistent = false
} = {}) {
  let state = "idle";
  let starts = 0;
  let drains = 0;
  return {
    value: {
      getStatus: () => ({ supervisorId: "supervisor-runner-test", state, queue: { persistent } }),
      start: () => { starts += 1; state = "running"; return start(); },
      drain: async (options) => { drains += 1; return drain(options); }
    },
    get starts() { return starts; },
    get drains() { return drains; }
  };
}

test("runner construction is inert and explicit start begins bounded loop", async () => {
  const sup = supervisor({ drain: async (options) => ({ processed: options.maxJobs }), persistent: true });
  const runner = createAutonomousExecutionRunner({ supervisor: sup.value, pollIntervalMs: 100, maxJobsPerTick: 2 });
  assert.equal(runner.getStatus().state, "idle");
  assert.equal(sup.starts, 0);
  assert.equal(runner.getStatus().queuePersistenceEnabled, true);
  runner.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sup.starts, 1);
  assert.equal(sup.drains, 1);
  assert.equal(runner.getStatus().processed, 2);
  assert.equal(typeof runner.getStatus().nextPollAt, "string");
  await runner.stop();
  assert.equal(runner.getStatus().state, "stopped");
  assert.equal(runner.getStatus().nextPollAt, null);
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

test("runner waits for an active bounded drain before graceful stop completes", async () => {
  let release;
  const sup = supervisor({ drain: () => new Promise((resolve) => { release = resolve; }) });
  const runner = createAutonomousExecutionRunner({ supervisor: sup.value, pollIntervalMs: 5000 });
  runner.start();
  let stopCompleted = false;
  const stopping = runner.stop().then((value) => { stopCompleted = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopCompleted, false);
  release({ processed: 1 });
  const result = await stopping;
  assert.equal(result.state, "stopped");
  assert.equal(result.processed, 1);
});

test("runner fail-closes after consecutive drain errors and does not restart", async () => {
  const sup = supervisor({ drain: async () => { const error = new Error("private"); error.code = "EXPECTED_FAIL"; throw error; } });
  const journal = createExecutionEventJournal();
  const runner = createAutonomousExecutionRunner({
    supervisor: sup.value,
    eventJournal: journal,
    pollIntervalMs: 100,
    maxConsecutiveErrors: 1
  });
  runner.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = runner.getStatus();
  assert.equal(status.state, "failed");
  assert.equal(status.lastErrorCode, "EXPECTED_FAIL");
  assert.throws(() => runner.start(), (error) => error.code === "RUNNER_TERMINAL");
  assert.ok(journal.listEvents().some((event) => event.eventType === "AUTONOMOUS_RUNNER_FAILED"));
});

test("runner records lifecycle and productive tick events without journaling idle polls", async () => {
  const sup = supervisor({ drain: async () => ({ processed: 1 }) });
  const journal = createExecutionEventJournal();
  const runner = createAutonomousExecutionRunner({
    supervisor: sup.value,
    eventJournal: journal,
    pollIntervalMs: 5000
  });
  runner.start();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await runner.stop();
  const events = journal.listEvents();
  assert.deepEqual(events.map((event) => event.eventType), [
    "AUTONOMOUS_RUNNER_STARTED",
    "AUTONOMOUS_RUNNER_TICK",
    "AUTONOMOUS_RUNNER_STOPPED"
  ]);
  assert.ok(events.every((event) => event.supervisorId === "supervisor-runner-test"));
  assert.equal(runner.getStatus().eventEmissionFailures, 0);
});

test("runner validates configuration, dependencies and supervisor lifecycle", () => {
  const sup = supervisor();
  assert.throws(() => createAutonomousExecutionRunner({ supervisor: {}, pollIntervalMs: 10 }), (error) => error.code === "INVALID_SUPERVISOR");
  assert.throws(() => createAutonomousExecutionRunner({ supervisor: sup.value, maxJobsPerTick: 101 }), (error) => error.code === "INVALID_BATCH_SIZE");
  assert.throws(() => createAutonomousExecutionRunner({ supervisor: sup.value, maxConsecutiveErrors: 21 }), (error) => error.code === "INVALID_ERROR_THRESHOLD");
  assert.throws(() => createAutonomousExecutionRunner({ supervisor: sup.value, pollIntervalMs: 60001 }), (error) => error.code === "INVALID_POLL_INTERVAL");
  assert.throws(() => createAutonomousExecutionRunner({ supervisor: sup.value, eventJournal: {} }), (error) => error.code === "INVALID_EVENT_JOURNAL");
  const closed = supervisor();
  closed.value.getStatus = () => ({ state: "closed", queue: { persistent: false } });
  const runner = createAutonomousExecutionRunner({ supervisor: closed.value });
  assert.throws(() => runner.start(), (error) => error.code === "SUPERVISOR_CLOSED");
});


test("only one runner can own a supervisor and concurrent stops are idempotent", async () => {
  const sup = supervisor();
  const journal = createExecutionEventJournal();
  const first = createAutonomousExecutionRunner({ supervisor: sup.value, eventJournal: journal, pollIntervalMs: 5000 });
  const second = createAutonomousExecutionRunner({ supervisor: sup.value, pollIntervalMs: 5000 });
  first.start();
  assert.throws(() => second.start(), (error) => error.code === "RUNNER_ALREADY_ATTACHED");
  const [a, b] = await Promise.all([first.stop(), first.stop()]);
  assert.equal(a.state, "stopped");
  assert.equal(b.state, "stopped");
  assert.equal(journal.listEvents().filter((event) => event.eventType === "AUTONOMOUS_RUNNER_STOPPED").length, 1);
  second.start();
  await second.stop();
});

test("runner drives a real queue, worker and supervisor on the host without CI orchestration", async () => {
  const journal = createExecutionEventJournal();
  const queue = createExecutionJobQueue({ eventJournal: journal });
  let runtimeState = "ready";
  const runtime = Object.freeze({
    getStatus: () => Object.freeze({ enabled: true, state: runtimeState }),
    execute: async (_plan, options) => ({ status: "succeeded", executionId: options.executionId }),
    close: async () => { runtimeState = "closed"; }
  });
  const worker = createExecutionWorker({ queue, runtime, eventJournal: journal, workerId: "runner-integration-worker" });
  const executionSupervisor = createExecutionLifecycleSupervisor({
    queue,
    runtime,
    worker,
    eventJournal: journal,
    supervisorId: "runner-integration-supervisor"
  });
  const queued = executionSupervisor.enqueue({ plan: "read-only-runner-integration" }, { id: "runner-integration-job" });
  assert.equal(queued.state, "queued");

  const runner = createAutonomousExecutionRunner({
    supervisor: executionSupervisor,
    eventJournal: journal,
    pollIntervalMs: 100,
    maxJobsPerTick: 2
  });
  runner.start();
  for (let attempt = 0; attempt < 30 && runner.getStatus().processed === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(runner.getStatus().processed, 1);
  assert.equal(queue.getJob("runner-integration-job").state, "completed");
  await runner.stop();
  const finalStatus = await executionSupervisor.close();
  assert.equal(finalStatus.state, "closed");
  assert.ok(journal.listEvents().some((event) => event.eventType === "AUTONOMOUS_RUNNER_STARTED"));
  assert.ok(journal.listEvents().some((event) => event.eventType === "AUTONOMOUS_RUNNER_STOPPED"));
});
