# Phase 5 — Block 8: Execution Event Journal & Lifecycle Observability

## Scope

Add a bounded in-memory operational journal for the autonomous execution lifecycle. The journal records a typed timeline across the existing queue, worker and supervisor without becoming an execution authority or a second policy/audit ledger.

The Phase 4 execution ledger remains the source for policy-gated execution evidence. Block 8 records operational lifecycle facts only: fixed event type, severity, sequence, timestamp, optional supervisor/worker/job identifiers, attempt number, stage and stable code. It never accepts job payloads, execution input/output, source code, credentials, secrets or free-form error messages.

## Public API

- `createExecutionEventJournal({ maxEvents, now })`
- `recordEvent({ eventType, severity, supervisorId, workerId, jobId, attempt, stage, code })`
- `listEvents({ afterSequence, limit, eventType, jobId })`
- `getEventsForJob(jobId, options)`
- `getEventsByType(eventType, options)`
- `getStatus()`

The default journal is synchronous and in-memory. It maintains monotonically increasing sequence numbers and immutable event snapshots. When the configured rolling window is full, the oldest record is evicted and `droppedEvents` increases; the retained sequence range and eviction count remain visible. There is deliberately no clear/delete API.

Phase 5 Block 12.10 adds the optional `createPersistentExecutionEventJournal({ filePath, maxEvents, now })` adapter. It stores the bounded journal state in the existing hardened local JSON file store, preserving event IDs, timestamps, sequence cursors and eviction counts across restarts. The default `createExecutionEventJournal()` remains memory-only. Both modes expose `close()`; persistent mode must be closed to release its exclusive store lock.

## Integration

- Queue emits job creation, enqueue, claim, terminal, retry and manual-recovery transitions after the queue's state persistence succeeds.
- Worker emits worker lifecycle and execution outcome events.
- Supervisor emits supervisor startup/shutdown and operator recovery/retry events.
- Event emission is best-effort and cannot alter queue transitions, worker execution or orchestrator policy. Each integration exposes an event-emission failure count in its status/stats where applicable.
- Persistent job queue state remains durable, but the Block 8 event journal is not persisted across process restarts. A later durable journal adapter can be designed against the existing append-only execution-ledger contracts without changing execution authority.

## Safety / non-goals

- No automatic replay, retry scheduler, background polling, scheduler, HTTP endpoint or remote worker.
- No queue, worker, runtime or supervisor replacement.
- No policy decision, permission, approval, engine dispatch or ledger write authority.
- No raw payload, output, source code, free-form error or secret storage.
- No new runtime dependency or paid service.
- No modification to the Phase 4 execution evidence ledger.

## Validation

- Unit tests for schema validation, immutable records, deterministic sequencing, filtering, bounded retention and invalid inputs.
- Integration tests for queue, worker, supervisor, recovery and retry event ordering.
- Package root and standalone `@jb/expert-qa/execution-event-journal` import verification from clean built tarballs.
- Core Validation, Security QA, JB Engines Certification and package distribution workflows must pass before merge.
