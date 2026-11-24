import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersistentExecutionJobQueue } from "../src/agent/execution-job-persistence.js";
import { createExecutionJobQueue } from "../src/agent/execution-job-queue.js";
import { createExecutionWorker } from "../src/agent/execution-worker.js";
import {
  createExecutionLifecycleSupervisor,
  ExecutionLifecycleSupervisorError
} from "../src/agent/execution-supervisor.js";

function createRuntime(execute = async (_plan, options) => ({
  status: "succeeded",
  executionId: options.executionId
}), enabled = true) {
  let state = enabled ? "ready" : "disabled";
  let calls = 0;
  let closeCalls = 0;
  const runtime = Object.freeze({
    getStatus: () => Object.freeze({ enabled, state, active: state === "running" }),
    execute: async (...args) => {
      calls += 1;
      if (state !== "ready") throw new Error("runtime is not ready");
      state = "running";
      try {
        return await execute(...args);
      } finally {
        state = enabled ? "ready" : "disabled";
      }
    },
    close: async () => {
      closeCalls += 1;
      state = "closed";
      return Object.freeze({ state });
    }
  });
  return {
    runtime,
    get calls() { return calls; },
    get closeCalls() { return closeCalls; }
  };
}

function createHarness({ execute, enabled = true, timeoutMs } = {}) {
  const queue = createExecutionJobQueue();
  const runtime = createRuntime(execute, enabled);
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime, timeoutMs });
  const supervisor = createExecutionLifecycleSupervisor({
    queue,
    runtime: runtime.runtime,
    worker,
    supervisorId: "supervisor-test-1"
  });
  return { queue, runtime, worker, supervisor };
}

test("supervisor construction is inert and queues work before explicit start", async () => {
  const { queue, runtime, worker, supervisor } = createHarness();
  const job = supervisor.enqueue({ plan: "read-only-audit" }, { id: "queued-before-start" });

  assert.equal(supervisor.getStatus().state, "idle");
  assert.equal(supervisor.getStatus().accepting, true);
  assert.equal(worker.getStatus().state, "stopped");
  assert.equal(runtime.calls, 0);
  assert.equal(job.state, "queued");
  assert.throws(
    () => supervisor.runNext(),
    (error) => error instanceof ExecutionLifecycleSupervisorError &&
      error.code === "SUPERVISOR_NOT_STARTED"
  );

  supervisor.start();
  assert.equal(supervisor.getStatus().state, "running");
  assert.equal(supervisor.start().state, "running");
  const completed = await supervisor.runNext();
  assert.equal(completed.id, job.id);
  assert.equal(completed.state, "completed");
  assert.equal(queue.getJob(job.id).state, "completed");
  assert.equal(runtime.calls, 1);
});

test("graceful close stops admission, waits for active work and releases resources in order", async () => {
  let releaseExecution;
  const sequence = [];
  const { queue, runtime, worker, supervisor } = createHarness({
    execute: () => new Promise((resolve) => { releaseExecution = resolve; })
  });
  const originalRuntimeClose = runtime.runtime.close;
  const wrappedRuntime = Object.freeze({
    getStatus: runtime.runtime.getStatus,
    execute: runtime.runtime.execute,
    close: async () => {
      sequence.push("runtime.close");
      return originalRuntimeClose();
    }
  });
  const wrappedWorker = worker;
  const wrappedQueue = Object.freeze({
    enqueue: queue.enqueue,
    stats: queue.stats,
    close: () => {
      sequence.push("queue.close");
      queue.close();
    }
  });
  const managed = createExecutionLifecycleSupervisor({
    worker: {
      getStatus: wrappedWorker.getStatus,
      start: wrappedWorker.start,
      runNext: wrappedWorker.runNext,
      drain: wrappedWorker.drain,
      cancelActive: wrappedWorker.cancelActive,
      stop: async () => {
        sequence.push("worker.stop");
        return wrappedWorker.stop();
      }
    },
    runtime: wrappedRuntime,
    queue: wrappedQueue
  });

  managed.enqueue({ plan: "slow-audit" }, { id: "slow-job" });
  managed.start();
  const active = managed.runNext();
  await Promise.resolve();

  let closed = false;
  const closing = managed.close().then((value) => {
    closed = true;
    return value;
  });
  assert.equal(managed.getStatus().state, "closing");
  assert.throws(() => managed.enqueue({ plan: "late" }), (error) => error.code === "SUPERVISOR_CLOSED");
  assert.equal(closed, false);

  releaseExecution({ status: "succeeded" });
  await active;
  const finalStatus = await closing;
  assert.equal(finalStatus.state, "closed");
  assert.equal(queue.getJob("slow-job").state, "completed");
  assert.deepEqual(sequence, ["worker.stop", "runtime.close", "queue.close"]);
  assert.equal(runtime.closeCalls, 1);
});

