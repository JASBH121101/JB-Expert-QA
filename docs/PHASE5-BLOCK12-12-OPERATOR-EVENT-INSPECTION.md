# Phase 5 — Block 12.12: Operator Event Inspection Facade

## Verified architectural gap

Block 7 made the lifecycle supervisor the host-facing operational facade for queue inspection and manual recovery. Blocks 8–12 added an operational event journal with bounded filtering, native containment events, sanitized resource snapshots and durable restart recovery. The journal already supports read-only queries by job, execution, engine and event type, but hosts had to retain and call the journal object separately. The supervisor did not expose those inspection capabilities alongside its job inspection/recovery methods.

## Scope delivered

Add read-only optional event inspection methods to the lifecycle supervisor:

- `listEvents(query?)`
- `getEventsForJob(jobId, query?)`
- `getEventsForExecution(executionId, query?)`
- `getEventsForEngine(engineId, query?)`
- `getEventsByType(eventType, query?)`
- `getEventJournalStatus()`

Each method delegates to the corresponding trusted own method on the configured event journal. The journal remains the authority for accepted filters, cursor rules, retention limits and schema validation. The supervisor does not copy, rewrite, enrich or persist returned records.

## Behavior and compatibility

- Event inspection is available while the supervisor is idle or running.
- All inspection methods reject access once supervisor shutdown begins, matching the existing job inspection/recovery facade.
- A custom journal adapter may implement only `recordEvent()`; it remains valid for event emission. Missing query methods fail closed per operation with `EVENT_JOURNAL_CAPABILITY_UNAVAILABLE`.
- No event journal means inspection capabilities are unavailable.
- The explicit Block 12.11 `closeEventJournal` ownership option remains independent. An owned journal is closed after shutdown; an unowned/shared journal remains host-managed.
- Read results retain the journal's existing immutable snapshots and bounded query semantics.

## Security invariants

- This is a read-only operational facade. It cannot enqueue, retry, recover, cancel or execute a job.
- It does not expose the journal's file path, persistence adapter, lock handle, filesystem state or raw store representation.
- Query option validation remains owned by the journal. Unsupported query fields, unsafe cursors and oversized limits are rejected by the existing journal contract.
- Event records remain subject to the fixed event schema, allowlisted identifiers/codes and numeric resource metrics. No payload, PID, source code, credential, secret or free-form error becomes visible.
- The Phase 4 execution ledger and orchestrator remain authoritative for policy-gated execution evidence.
- No automatic recovery, replay, polling, scheduler, HTTP server, remote worker, new dependency or paid service is introduced.

## Validation

- Query the persistent journal through the supervisor by event type, job ID, execution ID and engine ID.
- Validate event-journal status reporting and bounded query options.
- Verify query methods return the same immutable records as the underlying journal.
- Verify optional adapters without query methods remain compatible and fail closed only when an unsupported inspection method is called.
- Verify all inspection methods reject access after supervisor shutdown starts.
- Existing queue, worker, supervisor, event-journal persistence and both native containment suites.
- Core Validation, Security QA, Security Guard multi-runtime, JB Engines Certification and post-merge Linux/Windows labs on the same `main` SHA.

**Block 12.12 is complete only when the supervisor inspection facade, capability fallback behavior and post-merge certification all pass.**
