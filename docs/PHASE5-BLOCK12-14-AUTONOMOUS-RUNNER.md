# Phase 5 — Block 12.14: Host-Independent Autonomous Runner

## Objective

Close the operational gap between the existing explicitly-driven execution supervisor and a continuously operating local host. The runner must drive the already policy-gated queue/worker lifecycle on the host itself, without GitHub Actions, CI polling, a paid service, or a remote scheduler.

## Scope

- Add a separate opt-in host runner that wraps the existing supervisor; do not make supervisor construction or Dashboard startup implicitly execute jobs.
- Provide explicit start/stop lifecycle and a bounded idle polling interval. It must drain queued work in bounded batches, then wait when no eligible work exists.
- Reuse existing runtime, queue, worker, containment, policy, approval and durable event journal. No alternate execution path.
- Enforce single-runner ownership per instance; reject duplicate starts and serialize tick/drain operations.
- Expose sanitized status: state, last tick, last activity, processed counts, consecutive runner errors, next poll estimate and whether queue persistence is enabled.
- Handle graceful shutdown: stop admitting runner ticks, wait for in-flight bounded drain, then leave resource closing to the supervisor/host owner.
- Add an optional maximum consecutive runner error threshold that stops the runner in fail-closed state; never silently restart the QA runtime or replay interrupted jobs.
- Add bounded and validated configuration; no unbounded drain, auto-retry policy, or automatic recovery of interrupted/running jobs.
- Add lifecycle event journal records for runner start/stop/tick/failure using existing sanitized event schema.

## Explicit exclusions

- No GitHub Actions dependency for runtime execution.
- No shell/command execution, AI-plan trust, policy bypass, permission escalation, approvals auto-granted, or side-effect handlers added.
- No remote server, cloud queue, paid service, distributed multi-host mode or background startup installation.
- No auto-replay of interrupted jobs; these remain operator-reviewed.
- No changes to Dashboard execution controls or implicit runner creation.

## Safety invariants

1. Execution requires an explicitly enabled and ready runtime, supervisor start, and runner start.
2. Runner can only call the existing supervisor drain/run surface.
3. All jobs retain queue capacity, runtime admission, orchestrator policy, permission, approval, containment and audit constraints.
4. Work is bounded per tick; poll intervals and batch sizes have strict limits.
5. Shutdown does not force-kill in-process tasks; cancellation remains cooperative.
6. The runner does not execute from construction and is not started by importing modules.

## Validation plan

- Unit tests: inert construction, invalid config, explicit start, duplicate start, bounded batch, idle wait scheduling, tick concurrency protection, stop during idle and stop during active drain, threshold-triggered fail-closed state, safe event emission.
- Integration: persistent queue plus supervisor plus runner across queued work; prove normal queued work executes without CI, interrupted jobs remain un-replayed.
- Regression: worker, queue, supervisor, runtime, containment and event-journal suites.
- Certification: Core Validation, Security QA, Security Guard multi-runtime, JB Engines Certification, Linux and Windows native labs.

**Block 12.14 remains incomplete until implementation, focused tests, full required checks and post-merge certification pass on one verified main SHA.**
