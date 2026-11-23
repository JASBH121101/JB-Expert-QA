import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionJobQueue, ExecutionJobQueueError } from "../src/agent/execution-job-queue.js";

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
}

test("queue lifecycle transitions queued to running to completed", () => {
  const queue = createExecutionJobQueue({ now: clock() });
  const job = queue.enqueue({ plan: { id: "plan-1" } }, { id: "job-1" });
  assert.equal(job.state, "queued");
  const claimed = queue.claimNext();
  assert.equal(claimed.id, "job-1");
  assert.equal(claimed.state, "running");
  const finished = queue.complete("job-1", { status: "pass" });
  assert.equal(finished.state, "completed");
  assert.deepEqual(finished.result, { status: "pass" });
  assert.equal(queue.claimNext(), null);
});

test("queue is bounded and FIFO", () => {
  const queue = createExecutionJobQueue({ maxQueueSize: 2, now: clock() });
  queue.enqueue({ n: 1 }, { id: "job-1" });
  queue.enqueue({ n: 2 }, { id: "job-2" });
  assert.throws(() => queue.enqueue({ n: 3 }), (error) => error.code === "QUEUE_FULL");
  assert.equal(queue.claimNext().id, "job-1");
  assert.equal(queue.claimNext().id, "job-2");
});

test("idempotency key returns existing job instead of duplicate", () => {
  const queue = createExecutionJobQueue({ now: clock() });
  const first = queue.enqueue({ plan: "same" }, { idempotencyKey: "request-1" });
  const second = queue.enqueue({ plan: "different" }, { idempotencyKey: "request-1" });
  assert.equal(first.id, second.id);
  assert.equal(queue.stats().total, 1);
  assert.deepEqual(second.payload, { plan: "same" });
});

test("queued jobs can be cancelled; running and terminal jobs cannot", () => {
  const queue = createExecutionJobQueue({ now: clock() });
  queue.enqueue({ work: 1 }, { id: "queued" });
  queue.enqueue({ work: 2 }, { id: "running" });
  assert.equal(queue.cancel("queued").state, "cancelled");
  queue.claimNext();
  assert.throws(() => queue.cancel("running"), (error) => error.code === "INVALID_TRANSITION");
  assert.throws(() => queue.cancel("queued"), (error) => error.code === "INVALID_TRANSITION");
});

test("failed jobs record a bounded error message and timestamps", () => {
  const queue = createExecutionJobQueue({ now: clock() });
  queue.enqueue({ work: 1 }, { id: "job-fail" });
  queue.claimNext();
  const failed = queue.fail("job-fail", new Error("adapter failed"));
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "adapter failed");
  assert.ok(failed.startedAt);
  assert.ok(failed.finishedAt);
});

test("payload and result must be JSON serializable; snapshots are immutable", () => {
  const queue = createExecutionJobQueue({ now: clock() });
  assert.throws(() => queue.enqueue({ fn() {} }), (error) => error.code === "INVALID_PAYLOAD");
  const job = queue.enqueue({ safe: true });
  assert.ok(Object.isFrozen(job));
  assert.ok(Object.isFrozen(job.payload));
  const claimed = queue.claimNext();
  assert.throws(() => queue.complete(claimed.id, { fn() {} }), (error) => error.code === "INVALID_PAYLOAD");
  let getterCalled = false;
  const accessorPayload = {};
  Object.defineProperty(accessorPayload, "secret", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "value";
    }
  });
  assert.throws(() => queue.enqueue(accessorPayload), (error) => error.code === "INVALID_PAYLOAD");
  assert.equal(getterCalled, false);
  const cyclicPayload = {};
  cyclicPayload.self = cyclicPayload;
  assert.throws(() => queue.enqueue(cyclicPayload), (error) => error.code === "INVALID_PAYLOAD");
  assert.throws(() => queue.enqueue({ missing: undefined }), (error) => error.code === "INVALID_PAYLOAD");
  assert.throws(() => queue.enqueue({ amount: Number.POSITIVE_INFINITY }), (error) => error.code === "INVALID_PAYLOAD");
});

