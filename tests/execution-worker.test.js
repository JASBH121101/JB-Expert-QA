import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionJobQueue } from "../src/agent/execution-job-queue.js";
import { createExecutionWorker, ExecutionWorkerError } from "../src/agent/execution-worker.js";

function createRuntime(execute = async (_plan, options) => ({ status: "succeeded", executionId: options.executionId }), enabled = true) {
  let calls = 0;
  let state = enabled ? "ready" : "disabled";
  return {
    runtime: Object.freeze({
      getStatus: () => Object.freeze({ enabled, state }),
      execute: async (...args) => {
        calls += 1;
        return execute(...args);
      }
    }),
    get calls() { return calls; },
    setState(next) { state = next; }
  };
}

test("worker construction is inert and requires explicit start before claiming jobs", async () => {
  const queue = createExecutionJobQueue();
  queue.enqueue({ id: "plan-1", actions: [] }, { id: "job-1" });
  const runtime = createRuntime();
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime, workerId: "worker-test-1" });

  assert.equal(worker.getStatus().state, "stopped");
  assert.equal(worker.getStatus().enabled, false);
  assert.equal(runtime.calls, 0);
  await assert.rejects(
    worker.runNext(),
    (error) => error instanceof ExecutionWorkerError && error.code === "WORKER_NOT_STARTED"
  );
  assert.equal(queue.getJob("job-1").state, "queued");
  assert.equal(runtime.calls, 0);
});

test("worker start fails closed when the QA runtime is disabled", () => {
  const queue = createExecutionJobQueue();
  const runtime = createRuntime(async () => ({}), false);
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime });
  assert.throws(
    () => worker.start(),
    (error) => error instanceof ExecutionWorkerError && error.code === "RUNTIME_DISABLED"
  );
  assert.equal(worker.getStatus().state, "stopped");
});

test("worker claims a job, delegates to the runtime and records completion", async () => {
  const queue = createExecutionJobQueue();
  const job = queue.enqueue({ id: "plan-1", actions: [] }, { id: "job-1" });
  let receivedPlan;
  let receivedOptions;
  const runtime = createRuntime(async (plan, options) => {
    receivedPlan = plan;
    receivedOptions = options;
    return { status: "succeeded", executionId: options.executionId };
  });
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime, workerId: "worker-test-2" });

  worker.start();
  const completed = await worker.runNext();
  assert.equal(completed.id, job.id);
  assert.equal(completed.state, "completed");
  assert.deepEqual(receivedPlan, { id: "plan-1", actions: [] });
  assert.equal(receivedOptions.executionId, "job-1");
  assert.ok(receivedOptions.signal instanceof AbortSignal);
  assert.equal(receivedOptions.signal.aborted, false);
  assert.equal(queue.getJob("job-1").state, "completed");
  assert.equal(worker.getStatus().completedJobs, 1);
  assert.equal(runtime.calls, 1);
});

test("worker records runtime errors as failed jobs and redacts sensitive error text", async () => {
  const queue = createExecutionJobQueue();
  queue.enqueue({ id: "plan-1", actions: [] }, { id: "job-fail" });
  const token = "ghp_" + "A".repeat(36);
  const runtime = createRuntime(async () => {
    throw new Error("adapter failed with token " + token);
  });
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime });
  worker.start();

  const failed = await worker.runNext();
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.includes(token), false);
  assert.equal(worker.getStatus().failedJobs, 1);
  assert.equal(queue.getJob("job-fail").state, "failed");
});

test("worker checks runtime readiness before claiming a job", async () => {
  const queue = createExecutionJobQueue();
  queue.enqueue({ id: "plan-1", actions: [] }, { id: "job-pending" });
  const runtime = createRuntime();
  runtime.setState("running");
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime });
  assert.throws(
    () => worker.start(),
    (error) => error.code === "RUNTIME_BUSY"
  );
  assert.equal(queue.getJob("job-pending").state, "queued");
  assert.equal(runtime.calls, 0);
});

test("worker drain processes jobs sequentially and honors maxJobs", async () => {
  const queue = createExecutionJobQueue();
  for (let index = 1; index <= 3; index += 1) {
    queue.enqueue({ id: "plan-" + index, actions: [] }, { id: "job-" + index });
  }
  const runtime = createRuntime();
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime });
  worker.start();

  const firstBatch = await worker.drain({ maxJobs: 2 });
  assert.equal(firstBatch.processed, 2);
  assert.equal(firstBatch.completed, 2);
  assert.equal(firstBatch.failed, 0);
  assert.equal(queue.getJob("job-3").state, "queued");

  const secondBatch = await worker.drain();
  assert.equal(secondBatch.processed, 1);
  assert.equal(secondBatch.jobs[0].id, "job-3");
  assert.equal(runtime.calls, 3);
  assert.equal(worker.getStatus().state, "ready");
});