test("abortActive requests cooperative cancellation before shutdown", async () => {
  let seenSignal;
  const { queue, worker, supervisor } = createHarness({
    execute: (_plan, options) => new Promise((_resolve, reject) => {
      seenSignal = options.signal;
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    })
  });
  supervisor.enqueue({ plan: "cooperative-audit" }, { id: "cancel-at-shutdown" });
  supervisor.start();

  const active = supervisor.runNext();
  await Promise.resolve();
  const closing = supervisor.close({ abortActive: true, reason: "host shutdown requested" });
  assert.equal(seenSignal.aborted, true);

  const cancelled = await active;
  const finalStatus = await closing;
  assert.equal(cancelled.state, "cancelled");
  assert.equal(queue.getJob("cancel-at-shutdown").state, "cancelled");
  assert.equal(finalStatus.state, "closed");
  assert.equal(worker.getStatus().state, "stopped");
});

test("supervisor fails closed when runtime is disabled and does not claim queued jobs", async () => {
  const { queue, runtime, supervisor } = createHarness({ enabled: false });
  supervisor.enqueue({ plan: "must-not-run" }, { id: "blocked-job" });
  assert.throws(
    () => supervisor.start(),
    (error) => error instanceof ExecutionLifecycleSupervisorError && error.code === "RUNTIME_DISABLED"
  );
  assert.equal(supervisor.getStatus().state, "idle");
  assert.equal(queue.getJob("blocked-job").state, "queued");
  assert.equal(runtime.calls, 0);
  await supervisor.close();
});

test("supervisor forwards bounded drain options and exposes coordinated component status", async () => {
  const { queue, runtime, supervisor } = createHarness();
  supervisor.enqueue({ n: 1 }, { id: "batch-1" });
  supervisor.enqueue({ n: 2 }, { id: "batch-2" });
  supervisor.start();

  const report = await supervisor.drain({ maxJobs: 1 });
  assert.equal(report.processed, 1);
  assert.equal(report.completed, 1);
  assert.equal(queue.getJob("batch-1").state, "completed");
  assert.equal(queue.getJob("batch-2").state, "queued");

  const status = supervisor.getStatus();
  assert.equal(status.state, "running");
  assert.equal(status.runtime.state, "ready");
  assert.equal(status.worker.state, "ready");
  assert.equal(status.queue.queued, 1);
  assert.equal(runtime.calls, 1);
  await supervisor.close();
});

test("close is idempotent and executes each resource close exactly once", async () => {
  const { runtime, supervisor } = createHarness();
  const first = supervisor.close();
  const second = supervisor.close();
  assert.equal(first, second);
  const finalStatus = await first;
  assert.equal(finalStatus.state, "closed");
  assert.equal(runtime.closeCalls, 1);
  assert.equal(supervisor.getStatus().state, "closed");
  await assert.rejects(
    Promise.resolve().then(() => supervisor.enqueue({ late: true })),
    (error) => error.code === "SUPERVISOR_CLOSED"
  );
});

test("shutdown attempts every cleanup stage and reports sanitized stage failures", async () => {
  const calls = [];
  const workerStatus = () => Object.freeze({ state: "stopped", enabled: false });
  const runtimeStatus = () => Object.freeze({ state: "ready", enabled: true });
  const queueStats = () => Object.freeze({ queued: 0, total: 0 });
  const worker = Object.freeze({
    getStatus: workerStatus,
    start: () => undefined,
    runNext: async () => null,
    drain: async () => null,
    cancelActive: () => false,
    stop: async () => {
      calls.push("worker.stop");
      const error = new Error("contains-sensitive-detail");
      error.code = "WORKER_STOP_FAILED";
      throw error;
    }
  });
  const runtime = Object.freeze({
    getStatus: runtimeStatus,
    close: async () => {
      calls.push("runtime.close");
      const error = new Error("private-runtime-message");
      error.code = "RUNTIME_CLOSE_FAILED";
      throw error;
    }
  });
  const queue = Object.freeze({
    enqueue: () => null,
    stats: queueStats,
    close: () => { calls.push("queue.close"); }
  });
  const supervisor = createExecutionLifecycleSupervisor({ worker, runtime, queue });

  await assert.rejects(
    supervisor.close(),
    (error) => {
      assert.equal(error.code, "SHUTDOWN_FAILED");
      assert.deepEqual(error.failures, [
        { stage: "worker.stop", code: "WORKER_STOP_FAILED" },
        { stage: "runtime.close", code: "RUNTIME_CLOSE_FAILED" }
      ]);
      assert.equal(error.message.includes("private-runtime-message"), false);
      assert.equal(error.message.includes("contains-sensitive-detail"), false);
      return true;
    }
  );
  assert.deepEqual(calls, ["worker.stop", "runtime.close", "queue.close"]);
  assert.equal(supervisor.getStatus().state, "closed");
});

