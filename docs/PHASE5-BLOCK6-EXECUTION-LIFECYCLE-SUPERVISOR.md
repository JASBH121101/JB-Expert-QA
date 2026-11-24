# Phase 5 — Block 6: Execution Lifecycle Supervisor

## Scope

Add one host-facing supervisor that coordinates the lifecycle of the existing autonomous execution runtime, bounded queue and single-concurrency worker. It closes the operational gap between separately constructed components without moving policy, permission checks, approvals or engine dispatch out of the orchestrator.

## Public API

```js
import {
  createExecutionLifecycleSupervisor,
  createExecutionJobQueue,
  createExecutionWorker,
  createAutonomousExecutionRuntime
} from "@jb/expert-qa";

const runtime = createAutonomousExecutionRuntime({
  orchestrator,
  enabled: true
});
const queue = createExecutionJobQueue();
const worker = createExecutionWorker({ queue, runtime });

const supervisor = createExecutionLifecycleSupervisor({
  runtime,
  queue,
  worker
});

// Submission is allowed before start, but no work executes automatically.
supervisor.enqueue(auditPlan, { id: "audit-001" });

// Starting is explicit and requires an enabled, ready runtime.
supervisor.start();
await supervisor.drain({ maxJobs: 10 });

// Release resources in dependency order.
await supervisor.close();
```

The standalone import is also available as `@jb/expert-qa/execution-supervisor`.

## Lifecycle contract

- Construction is inert. No worker starts, no queue is polled and no runtime execution is triggered.
- `idle` accepts job submissions but does not consume them.
- `start()` requires the runtime to be explicitly enabled and in `ready` state, then explicitly starts the existing worker.
- `runNext()` and `drain()` are available only after `start()`. Queue bounds, worker concurrency, runtime admission and orchestrator policy remain in their existing components.
- `getStatus()` provides a read-only combined snapshot of supervisor, worker, runtime and queue state.
- `close()` transitions to `closing` immediately, rejects new submissions and work requests, then awaits worker stop, closes the runtime and releases queue storage last.
- Repeated calls to `close()` share the same completion promise.
- Cleanup continues through all resources even when one shutdown stage fails. A sanitized `ExecutionLifecycleSupervisorError` identifies failing stages and error codes without copying private exception messages.
- `close({ abortActive: true, reason })` requests worker cancellation before waiting for shutdown. Abort remains cooperative; the supervisor never kills an in-process promise.
- Calling `close()` without `abortActive` preserves graceful shutdown and lets the active execution settle.

## Safety invariants

- The supervisor is a lifecycle coordinator, not a second orchestrator. It cannot provide alternate policies, approvals, permissions, engine runners or ledger writers.
- No automatic start, background polling, retry scheduler, HTTP endpoint, remote worker, process manager or paid service is introduced.
- The queue can accept jobs while the supervisor is idle, but no execution occurs until explicit start and an explicit `runNext()` or `drain()`.
- New work is rejected as soon as shutdown begins.
- Resource closure order is fixed: worker, runtime, queue. Durable queue locks are released only after the worker and runtime stop using them.
- This is in-process lifecycle coordination; it is not a substitute for an OS service manager, process isolation or distributed high availability.

## Validation

```sh
node --test tests/execution-supervisor.test.js tests/execution-worker.test.js tests/execution-job-queue.test.js tests/execution-job-persistence.test.js tests/autonomous-execution-runtime.test.js
```

The pull request must also pass Core Validation, Security QA, JB Engines Certification and package-distribution checks before merge.


## Phase 5 Block 7 follow-up

The supervisor now also exposes explicit operator inspection and recovery methods (getJob, listJobs, recoverInterrupted, failInterrupted and retryFailed). See [Phase 5 Block 7 — Operator Inspection & Recovery Controls](PHASE5-BLOCK7-OPERATOR-INSPECTION-RECOVERY.md) for the API and safety contract.
