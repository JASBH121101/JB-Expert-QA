# Phase 5 — Block 3: Worker Execution

## Scope

Add a manually activated, single-concurrency in-process worker that consumes queued audit plans and delegates them to the existing policy-gated Autonomous Execution Runtime. Worker construction is inert; no worker starts automatically.

## Lifecycle

- `stopped` -> `ready` only after explicit `start()` and a ready, enabled QA runtime.
- `ready` -> `busy` while one queued job executes.
- `busy` -> `ready` after the queue records `completed` or `failed`.
- `ready` / `busy` -> `stopping` -> `stopped` on `stop()`.

`runNext()` processes one job. `drain({ maxJobs })` sequentially processes up to the requested bounded batch and stops when the queue is empty.

## Execution boundary

- Worker claims jobs only after verifying that the QA runtime is explicitly enabled and ready.
- Every claimed plan is passed to `runtime.execute(plan, { executionId: job.id })`.
- Engine dispatch, permission checks, risk limits, external approval and audit-ledger writes remain owned by the runtime/orchestrator.
- Successful runtime completion marks the queue job `completed`, even when the QA report itself contains failed findings; queue completion means the job was processed, not that the audited project passed.
- Runtime exceptions mark the job `failed` with redacted error text.
- Worker concurrency is fixed at one in this block. Additional worker instances require their own runtime instances.
- `stop()` stops new claims and waits for the active job to settle; it does not kill an in-flight engine.

## Non-goals

No background polling loop, HTTP server, remote workers, process isolation, durable job persistence, automatic retries, scheduler or paid service is introduced in this block. Hosts explicitly call `runNext()` or `drain()` from a local process/CLI.

## Validation

`node --test tests/execution-worker.test.js tests/execution-job-queue.test.js tests/autonomous-execution-runtime.test.js`

Core Validation, package distribution and JB Engines Certification run on the pull request.