test("terminal retention can be explicitly cleared; active jobs cannot be removed", () => {
  const queue = createExecutionJobQueue({ maxJobs: 2, now: clock() });
  queue.enqueue({ a: 1 }, { id: "one" });
  queue.enqueue({ a: 2 }, { id: "two" });
  assert.throws(() => queue.enqueue({ a: 3 }), (error) => error.code === "JOB_CAPACITY_REACHED");
  queue.claimNext();
  queue.complete("one", {});
  assert.equal(queue.removeTerminal("one"), true);
  assert.equal(queue.enqueue({ a: 3 }, { id: "three" }).state, "queued");
  assert.throws(() => queue.removeTerminal("two"), (error) => error.code === "INVALID_TRANSITION");
});

test("unknown options, invalid limits, duplicate IDs and invalid state filters are rejected", () => {
  assert.throws(() => createExecutionJobQueue({ maxQueueSize: 0 }), (error) => error.code === "INVALID_QUEUE_LIMIT");
  assert.throws(() => createExecutionJobQueue({ surprise: true }), (error) => error.code === "UNSUPPORTED_OPTION");
  const queue = createExecutionJobQueue({ now: clock() });
  queue.enqueue({ a: 1 }, { id: "duplicate" });
  assert.throws(() => queue.enqueue({ a: 2 }, { id: "duplicate" }), (error) => error.code === "DUPLICATE_JOB_ID");
  assert.throws(() => queue.listJobs({ state: "unknown" }), (error) => error.code === "INVALID_STATE_FILTER");
});


test("failed jobs support explicit bounded retries with backoff and delayed FIFO claiming", () => {
  let current = Date.parse("2026-11-23T21:00:00.000Z");
  const queue = createExecutionJobQueue({
    maxAttempts: 2,
    now: () => new Date(current).toISOString()
  });
  queue.enqueue({ work: "retryable-by-operator" }, { id: "retry-job" });
  queue.claimNext();
  queue.fail("retry-job", new Error("temporary adapter failure"));

  const retried = queue.retryFailed("retry-job", { delayMs: 5000 });
  assert.equal(retried.state, "queued");
  assert.equal(retried.attempts, 1);
  assert.equal(retried.nextAttemptAt, "2026-11-23T21:00:05.000Z");
  assert.equal(queue.claimNext(), null);

  current += 5000;
  const secondAttempt = queue.claimNext();
  assert.equal(secondAttempt.id, "retry-job");
  assert.equal(secondAttempt.attempts, 2);
  assert.equal(secondAttempt.nextAttemptAt, null);
  queue.fail("retry-job", new Error("second attempt failed"));
  assert.throws(
    () => queue.retryFailed("retry-job"),
    (error) => error instanceof ExecutionJobQueueError && error.code === "ATTEMPT_LIMIT_REACHED"
  );
});

test("retry delay defaults to exponential backoff and validates bounds", () => {
  let current = Date.parse("2026-11-23T21:00:00.000Z");
  const queue = createExecutionJobQueue({ maxAttempts: 3, now: () => new Date(current).toISOString() });
  queue.enqueue({ work: 1 }, { id: "backoff-job" });
  queue.claimNext();
  queue.fail("backoff-job", new Error("first failure"));
  assert.throws(
    () => queue.retryFailed("backoff-job", { delayMs: 86400001 }),
    (error) => error.code === "INVALID_RETRY_DELAY"
  );
  const retry = queue.retryFailed("backoff-job");
  assert.equal(retry.nextAttemptAt, "2026-11-23T21:00:01.000Z");
  current += 1000;
  assert.equal(queue.claimNext().attempts, 2);
});

test("running jobs can be marked cancelled only after cooperative abort settles", () => {
  const queue = createExecutionJobQueue({ now: clock() });
  queue.enqueue({ work: 1 }, { id: "running-cancel" });
  assert.throws(() => queue.cancelRunning("running-cancel"), (error) => error.code === "INVALID_TRANSITION");
  queue.claimNext();
  const cancelled = queue.cancelRunning("running-cancel", "operator requested cancellation");
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.error, "operator requested cancellation");
  assert.throws(() => queue.cancelRunning("running-cancel"), (error) => error.code === "INVALID_TRANSITION");
});

test("retry and recovery attempt limits are validated", () => {
  assert.throws(() => createExecutionJobQueue({ maxAttempts: 0 }), (error) => error.code === "INVALID_ATTEMPT_LIMIT");
  const queue = createExecutionJobQueue({ maxAttempts: 1, now: clock() });
  queue.enqueue({ work: 1 }, { id: "one-attempt" });
  queue.claimNext();
  queue.fail("one-attempt", "failed");
  assert.throws(() => queue.retryFailed("one-attempt"), (error) => error.code === "ATTEMPT_LIMIT_REACHED");
});
