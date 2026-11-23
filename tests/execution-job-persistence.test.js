import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, stat, chmod } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
  createJsonFileExecutionJobStore,
  createPersistentExecutionJobQueue,
  ExecutionJobStoreError
} from "../src/agent/execution-job-persistence.js";
import { createExecutionJobQueue, ExecutionJobQueueError } from "../src/agent/execution-job-queue.js";

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), "jbqa-job-store-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 10, 23, 21, 0, tick++)).toISOString();
}

test("persistent queue survives restart and restores queued FIFO jobs and idempotency", async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, "jobs.json");
    const queue = createPersistentExecutionJobQueue({ filePath, now: clock(), maxQueueSize: 5 });
    const first = queue.enqueue({ plan: "one" }, { id: "job-1", idempotencyKey: "request-1" });
    const second = queue.enqueue({ plan: "two" }, { id: "job-2" });
    assert.equal(first.state, "queued");
    assert.equal(second.state, "queued");
    queue.close();

    const reopened = createPersistentExecutionJobQueue({ filePath, now: clock(), maxQueueSize: 5 });
    assert.equal(reopened.stats().persistent, true);
    assert.equal(reopened.stats().queued, 2);
    assert.equal(reopened.enqueue({ plan: "ignored" }, { idempotencyKey: "request-1" }).id, "job-1");
    assert.equal(reopened.claimNext().id, "job-1");
    assert.equal(reopened.claimNext().id, "job-2");
    reopened.close();
  });
});

test("running jobs become interrupted after restart and are never automatically replayed", async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, "jobs.json");
    const queue = createPersistentExecutionJobQueue({ filePath, now: clock() });
    queue.enqueue({ plan: "audit-1" }, { id: "job-interrupted" });
    const claimed = queue.claimNext();
    assert.equal(claimed.state, "running");
    assert.equal(claimed.attempts, 1);
    queue.close();

    const recovered = createPersistentExecutionJobQueue({ filePath, now: clock() });
    const job = recovered.getJob("job-interrupted");
    assert.equal(job.state, "interrupted");
    assert.equal(job.attempts, 1);
    assert.equal(job.error.includes("manual recovery"), true);
    assert.equal(recovered.stats().interrupted, 1);
    assert.equal(recovered.claimNext(), null);
    recovered.close();
  });
});

test("interrupted jobs require an explicit requeue decision and preserve attempt history", async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, "jobs.json");
    const first = createPersistentExecutionJobQueue({ filePath, now: clock() });
    first.enqueue({ plan: "audit-retry" }, { id: "job-retry" });
    first.claimNext();
    first.close();

    const queue = createPersistentExecutionJobQueue({ filePath, now: clock() });
    assert.throws(
      () => queue.requeueInterrupted("unknown"),
      (error) => error.code === "JOB_NOT_FOUND"
    );
    const requeued = queue.requeueInterrupted("job-retry");
    assert.equal(requeued.state, "queued");
    assert.equal(requeued.attempts, 1);
    const secondClaim = queue.claimNext();
    assert.equal(secondClaim.state, "running");
    assert.equal(secondClaim.attempts, 2);
    const completed = queue.complete("job-retry", { status: "processed" });
    assert.equal(completed.state, "completed");
    assert.equal(completed.attempts, 2);
    queue.close();

    const finalQueue = createPersistentExecutionJobQueue({ filePath, now: clock() });
    assert.equal(finalQueue.getJob("job-retry").state, "completed");
    assert.equal(finalQueue.getJob("job-retry").result.status, "processed");
    finalQueue.close();
  });
});

test("requeued interrupted jobs return to the tail of the FIFO queue", async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, "jobs.json");
    const first = createPersistentExecutionJobQueue({ filePath, now: clock() });
    first.enqueue({ plan: "first-attempt" }, { id: "job-interrupted-first" });
    first.enqueue({ plan: "already-waiting" }, { id: "job-still-queued" });
    assert.equal(first.claimNext().id, "job-interrupted-first");
    first.close();

    const queue = createPersistentExecutionJobQueue({ filePath, now: clock() });
    queue.requeueInterrupted("job-interrupted-first");
    assert.equal(queue.claimNext().id, "job-still-queued");
    assert.equal(queue.claimNext().id, "job-interrupted-first");
    queue.close();
  });
});

test("interrupted jobs can be explicitly finalized as failed without replay", async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, "jobs.json");
    const first = createPersistentExecutionJobQueue({ filePath, now: clock() });
    first.enqueue({ plan: "manual-review" }, { id: "job-manual" });
    first.claimNext();
    first.close();

    const queue = createPersistentExecutionJobQueue({ filePath, now: clock() });
    const failed = queue.failInterrupted("job-manual", "Operator chose not to replay this audit.");
    assert.equal(failed.state, "failed");
    assert.equal(failed.error, "Operator chose not to replay this audit.");
    assert.equal(queue.stats().failed, 1);
    queue.close();
  });
});

test("exclusive lock prevents two live processes from opening the same store", async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, "jobs.json");
    const first = createPersistentExecutionJobQueue({ filePath });
    assert.throws(
      () => createPersistentExecutionJobQueue({ filePath }),
      (error) => error instanceof ExecutionJobStoreError && error.code === "STORE_LOCKED"
    );
    first.close();
    const second = createPersistentExecutionJobQueue({ filePath });
    second.close();
  });
});

