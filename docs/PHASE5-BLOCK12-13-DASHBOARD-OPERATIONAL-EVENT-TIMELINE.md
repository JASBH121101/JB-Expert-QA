# Phase 5 — Block 12.13: Dashboard Operational Event Timeline

## Verified architectural gap

Block 12.12 exposes bounded read-only journal inspection through the execution supervisor. The local QA Control Center already displays audit-run history, analytics and the Phase 4 execution-ledger timeline, but it does not connect to the Phase 5 supervisor's operational event journal. Operators therefore need a separate host-side call to inspect worker, supervisor, job lifecycle, native containment and resource-usage events.

## Scope delivered

- Allow the local Dashboard host to receive an explicitly supplied lifecycle supervisor with trusted own `listEvents()` and `getEventJournalStatus()` methods.
- Add `GET /api/phase5/events/status` for journal availability and bounded retention metadata.
- Add `GET /api/phase5/events` for sanitized event pages, with optional filters for event type, job ID, engine ID and execution ID.
- Add an exclusive `beforeSequence` cursor to the operational journal so the dashboard can page backward through retained history without duplicates or gaps.
- Bound dashboard pages to 1–100 records and validate repeated/unknown query parameters, identifier lengths and cursor values.
- Add a responsive Control Center timeline with event-type and identifier filters, refresh and “load older events”.
- Render only text nodes and sanitized journal records; no event value is injected as HTML.

## API contract

- `GET /api/phase5/events/status`
  - Returns `enabled: false` with a clear reason when the host has not connected a supervisor.
  - When connected, returns the journal mode, closed state, retained/dropped counts and first/last sequence.
- `GET /api/phase5/events?limit=50&before=123&eventType=CONTAINMENT_RESOURCE_SNAPSHOT&engineId=...`
  - Returns `events`, `journal` metadata and pagination metadata.
  - A supplied `before` cursor is exclusive.
  - `nextBeforeSequence` is the oldest record in the visible page when older matching records remain.
  - Maximum page size is 100. The journal itself retains its existing maximum query limit and schema validation.

## Security and lifecycle invariants

- The Dashboard accepts only an object with own data-methods `listEvents()` and `getEventJournalStatus()`; inherited methods and accessor properties are rejected.
- The server exposes GET-only read operations. It does not expose enqueue, retry, recovery, cancellation, worker control or execution methods.
- Existing host validation, loopback restrictions, cross-origin controls, no-store response headers, CSP and same-origin asset policy remain in force.
- The event journal remains responsible for identifier, event-type, cursor and schema validation.
- Event records continue to exclude raw payloads, outputs, PIDs, secrets, filesystem paths and free-form error messages.
- Query errors return fixed safe messages; raw journal exceptions are not returned to the browser.
- If no Phase 5 supervisor is supplied, the event timeline is explicitly unavailable. Dashboard startup never creates an autonomous supervisor or silently enables execution.
- No new dependency, remote service, paid API or background polling loop is introduced.

## Validation

- Journal query tests cover exclusive older-page cursors, after/before range intersections and invalid cursors.
- Dashboard HTTP tests cover disabled state, status metadata, filtered results, multiple older pages, no-store headers, repeated/unknown filters and invalid cursors.
- Supervisor integration verifies `beforeSequence` is passed through the Block 12.12 facade.
- Existing Dashboard security, host/origin, Phase 4 execution, event journal, persistent journal and supervisor suites.
- Core Validation, Security QA, Security Guard multi-runtime, JB Engines Certification and Linux/Windows native labs.
- All post-merge workflows must pass against the same `main` SHA.

**Block 12.13 is complete only when the Dashboard timeline, bounded historical pagination, read-only boundary and post-merge certification pass.**
