# Phase 5 — Block 2: Job Lifecycle and Bounded Queue

## Scope
Add a bounded in-memory FIFO job lifecycle manager, separate from execution. It provides queued/running/completed/failed/cancelled states, queue admission limits, stable IDs, idempotency keys, result/error metadata, terminal cleanup, snapshots, and stats.

## Lifecycle
- queued -> running -> completed
- queued -> running -> failed
- queued -> cancelled

Cancellation is intentionally limited to queued jobs. Running execution cancellation and durable recovery are separate blocks.

## API
- createExecutionJobQueue({ maxQueueSize, maxJobs, now })
- enqueue(payload, { id, idempotencyKey })
- claimNext()
- complete(id, result)
- fail(id, error)
- cancel(id)
- getJob(id)
- listJobs({ state })
- removeTerminal(id)
- stats()

## Limits and safety
- Defaults: maxQueueSize 50; maxJobs 500.
- Queue size cap: 1–1000; retained-job cap: 1–10000.
- Payload/result are JSON serializable and cloned before storing.
- Caller-provided idempotency keys prevent duplicate queued jobs.
- Only queued jobs can be cancelled; only running jobs can complete/fail.
- Terminal jobs can be removed to free retention capacity.
- In-memory only; no workers, automatic execution, persistence, scheduler, HTTP API or paid services.

## Persistence follow-up

The base `createExecutionJobQueue()` remains in-memory by default. Phase 5 Block 4 adds the opt-in `createPersistentExecutionJobQueue({ filePath, ... })` wrapper, which preserves this lifecycle contract using a local durable JSON store and explicit interrupted-job recovery. See `PHASE5-BLOCK4-DURABLE-JOB-PERSISTENCE.md` for durability and recovery semantics.