test("supervisor rejects invalid dependencies, accessor options and invalid shutdown controls", () => {
  assert.throws(
    () => createExecutionLifecycleSupervisor({ worker: {}, runtime: {}, queue: {} }),
    (error) => error.code === "INVALID_DEPENDENCY"
  );
  const { queue, runtime, worker } = createHarness();
  const options = { worker, runtime: runtime.runtime, queue };
  Object.defineProperty(options, "supervisorId", {
    enumerable: true,
    get: () => "not-safe"
  });
  assert.throws(
    () => createExecutionLifecycleSupervisor(options),
    (error) => error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.throws(
    () => createExecutionLifecycleSupervisor({
      worker,
      runtime: runtime.runtime,
      queue,
      supervisorId: "bad id"
    }),
    (error) => error.code === "INVALID_SUPERVISOR_ID"
  );
  const manager = createExecutionLifecycleSupervisor({ worker, runtime: runtime.runtime, queue });
  assert.throws(
    () => manager.close({ abortActive: "yes" }),
    (error) => error.code === "INVALID_ABORT_FLAG"
  );
  assert.throws(
    () => manager.close({ reason: "x".repeat(501) }),
    (error) => error.code === "INVALID_SHUTDOWN_REASON"
  );
});


test("operator recovery facade inspects interrupted jobs and requires an explicit recovery decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jbqa-phase5-block7-"));
  const filePath = join(directory, "jobs.json");
  try {
    const initial = createPersistentExecutionJobQueue({ filePath });
    initial.enqueue({ plan: "recover-me" }, { id: "recover-me" });
    initial.enqueue({ plan: "do-not-replay" }, { id: "do-not-replay" });
    initial.claimNext();
    initial.claimNext();
    initial.close();

    const queue = createPersistentExecutionJobQueue({ filePath });
    const runtime = createRuntime();
    const worker = createExecutionWorker({ queue, runtime: runtime.runtime });
    const supervisor = createExecutionLifecycleSupervisor({
      queue,
      runtime: runtime.runtime,
      worker
    });

    const interrupted = supervisor.listJobs({ state: "interrupted" });
    assert.equal(interrupted.length, 2);
    assert.equal(supervisor.getJob("recover-me").state, "interrupted");

    const recovered = supervisor.recoverInterrupted("recover-me");
    assert.equal(recovered.state, "queued");
    assert.equal(recovered.attempts, 1);
    const abandoned = supervisor.failInterrupted("do-not-replay", "Operator declined replay");
    assert.equal(abandoned.state, "failed");
    assert.equal(abandoned.error, "Operator declined replay");

    // Recovery decisions only change queue state; they never start execution.
    assert.equal(runtime.calls, 0);
    assert.equal(supervisor.getStatus().queue.queued, 1);
    assert.equal(supervisor.getStatus().queue.failed, 1);
    assert.throws(
      () => supervisor.failInterrupted("missing-reason", "x".repeat(501)),
      (error) => error.code === "INVALID_RECOVERY_REASON"
    );

    supervisor.start();
    const result = await supervisor.runNext();
    assert.equal(result.id, "recover-me");
    assert.equal(result.state, "completed");
    assert.equal(runtime.calls, 1);
    assert.equal(supervisor.getJob("do-not-replay").state, "failed");
    await supervisor.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("operator retry of failed work is manual, bounded and does not execute during recovery", async () => {
  const queue = createExecutionJobQueue({ maxAttempts: 3 });
  queue.enqueue({ plan: "retry-me" }, { id: "failed-job" });
  queue.claimNext();
  queue.fail("failed-job", new Error("temporary failure"));

  const runtime = createRuntime();
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime });
  const supervisor = createExecutionLifecycleSupervisor({
    queue,
    runtime: runtime.runtime,
    worker
  });

  assert.equal(supervisor.listJobs({ state: "failed" }).length, 1);
  const retried = supervisor.retryFailed("failed-job", { delayMs: 0 });
  assert.equal(retried.state, "queued");
  assert.equal(retried.attempts, 1);
  assert.equal(runtime.calls, 0);

  supervisor.start();
  const completed = await supervisor.runNext();
  assert.equal(completed.state, "completed");
  assert.equal(completed.attempts, 2);
  assert.equal(runtime.calls, 1);
  await supervisor.close();
});

