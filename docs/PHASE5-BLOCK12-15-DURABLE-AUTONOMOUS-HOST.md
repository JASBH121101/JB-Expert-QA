# Phase 5 — Block 12.15: Durable Autonomous Host Composition

## Objective

Provide one host-facing factory that composes the already certified execution components into a local, durable autonomous host. Runtime execution must not use GitHub Actions, a remote queue or a paid scheduler. GitHub Actions remains a validation system only.

## Public API

```js
import {
  createAutonomousExecutionHost,
  createQaEngineRegistry,
  createQaEngineOrchestrator
} from "@jb/expert-qa";

const registry = createQaEngineRegistry();
for (const adapter of trustedAdapters) registry.register(adapter);
registry.seal();

const orchestrator = createQaEngineOrchestrator({
  registry,
  policy: hostPolicy,
  requestApproval: hostApprovalService.request
});

const host = createAutonomousExecutionHost({
  orchestrator,
  storageDirectory: "/var/lib/jb-expert-qa",
  enabled: true,             // explicit opt-in; omitted means disabled
  pollIntervalMs: 1000,
  maxJobsPerTick: 5
});

// Submission can happen before start, but it never executes during construction.
host.enqueue(auditPlan, { id: "audit-001" });

// The host begins bounded local execution only after this explicit call.
host.start();

// Inspect durable jobs and operational events.
host.getStatus();
host.listJobs({ state: "interrupted" });
host.listEvents({ limit: 100 });

// Shutdown is graceful, idempotent and releases both persistent store locks.
await host.close();
```

The same factory is available from `@jb/expert-qa/autonomous-execution-host`.

## Composition and ownership

The host composes the existing `createAutonomousExecutionRuntime`, `createPersistentExecutionJobQueue`, `createPersistentExecutionEventJournal`, `createExecutionWorker`, `createExecutionLifecycleSupervisor` and `createAutonomousExecutionRunner` components. It does not create an alternate engine dispatcher or move policy, permissions, human approval, containment or ledger responsibility out of the trusted orchestrator.

The host owns the persistent queue and event journal. Its supervisor closes the worker, runtime, queue and journal in the established dependency order. Files are created in the host-supplied absolute storage directory as `execution-jobs.json` and `execution-events.json`. Keep that directory outside the source repository and protect it with host-level access controls and backups.

Only one host may hold the two local store locks at a time. This is a single-process, single-host deployment model; it is not a distributed queue or HA cluster.

## Durability boundaries and host integration

The factory durably stores the job queue and operational event journal. It does not replace or silently reconfigure the orchestrator's execution ledger. The underlying execution engine uses an in-memory ledger by default. When durable execution-audit records are required, the embedding application must create a `createJsonlExecutionLedger(...)` instance and pass it into `createQaEngineOrchestrator({ ledger })`. The host does not assume ownership of that externally supplied ledger; close the host first, then close the ledger in the embedding application's shutdown path.

This is a host library factory, not an OS service installer. It does not register systemd/Windows services or attach process signal handlers. A long-lived application or OS service must own the process lifecycle, call `host.start()` after its own startup checks, and await `host.close()` during shutdown. Runtime job execution itself has no GitHub Actions dependency.

## Restart and recovery contract

- Queued jobs survive a restart and remain eligible for the explicitly started runner.
- Jobs found in `running` state during queue restoration are changed to `interrupted`.
- The host runner never claims or automatically replays interrupted jobs.
- An operator reviews a job and explicitly calls `recoverInterrupted(id)` or `failInterrupted(id, reason)`.
- A recovered job increments its attempt history and returns to the bounded FIFO queue.
- A job may have performed external work before a crash but failed to persist completion. Manual recovery can therefore repeat that work; exactly-once execution is not guaranteed. Keep actions read-only/idempotent or provide their own external idempotency strategy.

## Lifecycle and safety

- Construction is inert. The host does not start polling, run jobs or invoke engine adapters.
- The runtime is disabled unless `enabled: true` is passed. Explicit `start()` is still required.
- `start()` activates the supervisor through the runner; duplicate active ownership is rejected.
- `close()` stops runner polling, awaits any bounded in-flight drain, then closes owned runtime and durable stores. Concurrent close calls share one promise.
- The host exposes narrow enqueue, inspection, manual recovery, event inspection and ledger-verification methods; it does not expose its mutable internal components.
- No GitHub Actions runtime dependency, shell execution, automatic approval, permission escalation, automatic interrupted-job replay, cloud queue or paid service is introduced.

## Validation

The focused host tests must prove inert construction, explicit opt-in, durable job/event state across restart, interrupted-job quarantine, manual recovery before execution, exclusive store locking, and graceful shutdown during active work. Full Core Validation, Security QA, native Linux/Windows containment labs, package distribution and JB Engines Certification remain required before merge.