test("dead same-host process locks are reclaimed without weakening live-process exclusion", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async (directory) => {
    const filePath = join(directory, "jobs.json");
    const lockPath = filePath + ".lock";
    await writeFile(lockPath, JSON.stringify({
      pid: 2147483647,
      host: hostname(),
      token: "stale-lock-token",
      createdAt: new Date().toISOString()
    }), { encoding: "utf8", mode: 0o600 });

    const queue = createPersistentExecutionJobQueue({ filePath });
    assert.equal(queue.stats().persistent, true);
    queue.close();
  });
});

test("store checksum detects modified or corrupted durable state and fails closed", async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, "jobs.json");
    const queue = createPersistentExecutionJobQueue({ filePath });
    queue.enqueue({ plan: "protected" }, { id: "job-protected" });
    queue.close();

    const contents = await readFile(filePath, "utf8");
    await writeFile(filePath, contents.replace("protected", "tampered"), "utf8");
    assert.throws(
      () => createPersistentExecutionJobQueue({ filePath }),
      (error) => error instanceof ExecutionJobStoreError && error.code === "STORE_CHECKSUM_MISMATCH"
    );
    const lockPath = filePath + ".lock";
    await assert.rejects(stat(lockPath), (error) => error.code === "ENOENT");
  });
});

test("atomic persistence failure rolls back queue mutations", () => {
  let failSave = true;
  const persistence = Object.freeze({
    load: () => null,
    save: () => {
      if (failSave) throw new Error("disk unavailable");
    },
    close: () => undefined
  });
  const queue = createExecutionJobQueue({ persistence });
  assert.throws(
    () => queue.enqueue({ plan: "must-not-appear" }, { id: "job-rollback" }),
    (error) => error instanceof ExecutionJobQueueError && error.code === "PERSISTENCE_FAILED"
  );
  assert.equal(queue.stats().total, 0);
  failSave = false;
  assert.equal(queue.enqueue({ plan: "persisted" }, { id: "job-committed" }).state, "queued");
  assert.equal(queue.stats().total, 1);
  queue.close();
});

test("queue rejects mutations after close but keeps read-only inspection available", async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, "jobs.json");
    const queue = createPersistentExecutionJobQueue({ filePath });
    queue.enqueue({ plan: "read-only" }, { id: "job-closed" });
    queue.close();
    assert.equal(queue.getJob("job-closed").state, "queued");
    assert.throws(
      () => queue.enqueue({ plan: "blocked" }),
      (error) => error.code === "QUEUE_CLOSED"
    );
    assert.throws(
      () => queue.claimNext(),
      (error) => error.code === "QUEUE_CLOSED"
    );
  });
});

test("persistent store rejects symlink job store files", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async (directory) => {
    const target = join(directory, "target.json");
    const filePath = join(directory, "jobs.json");
    await writeFile(target, "{}", "utf8");
    const { symlink } = await import("node:fs/promises");
    await symlink(target, filePath);
    assert.throws(
      () => createPersistentExecutionJobQueue({ filePath }),
      (error) => error instanceof ExecutionJobStoreError && error.code === "UNSAFE_STORE_FILE"
    );
    await assert.rejects(stat(filePath + ".lock"), (error) => error.code === "ENOENT");
  });
});

test("idempotent retries return the existing job even when the queue is at capacity", () => {
  const queue = createExecutionJobQueue({ maxQueueSize: 1, maxJobs: 1 });
  const first = queue.enqueue({ plan: "first" }, { idempotencyKey: "same-request" });
  const duplicate = queue.enqueue({ plan: "different" }, { idempotencyKey: "same-request" });
  assert.equal(duplicate.id, first.id);
  assert.throws(
    () => queue.enqueue({ plan: "second" }, { idempotencyKey: "new-request" }),
    (error) => error.code === "QUEUE_FULL"
  );
});

test("pre-existing job stores with broad POSIX permissions are rejected", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async (directory) => {
    const filePath = join(directory, "jobs.json");
    await writeFile(filePath, JSON.stringify({ format: "untrusted" }), "utf8");
    await chmod(filePath, 0o644);
    assert.throws(
      () => createPersistentExecutionJobQueue({ filePath }),
      (error) => error instanceof ExecutionJobStoreError && error.code === "UNSAFE_STORE_PERMISSIONS"
    );
    await assert.rejects(stat(filePath + ".lock"), (error) => error.code === "ENOENT");
  });
});

test("store adapter exposes stable schema envelope and private file permissions", async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, "direct-store.json");
    const store = createJsonFileExecutionJobStore({ filePath });
    let getterCalled = false;
    const unsafeSnapshot = {};
    Object.defineProperty(unsafeSnapshot, "data", {
      enumerable: true,
      get() {
        getterCalled = true;
        return "unsafe";
      }
    });
    assert.throws(
      () => store.save(unsafeSnapshot),
      (error) => error instanceof ExecutionJobStoreError && error.code === "INVALID_SNAPSHOT"
    );
    assert.equal(getterCalled, false);
    store.save({ schemaVersion: 1, jobs: [] });
    const loaded = store.load();
    assert.deepEqual(loaded, { schemaVersion: 1, jobs: [] });
    const envelope = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(envelope.format, "jb-expert-qa.execution-job-store");
    assert.equal(envelope.version, 1);
    assert.match(envelope.checksum, /^[a-f0-9]{64}$/u);
    const info = await stat(filePath);
    assert.equal(info.isFile(), true);
    if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
    store.close();
  });
});