test("operator recovery and inspection APIs reject access once supervisor shutdown begins", async () => {
  const { supervisor } = createHarness();
  await supervisor.close();
  assert.throws(() => supervisor.getJob("any"), (error) => error.code === "SUPERVISOR_CLOSED");
  assert.throws(() => supervisor.listJobs(), (error) => error.code === "SUPERVISOR_CLOSED");
  assert.throws(() => supervisor.recoverInterrupted("any"), (error) => error.code === "SUPERVISOR_CLOSED");
  assert.throws(() => supervisor.failInterrupted("any"), (error) => error.code === "SUPERVISOR_CLOSED");
  assert.throws(() => supervisor.retryFailed("any"), (error) => error.code === "SUPERVISOR_CLOSED");
});


test("legacy queue adapters remain compatible and unsupported recovery capabilities fail closed", () => {
  const queue = {
    enqueue: () => null,
    stats: () => ({ queued: 0, total: 0 }),
    close: () => undefined
  };
  const runtime = {
    getStatus: () => ({ enabled: true, state: "ready" }),
    close: () => undefined
  };
  const worker = {
    getStatus: () => ({ state: "stopped" }),
    start: () => undefined,
    runNext: async () => null,
    drain: async () => null,
    stop: async () => undefined,
    cancelActive: () => false
  };
  const supervisor = createExecutionLifecycleSupervisor({ queue, runtime, worker });

  for (const operation of [
    () => supervisor.getJob("legacy-job"),
    () => supervisor.listJobs(),
    () => supervisor.recoverInterrupted("legacy-job"),
    () => supervisor.failInterrupted("legacy-job"),
    () => supervisor.retryFailed("legacy-job")
  ]) {
    assert.throws(operation, (error) => error.code === "QUEUE_CAPABILITY_UNAVAILABLE");
  }
});


test("supervisor closes isolated process runners after runtime and before durable queue storage", async () => {
  const calls = [];
  const { queue, runtime, worker } = createHarness();
  const originalWorkerStop = worker.stop;
  const wrappedWorker = Object.freeze({
    ...worker,
    stop: async () => {
      calls.push("worker.stop");
      return originalWorkerStop();
    }
  });
  const wrappedRuntime = Object.freeze({
    ...runtime.runtime,
    close: async () => {
      calls.push("runtime.close");
      return runtime.runtime.close();
    }
  });
  const wrappedQueue = Object.freeze({
    enqueue: queue.enqueue,
    stats: queue.stats,
    getJob: queue.getJob,
    listJobs: queue.listJobs,
    requeueInterrupted: queue.requeueInterrupted,
    failInterrupted: queue.failInterrupted,
    retryFailed: queue.retryFailed,
    close: () => { calls.push("queue.close"); }
  });
  const processRunner = Object.freeze({
    getStatus: () => Object.freeze({ state: "ready", active: false }),
    close: async () => { calls.push("processRunner.close"); }
  });
  const supervisor = createExecutionLifecycleSupervisor({
    worker: wrappedWorker,
    runtime: wrappedRuntime,
    queue: wrappedQueue,
    processRunners: [processRunner]
  });

  assert.equal(supervisor.getStatus().processRunners.length, 1);
  await supervisor.close();
  assert.deepEqual(calls, [
    "worker.stop",
    "runtime.close",
    "processRunner.close",
    "queue.close"
  ]);
});

test("supervisor rejects malformed isolated process runner dependencies", () => {
  const { queue, runtime, worker } = createHarness();
  assert.throws(
    () => createExecutionLifecycleSupervisor({
      queue,
      runtime: runtime.runtime,
      worker,
      processRunners: [{}]
    }),
    (error) => error.code === "INVALID_DEPENDENCY"
  );
});
