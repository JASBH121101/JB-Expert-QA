# Phase 5 — Block 4: Durable Job Persistence & Recovery

## Scope

Add local durable storage for the existing bounded execution queue. The queue contract remains synchronous so it is compatible with the existing in-process worker. Every mutating transition is committed to a versioned local JSON store before the operation is reported as successful.

## Public API

\`\`\`js
import { createPersistentExecutionJobQueue } from "@jb/expert-qa";

const queue = createPersistentExecutionJobQueue({
  filePath: "./.jb-expert-qa/jobs.json",
  maxQueueSize: 50,
  maxJobs: 500
});

try {
  // Pass queue to createExecutionWorker({ queue, runtime }).
  // Jobs are consumed only after explicit worker.start() / runNext() / drain().
} finally {
  queue.close();
}
\`\`\`

The standalone export is also available as \`@jb/expert-qa/execution-job-persistence\`.

## Durability and integrity

- The store is local-file based; no cloud database, hosted queue, paid service or GitHub Actions runner is required for job storage.
- Each transition is saved as a versioned JSON snapshot with a SHA-256 integrity checksum.
- Writes use a unique same-directory temporary file, restrictive file permissions, file fsync, atomic rename, and directory fsync where supported.
- The store acquires an exclusive \`.lock\` file. A second live process cannot open the same file concurrently.
- Store files are created with restrictive permissions (0600); newly created directories request 0700.
- Symbolic links, unsupported schema versions, oversized files, invalid JSON and checksum mismatches fail closed.
- Queue mutations roll back in-memory state if durable save fails.
- The file-store adapter is synchronous by design so the current worker's synchronous \`claimNext()\` contract is preserved.
- Always call \`queue.close()\` during orderly shutdown. Do not commit job-store files or lock files to the source repository.

## Restart recovery

- Jobs persisted as \`queued\` remain in FIFO order after restart.
- Jobs persisted as \`running\` are changed to \`interrupted\` at startup and recorded back to the store.
- Interrupted jobs are excluded from \`claimNext()\`; the worker cannot execute them by accident.
- An operator must explicitly call \`requeueInterrupted(id)\` to retry, or \`failInterrupted(id, reason)\` to close the job without replay.
- \`attempts\` increments for each successful queue claim and is preserved through recovery.
- The queue exposes the interrupted count and job records for review.

## Delivery semantics and limitations

This is durable queue state, not an exactly-once execution guarantee. A process can stop after an engine has performed work but before the queue records completion. Requeueing such an interrupted job can execute that work again. Therefore:
- Recovery is manual, not automatic.
- Keep engine operations read-only or idempotent where possible.
- Any future side-effecting engine must use its own idempotency key / external transaction strategy and remain policy-gated.
- The lock supports one active process per local store; this is not a distributed multi-host queue or high-availability cluster.
- Filesystem durability depends on the host filesystem and hardware honoring fsync/rename semantics.

## Validation

\`node --test tests/execution-job-persistence.test.js tests/execution-job-queue.test.js tests/execution-worker.test.js tests/autonomous-execution-runtime.test.js\`

Core Validation, package distribution, Security QA, and JB Engines Certification run on the pull request.

## Lock recovery

A stale same-host lock is reclaimed only after checking that its recorded PID no longer exists and that the lock file has not changed. Locks from another host, a live process, or an ambiguous state fail closed and require operator review.

## Phase 5 Block 5 follow-up

The queue now persists each job's `nextAttemptAt` and per-job `maxAttempts` values for explicit operator-controlled retries. Delayed retries survive restarts; `claimNext()` skips jobs until their retry time. Timeout and active cancellation are cooperative worker controls, not exactly-once or forced termination guarantees. See `PHASE5-BLOCK5-RETRY-TIMEOUT-CANCELLATION.md`.