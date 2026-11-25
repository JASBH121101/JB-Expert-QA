# Phase 5 — Block 12.14: Host-Independent Autonomous Runner

## Objective

Close the operational gap between the existing explicitly-driven execution supervisor and a continuously operating local host. The runner drives the existing policy-gated queue/worker lifecycle on the host itself, without GitHub Actions, CI polling, a paid service, or a remote scheduler.

## Scope

- Add a separate opt-in host runner that wraps the existing supervisor; supervisor construction and Dashboard startup remain inert.
- Provide explicit start/stop lifecycle and a bounded idle polling interval. Drain queued work in bounded batches, then wait when no eligible work exists.
- Reuse the existing runtime, queue, worker, containment, policy, approval and durable event-journal path. No alternate execution path.
- Enforce one active runner owner per supervisor, serialize tick/drain operations, and make concurrent stop requests idempotent.
- Expose sanitized status: state, last tick, last activity, processed counts, consecutive runner errors, next poll timestamp, event emission failures and queue persistence state.
- Handle graceful shutdown: stop admitting runner ticks, wait for an in-flight bounded drain, then leave resource closing to the supervisor/host owner.
- Stop in a fail-closed state after the configured consecutive-error threshold. Never silently restart the QA runtime or replay interrupted jobs.
- Use the existing event schema for runner start/stop/failure and productive-tick records. The host passes the same journal instance used by the supervisor; idle polls are not journaled to avoid filling the journal with empty events.

## Explicit exclusions

- No GitHub Actions dependency for runtime execution.
- No shell/command execution, AI-plan trust, policy bypass, permission escalation, approvals auto-granted, or side-effect handlers added.
- No remote server, cloud queue, paid service, distributed multi-host mode or background startup installation.
- No automatic replay of interrupted jobs; these remain operator-reviewed.
- No Dashboard execution-control changes or implicit runner creation.

## Safety invariants

1. Execution requires an explicitly enabled and ready runtime, supervisor start, and explicit runner start.
2. The runner can only invoke the existing supervisor drain surface.
3. All jobs retain queue capacity, runtime admission, orchestrator policy, permission, approval, containment and audit constraints.
4. Work is bounded per tick; poll intervals and batch sizes have strict limits.
5. Shutdown does not force-kill in-process tasks; cancellation remains cooperative.
6. Construction and module import never execute jobs or start timers.

## Implementation progress

- Initial runner module and public root/package exports are present.
- Status telemetry reports the actual queue persistence field and next poll timestamp.
- Supervisor ownership is exclusive per active runner instance; concurrent stop calls share one shutdown promise.
- Runner event records share the existing sanitized event journal schema; productive ticks are recorded while idle polls are omitted.
- Focused tests cover inert construction, bounded drains, ownership exclusion, concurrent stop, idle and in-flight shutdown, fail-closed handling, status telemetry, journal events and real queue/worker/supervisor integration.
- The updated candidate requires a fresh full CI run and native integration certification.

## Validation plan

- Unit tests: inert construction, invalid config, explicit start, duplicate start behavior, bounded batch, idle wait scheduling, tick serialization, supervisor ownership, concurrent stop, stop during idle and active drain, threshold-triggered fail-closed state, sanitized event emission and accurate persistence reporting.
- Integration: queued work completes through the actual queue, worker and supervisor when the host runner is started; interrupted jobs remain operator-reviewed and are not replayed.
- Regression: worker, queue, supervisor, runtime, containment and event-journal suites.
- Certification: Core Validation, Security QA, Security Guard multi-runtime, JB Engines Certification, Linux and Windows native labs.

**Block 12.14 remains incomplete until focused tests, full required checks and native/post-merge certification pass on one verified main SHA.**
