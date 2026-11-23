# Phase 5 — Block 1: Autonomous Execution Runtime Service

## Purpose

Introduce a process-level runtime boundary around the existing trusted QA Engine Orchestrator. The runtime is the host-facing lifecycle entry point for future independent execution infrastructure; it does not replace the registry, orchestrator, policy engine or execution ledger.

## Contract

The host creates the orchestrator first, with its sealed engine registry, explicit policy, preauthorized permission set and real external approval provider. The host then creates the runtime:

```js
import {
  createAutonomousExecutionRuntime,
  createQaEngineRegistry,
  createQaEngineOrchestrator
} from "@jb/expert-qa";

const registry = createQaEngineRegistry({ adapters: trustedAdapters });
registry.seal();

const orchestrator = createQaEngineOrchestrator({
  registry,
  policy: hostPolicy,
  requestApproval: hostApprovalService.request
});

const runtime = createAutonomousExecutionRuntime({
  orchestrator,
  enabled: true // explicit host opt-in; omitted means disabled
});
```

The runtime exports a narrow API:

- `getStatus()` — safe operational state, accepting/active flags, engine count and policy ID.
- `listEngines()` — read-only catalog from the existing orchestrator.
- `getPolicy()` — read-only policy snapshot from the existing orchestrator.
- `verifyLedger()` — read-only verification of the orchestrator's existing ledger.
- `execute(plan, { signal, executionId })` — delegates to the trusted orchestrator; no policy or runner can be supplied by the caller.
- `close()` — stops admission and waits for an in-flight execution to settle before closing.

## Safety invariants

- Runtime is disabled unless the host explicitly passes `enabled: true`.
- Construction and status reads do not invoke engines.
- The runtime accepts only a trusted orchestrator exposing the expected own methods.
- Engine dispatch, allowlists, permissions, risk classification, human approval, resource/time limits and ledger writes remain exclusively inside the orchestrator and its execution engine.
- Runtime permits one active execution per instance; concurrent submissions are rejected rather than silently queued.
- Unknown execution options and accessor properties are rejected.
- `close()` stops new submissions and drains an active execution; it does not cancel or kill a running adapter.
- No HTTP execution endpoint, remote worker, queue, scheduler, auto-approval mechanism, or persistence store is created in this block.

## Explicit non-goals for this block

The next blocks will add bounded job lifecycle and queueing, worker dispatch, durable/restart-safe job storage, cancellation/retry semantics and process isolation. The first block deliberately establishes the boundary without duplicating those responsibilities.

## Validation

`node --test tests/autonomous-execution-runtime.test.js tests/engine-orchestrator.test.js tests/autonomous-execution.test.js`

The root `core-validation` and `engine-certification` workflows also run the repository regression and package checks on the pull request.