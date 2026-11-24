# Phase 5 — Block 7: Operator Inspection & Recovery Controls

## Scope

Expose the queue's existing inspection and manual recovery operations through the Phase 5 lifecycle supervisor. The supervisor remains the single host-facing operational facade for the runtime, worker and queue. This block does not introduce new retry policy, recovery automation, background processing or engine dispatch.

## Public API

The following methods are added to the object returned by createExecutionLifecycleSupervisor():

- getJob(id) — retrieve one immutable job snapshot, or null when the identifier is unknown.
- listJobs({ state }) — retrieve immutable job snapshots, optionally filtered by a supported lifecycle state.
- recoverInterrupted(id) — explicitly requeue one job persisted as interrupted. This delegates to the queue's existing requeueInterrupted() contract.
- failInterrupted(id, reason?) — explicitly finalize an interrupted job as failed when an operator decides it must not be replayed.
- retryFailed(id, { delayMs? }) — explicitly requeue a failed job using the queue's existing attempt limit and retry-delay rules.

These methods are available while the supervisor is idle or running and reject access once shutdown begins. The built-in queue implementations support all five methods. Existing custom queue adapters that only implement the original lifecycle contract remain compatible; when an adapter omits one of these optional inspection/recovery methods, the corresponding supervisor operation fails closed with QUEUE_CAPABILITY_UNAVAILABLE. Queue validation remains authoritative for unknown jobs, invalid transitions, queue capacity and attempt limits.

## Recovery workflow

~~~js
const interrupted = supervisor.listJobs({ state: "interrupted" });

for (const job of interrupted) {
  // Decide per job. Never replay all interrupted jobs automatically.
  if (operatorApprovedRecovery(job)) {
    supervisor.recoverInterrupted(job.id);
  } else {
    supervisor.failInterrupted(job.id, "Operator declined replay");
  }
}

// Requeued work remains queued until the host explicitly starts and drives it.
supervisor.start();
await supervisor.runNext();
await supervisor.close();
~~~

The example's operatorApprovedRecovery is a host-owned decision and is not supplied by this package. Recovery approval must not be inferred by the supervisor.

## Safety invariants

- Recovery and retry are operator-invoked methods; there is no startup replay, retry scheduler, automatic drain or background poller.
- recoverInterrupted() and retryFailed() only transition queue state. They do not invoke the worker or runtime.
- Requeued jobs execute only after explicit supervisor start and a subsequent explicit runNext() or drain().
- Attempt limits, queue capacity and retry-delay validation remain enforced by the existing queue.
- failInterrupted() requires an optional reason to be a non-empty string of at most 500 characters; no raw exception object is accepted by this facade.
- Job snapshots remain read-only. This block does not expose queue internals, raw persistence handles or terminal-job deletion; evidence retention remains under the existing queue contract.
- The orchestrator remains the sole authority for engine selection, policy, permissions, approvals and ledger writes.

## Compatibility and cost

No new dependency, service, network call, database, filesystem format or paid component is introduced. The API delegates to the existing in-memory or persistent queue implementation. The same supervisor standalone package export is used; no additional package subpath is required.

## Validation

~~~sh
node --test tests/execution-supervisor.test.js tests/execution-worker.test.js tests/execution-job-queue.test.js tests/execution-job-persistence.test.js tests/autonomous-execution-runtime.test.js
~~~

The pull request must also pass Core Validation, Security QA, JB Engines Certification and package-distribution checks before merge.
