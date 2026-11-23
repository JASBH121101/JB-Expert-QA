# Phase 5 — Block 5: Retry, Timeout & Cooperative Cancellation

## Scope

Add bounded operator-controlled retries and cooperative cancellation/deadlines to the existing local-first execution queue and its manually activated worker. The queue remains synchronous, bounded and optionally durable. The worker remains single-concurrency and never starts a polling loop.

## Queue retry contract

```js
import { createPersistentExecutionJobQueue } from "@jb/expert-qa";

const queue = createPersistentExecutionJobQueue({
  filePath: "./.jb-expert-qa/jobs.json",
  maxAttempts: 3
});

// After reviewing a failed job, an operator can explicitly request a retry:
const retry = queue.retryFailed("job-id");
// Or choose a specific delay (0–86,400,000 ms):
queue.retryFailed("job-id", { delayMs: 5000 });
```

- `maxAttempts` is an integer from 1 to 10; default is 3.
- Attempts count successful claims, including attempts interrupted by process shutdown.
- Each job stores its own `maxAttempts` limit. The value survives durable restarts and cannot silently change when a queue is reopened with different defaults.
- Only failed jobs can be retried through `retryFailed()`. Recovery of interrupted jobs remains an explicit separate operation and is subject to the same per-job attempt limit.
- Retries are never automatic. The operator explicitly decides whether a failed operation is safe to repeat.
- Default retry delay is exponential: 1 s, 2 s, 4 s, and so on, capped at 60 s. A caller may explicitly set a delay from 0 to 24 hours.
- A delayed retry remains in the queued state with a persisted `nextAttemptAt`. `claimNext()` skips it until due and can still claim other eligible FIFO jobs.
- When the job becomes due, its next successful claim increments `attempts`. The prior error remains visible until the job is claimed.

## Worker timeout and cancellation

```js
import { createExecutionWorker } from "@jb/expert-qa";

const worker = createExecutionWorker({
  queue,
  runtime,
  timeoutMs: 120000 // optional: 1–600,000 ms
});

worker.start(); // explicit opt-in
const result = await worker.runNext();

// An operator can request active cancellation:
worker.cancelActive("Operator requested cancellation");
```

- If `timeoutMs` is omitted, there is no worker deadline.
- The worker passes `{ executionId, signal }` to the runtime. The runtime already forwards the signal to the policy-gated orchestrator.
- Timeout aborts the signal and records a failed job once the execution promise settles.
- `cancelActive(reason)` aborts the active signal and records a cancelled job once the execution promise settles. It returns false when no cancellable active execution exists or an abort was already requested.
- Cancellation is cooperative. An adapter must observe the signal and stop its own work. JavaScript cannot forcibly terminate an arbitrary in-process promise.
- A non-cooperative adapter remains the active job even after its signal is aborted. The worker does not claim another job until the original execution settles; this prevents overlapping executions and false completion claims.
- `stop()` remains graceful and waits for active work. Call `cancelActive()` first when an explicit abort is required.
- The existing orchestrator remains the sole authority for engine dispatch, policy, permissions, approvals and execution ledger.

## Delivery semantics and safety

- No automatic retry is performed after an exception, timeout or process restart.
- Operator retries can repeat side effects. Use idempotent/read-only operations where possible and retain stable downstream idempotency keys for side-effecting integrations.
- A timeout is not proof that an external action did not complete. A remote service may have accepted an operation before the local adapter observed cancellation.
- Queue persistence is not exactly-once execution and remains single-process/local-filesystem storage.
- No hosted scheduler, remote queue, cloud database, paid service, auto-start or background polling loop is introduced.

## Validation

```sh
node --test tests/execution-job-queue.test.js tests/execution-job-persistence.test.js tests/execution-worker.test.js tests/autonomous-execution-runtime.test.js
```

The pull request must also pass the repository's normal certification checks before any merge to `main`.