test("worker rejects concurrent runs and does not claim a second job", async () => {
  const queue = createExecutionJobQueue();
  queue.enqueue({ id: "plan-1", actions: [] }, { id: "job-1" });
  queue.enqueue({ id: "plan-2", actions: [] }, { id: "job-2" });
  let release;
  const runtime = createRuntime(() => new Promise((resolve) => { release = resolve; }));
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime });
  worker.start();

  const first = worker.runNext();
  await Promise.resolve();
  assert.equal(worker.getStatus().state, "busy");
  await assert.rejects(
    worker.runNext(),
    (error) => error.code === "WORKER_BUSY"
  );
  assert.equal(queue.getJob("job-2").state, "queued");

  release({ status: "succeeded" });
  await first;
  assert.equal(worker.getStatus().completedJobs, 1);
});

test("stop prevents new claims and drains the active job before shutdown", async () => {
  const queue = createExecutionJobQueue();
  queue.enqueue({ id: "plan-1", actions: [] }, { id: "job-running" });
  queue.enqueue({ id: "plan-2", actions: [] }, { id: "job-next" });
  let release;
  const runtime = createRuntime(() => new Promise((resolve) => { release = resolve; }));
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime });
  worker.start();

  const active = worker.runNext();
  await Promise.resolve();
  const stopping = worker.stop();
  assert.equal(worker.getStatus().state, "stopping");
  await assert.rejects(
    worker.runNext(),
    (error) => error.code === "WORKER_NOT_STARTED"
  );
  release({ status: "succeeded" });
  await active;
  const stopped = await stopping;
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.active, false);
  assert.equal(queue.getJob("job-running").state, "completed");
  assert.equal(queue.getJob("job-next").state, "queued");
});

test("worker cannot restart after stop and validates its batch limit", async () => {
  const queue = createExecutionJobQueue();
  const runtime = createRuntime();
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime });
  worker.start();
  await worker.stop();
  assert.throws(() => worker.start(), (error) => error.code === "WORKER_STOPPED");
  await assert.rejects(worker.drain({ maxJobs: 0 }), (error) => error.code === "INVALID_BATCH_LIMIT");
});

test("worker rejects untrusted dependency shapes and accessor options", () => {
  const queue = createExecutionJobQueue();
  const runtime = createRuntime();
  assert.throws(
    () => createExecutionWorker({ queue: {}, runtime: runtime.runtime }),
    (error) => error.code === "INVALID_DEPENDENCY"
  );
  const options = { queue, runtime: runtime.runtime };
  Object.defineProperty(options, "workerId", { enumerable: true, get: () => "unsafe" });
  assert.throws(
    () => createExecutionWorker(options),
    (error) => error.code === "ACCESSOR_NOT_ALLOWED"
  );
});


test("worker passes a cooperative abort signal and cancels an active job", async () => {
  const queue = createExecutionJobQueue();
  queue.enqueue({ id: "plan-cancel", actions: [] }, { id: "job-cancel" });
  let seenSignal;
  const runtime = createRuntime((_plan, options) => new Promise((_resolve, reject) => {
    seenSignal = options.signal;
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }));
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime });
  worker.start();

  const active = worker.runNext();
  await Promise.resolve();
  assert.equal(worker.cancelActive("operator requested stop"), true);
  const cancelled = await active;
  assert.equal(seenSignal.aborted, true);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(queue.getJob("job-cancel").state, "cancelled");
  assert.equal(worker.getStatus().cancelledJobs, 1);
  assert.equal(worker.cancelActive(), false);
});

test("worker timeout aborts the runtime and records a failed job", async () => {
  const queue = createExecutionJobQueue();
  queue.enqueue({ id: "plan-timeout", actions: [] }, { id: "job-timeout" });
  let seenSignal;
  const runtime = createRuntime((_plan, options) => new Promise((_resolve, reject) => {
    seenSignal = options.signal;
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }));
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime, timeoutMs: 15 });
  worker.start();

  const failed = await worker.runNext();
  assert.equal(seenSignal.aborted, true);
  assert.equal(failed.state, "failed");
  assert.match(failed.error, /timed out/u);
  assert.equal(worker.getStatus().failedJobs, 1);
});

test("timeout does not release the single worker while a non-cooperative runtime is still active", async () => {
  const queue = createExecutionJobQueue();
  queue.enqueue({ id: "plan-stubborn", actions: [] }, { id: "job-stubborn" });
  let release;
  let seenSignal;
  const runtime = createRuntime((_plan, options) => {
    seenSignal = options.signal;
    return new Promise((resolve) => { release = resolve; });
  });
  const worker = createExecutionWorker({ queue, runtime: runtime.runtime, timeoutMs: 10 });
  worker.start();

  const active = worker.runNext();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(seenSignal.aborted, true);
  assert.equal(worker.getStatus().state, "busy");
  assert.equal(queue.getJob("job-stubborn").state, "running");
  release({ status: "late-completion" });

  const failed = await active;
  assert.equal(failed.state, "failed");
  assert.equal(worker.getStatus().state, "ready");
});

test("worker validates timeout bounds and reports active abort state", async () => {
  const queue = createExecutionJobQueue();
  const runtime = createRuntime();
  assert.throws(
    () => createExecutionWorker({ queue, runtime: runtime.runtime, timeoutMs: 0 }),
    (error) => error.code === "INVALID_TIMEOUT"
  );
  assert.throws(
    () => createExecutionWorker({ queue, runtime: runtime.runtime, timeoutMs: 600001 }),
    (error) => error.code === "INVALID_TIMEOUT"
  );
});
