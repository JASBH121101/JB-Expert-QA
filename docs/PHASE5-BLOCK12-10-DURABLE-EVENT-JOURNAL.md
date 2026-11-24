# Phase 5 — Block 12.10: Durable Execution Event Journal

## Verified architectural gap

Phase 5 Block 8 introduced the bounded synchronous event journal used by the job queue, worker, supervisor and native containment runner. The journal originally retained events only in memory; the durable job queue survived process restarts, but the operational timeline did not. Block 12.9 added sanitized native resource snapshots to that same journal, making the loss of evidence across a process restart a concrete gap.

Block 12.10 adds an optional durable local journal adapter while preserving the existing memory-only default and synchronous event contract.

## Public API

```js
import { createPersistentExecutionEventJournal } from "@jb/expert-qa";

const journal = createPersistentExecutionEventJournal({
  filePath: "./.jb-expert-qa/execution-events.json",
  maxEvents: 5000
});

try {
  journal.recordEvent({
    eventType: "JOB_CREATED",
    jobId: "job-123"
  });
} finally {
  journal.close();
}
```

The standalone entry point is `@jb/expert-qa/execution-event-journal-persistence`. The existing `createExecutionEventJournal({ maxEvents, now })` remains memory-only unless a trusted synchronous persistence adapter is supplied internally.

Both modes expose `close()`. Persistent mode must be closed during orderly shutdown to release the exclusive file-store lock.

## Durability and recovery

- Reuses the existing `createJsonFileExecutionJobStore` implementation: SHA-256 integrity envelope, restrictive permissions, exclusive single-process lock, unique same-directory temporary file, file fsync, atomic rename and directory fsync where supported.
- Persists the bounded retained event window, monotonic sequence number and cumulative `droppedEvents` count as one versioned snapshot.
- Retains original event IDs, timestamps, event types, correlation identifiers, severities, stable codes and allowlisted resource metrics across restart.
- Restores immutable events in their original sequence order. The next record continues at the persisted next sequence; a restart does not reset the journal to sequence 1.
- If the configured retention window is reduced on reopen, the oldest retained records are evicted and added to `droppedEvents`; this trim is committed before the journal is made available.
- A corrupt checksum, unsupported state schema, invalid event, sequence gap, unsafe permission or symlink fails closed.
- Only one process may hold a given journal file at a time. A second writer receives the existing `STORE_LOCKED` error. This is local single-process durability, not a distributed or multi-host journal.
- The existing local JSON store has a 32 MiB size limit. The journal also remains bounded by `maxEvents` (1–100000).

## Atomic event append

For each new event, the journal validates the event and creates a candidate bounded state. In persistent mode the candidate is committed to the durable store before the in-memory sequence, event list or eviction count is changed. If the save fails, `recordEvent()` throws `PERSISTENCE_FAILED` and the in-memory journal remains unchanged. Existing queue, worker and supervisor integrations already treat journal writes as best-effort observers: an observer failure is counted and does not authorize or block execution.

Persistence is synchronous by design to preserve the existing synchronous `recordEvent()` contract. Asynchronous persistence adapters are rejected.

## Security invariants

- The journal remains an observer, never a queue, policy, approval, dispatch, retry or execution authority.
- Persisted state accepts only the same fixed event schema as the in-memory journal.
- Raw job payloads, execution inputs/outputs, PIDs, attached PIDs, source code, credentials, secrets, paths, environment values and free-form error messages are not accepted.
- Resource evidence remains limited to the allowlisted non-negative safe-integer metrics introduced in Block 12.9.
- The store retains the existing restrictive filesystem permissions, symlink rejection, checksum verification and single-writer lock behavior.
- A persistence error cannot mutate queue state or cause an execution to be replayed.

## Validation

- Persistent journal append, close, reopen and continued sequence verification.
- Retention eviction and `droppedEvents` accounting across restart, including a smaller retention window on reopen.
- Exclusive writer lock and lock release on close.
- Corrupt checksum and invalid persisted event schema rejection.
- Failed persistence rolls back the in-memory journal append.
- Clean npm tarball imports through both the package root and standalone subpath.
- Full Linux cgroup v2 and Windows Job Object supervisor integration: after native scopes close, restart the journal and verify resource snapshots and lifecycle events remain queryable.
- Core Validation, Security QA, Security Guard multi-runtime, JB Engines Certification, and both native OS labs.
- All six post-merge workflows must pass on the same `main` SHA.

**Block 12.10 is complete only when durable event recovery, integrity boundaries, package exports and post-merge certification all pass.**
