import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutonomousExecutionHost } from "../src/agent/autonomous-execution-host.js";
import { createPersistentExecutionJobQueue } from "../src/agent/execution-job-persistence.js";
import { createPersistentExecutionEventJournal } from "../src/agent/execution-event-journal-persistence.js";

const PLAN = Object.freeze({
  id: "host-test-plan",
  actions: Object.freeze([Object.freeze({
    id: "host-test-action",
    type: "qa.read-only-audit",
    input: Object.freeze({ target: "fixture" })
  })])
});

function makeOrchestrator({ execute, ledger = () => ({ valid: true, entries: 0 }) } = {}) {
  return Object.freeze({
    listEngines: () => Object.freeze([]),
    getPolicy: () => Object.freeze({ id: "host-test-policy" }),
    verifyLedger: ledger,
    execute: execute ?? (async (_plan, options) => ({
      status: "succeeded",
      executionId: options.executionId,
      result: { audited: true }
    }))
  });
}

async function withTempDir(callback) {
  const directory = await mkdtemp(join(tmpdir(), "jbqa-autonomous-host-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForJob(host, id, expectedState, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = host.getJob(id);
    if (job?.state === expectedState) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("job did not reach state " + expectedState);
}

test("host construction is inert, durable and disabled unless explicitly enabled", async () => {
  await withTempDir(async (storageDirectory) => {
    let executions = 0;
    const host = createAutonomousExecutionHost({
      orchestrator: makeOrchestrator({ execute: async (_plan, options) => {
        executions += 1;
        return { status: "succeeded", executionId: options.executionId };
      } }),
      storageDirectory
    });

    assert.equal(host.getStatus().state, "idle");
    assert.equal(host.getStatus().enabled, false);
    assert.equal(host.getStatus().runtime.state, "disabled");
    assert.equal(host.getStatus().queuePersistenceEnabled, true);
    assert.equal(host.getStatus().eventJournalPersistenceEnabled, true);
    assert.equal(executions, 0);
    host.enqueue(PLAN, { id: "host-disabled-job" });
    assert.throws(() => host.start(), (error) => error.code === "RUNTIME_DISABLED");
    assert.equal(host.getJob("host-disabled-job").state, "queued");
    assert.equal(executions, 0);

    const closed = await host.close();
    assert.equal(closed.state, "closed");
    assert.equal(closed.supervisor.state, "closed");

    const reopened = createAutonomousExecutionHost({
      orchestrator: makeOrchestrator(),
      storageDirectory
    });
    try {
      assert.equal(reopened.getJob("host-disabled-job").state, "queued");
      assert.equal(reopened.getStatus().queue.persistent, true);
      assert.equal(reopened.getEventJournalStatus().mode, "persistent");
    } finally {
      await reopened.close();
    }
  });
});

test("host runner drains durable work and persists job and event state across restart", async () => {
  await withTempDir(async (storageDirectory) => {
    let executions = 0;
    const host = createAutonomousExecutionHost({
      orchestrator: makeOrchestrator({ execute: async (_plan, options) => {
        executions += 1;
        return { status: "succeeded", executionId: options.executionId };
      } }),
      storageDirectory,
      enabled: true,
      pollIntervalMs: 100,
      maxJobsPerTick: 2
    });

    host.enqueue(PLAN, { id: "host-durable-job" });
    assert.equal(executions, 0);
    host.start();
    const completed = await waitForJob(host, "host-durable-job", "completed");
    assert.equal(completed.attempts, 1);
    assert.equal(executions, 1);
    assert.equal(host.getStatus().queuePersistenceEnabled, true);
    assert.ok(host.listEvents({ limit: 100 }).some((event) => event.eventType === "AUTONOMOUS_RUNNER_STARTED"));
    await host.close();

    const reopened = createAutonomousExecutionHost({
      orchestrator: makeOrchestrator(),
      storageDirectory
    });
    try {
      assert.equal(reopened.getJob("host-durable-job").state, "completed");
      const events = reopened.listEvents({ limit: 100 });
      assert.ok(events.some((event) => event.eventType === "AUTONOMOUS_RUNNER_TICK"));
      assert.ok(events.some((event) => event.eventType === "AUTONOMOUS_RUNNER_STOPPED"));
      assert.equal(reopened.getEventJournalStatus().mode, "persistent");
    } finally {
      await reopened.close();
    }
  });
});

test("restart quarantines interrupted work and the host never replays it without operator recovery", async () => {
  await withTempDir(async (storageDirectory) => {
    const jobFilePath = join(storageDirectory, "execution-jobs.json");
    const crashedQueue = createPersistentExecutionJobQueue({ filePath: jobFilePath });
    crashedQueue.enqueue(PLAN, { id: "host-interrupted-job" });
    assert.equal(crashedQueue.claimNext().state, "running");
    crashedQueue.close();

    let executions = 0;
    const host = createAutonomousExecutionHost({
      orchestrator: makeOrchestrator({ execute: async (_plan, options) => {
        executions += 1;
        return { status: "succeeded", executionId: options.executionId };
      } }),
      storageDirectory,
      enabled: true,
      pollIntervalMs: 100
    });
    try {
      assert.equal(host.getJob("host-interrupted-job").state, "interrupted");
      host.start();
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.equal(host.getJob("host-interrupted-job").state, "interrupted");
      assert.equal(executions, 0);

      host.recoverInterrupted("host-interrupted-job");
      const completed = await waitForJob(host, "host-interrupted-job", "completed");
      assert.equal(completed.attempts, 2);
      assert.equal(executions, 1);
      assert.ok(host.listEvents({ limit: 100 }).some((event) => event.eventType === "RECOVERY_COMPLETED"));
    } finally {
      await host.close();
    }
  });
});

test("host close waits for active work, closes both durable stores and is idempotent", async () => {
  await withTempDir(async (storageDirectory) => {
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    let releaseExecution;
    const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
    const host = createAutonomousExecutionHost({
      orchestrator: makeOrchestrator({ execute: async (_plan, options) => {
        signalStarted();
        await executionGate;
        return { status: "succeeded", executionId: options.executionId };
      } }),
      storageDirectory,
      enabled: true,
      pollIntervalMs: 100
    });
    host.enqueue(PLAN, { id: "host-close-job" });
    host.start();
    await started;
    let closed = false;
    const closePromise = host.close();
    const closing = closePromise.then((result) => { closed = true; return result; });
    assert.equal(host.close(), closePromise);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closed, false);
    releaseExecution();
    const result = await closing;
    assert.equal(result.state, "closed");
    assert.equal(host.getJob("host-close-job").state, "completed");

    const reopened = createAutonomousExecutionHost({
      orchestrator: makeOrchestrator(),
      storageDirectory
    });
    try {
      assert.equal(reopened.getJob("host-close-job").state, "completed");
    } finally {
      await reopened.close();
    }
  });
});

test("exclusive durable host lock rejects a second host using the same storage directory", async () => {
  await withTempDir(async (storageDirectory) => {
    const first = createAutonomousExecutionHost({
      orchestrator: makeOrchestrator(),
      storageDirectory
    });
    assert.throws(
      () => createAutonomousExecutionHost({
        orchestrator: makeOrchestrator(),
        storageDirectory
      }),
      (error) => error.code === "STORE_LOCKED"
    );
    await first.close();

    const second = createAutonomousExecutionHost({
      orchestrator: makeOrchestrator(),
      storageDirectory
    });
    await second.close();
  });
});

test("host rejects unsafe paths and accessor configuration without invoking getters", () => {
  const orchestrator = makeOrchestrator();
  assert.throws(
    () => createAutonomousExecutionHost({ orchestrator, storageDirectory: "." }),
    (error) => error.code === "INVALID_STORAGE_DIRECTORY"
  );
  let getterCalled = false;
  const options = { orchestrator, storageDirectory: "/tmp/jbqa-host-test" };
  Object.defineProperty(options, "enabled", {
    enumerable: true,
    get() {
      getterCalled = true;
      return true;
    }
  });
  assert.throws(
    () => createAutonomousExecutionHost(options),
    (error) => error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(getterCalled, false);
});
