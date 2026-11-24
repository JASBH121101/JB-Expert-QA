# Phase 5 — Block 12.11: Supervisor-Owned Event Journal Lifecycle

## Verified architectural gap

Block 12.10 added the durable execution event journal and requires callers to close it to release its exclusive single-process file lock. The lifecycle supervisor already owns shutdown of the worker, runtime, contained process runners and queue persistence, but it previously did not own or close the optional event journal. A host could therefore finish supervisor shutdown while leaving the durable journal lock open until separate process-level cleanup.

## Scope delivered

- Add an explicit `closeEventJournal` boolean option to `createExecutionLifecycleSupervisor`.
- Preserve the default as `false`: an event journal remains externally owned/shared unless the caller explicitly opts in.
- When enabled, require a trusted event journal with own synchronous `recordEvent()` and trusted `close()` methods.
- Keep shutdown ordering deterministic: stop worker admission and await active work; close runtime; close native process runners; close queue persistence; write the terminal supervisor lifecycle event; then close the owned event journal.
- If journal close fails, record a sanitized `SHUTDOWN_FAILURE` while the journal remains usable, retry lock release once, and report `SHUTDOWN_FAILED` with the failing stage and safe error code.
- Reject the ownership option when no journal or no trusted close method is supplied.
- Do not make an unowned journal close implicitly.

## Public usage

```js
const journal = createPersistentExecutionEventJournal({
  filePath: "./.jb-expert-qa/execution-events.json"
});

// Pass the same journal to queue, worker and supervisor.
const queue = createExecutionJobQueue({ eventJournal: journal });
const worker = createExecutionWorker({ queue, runtime, eventJournal: journal });
const supervisor = createExecutionLifecycleSupervisor({
  queue,
  worker,
  runtime,
  eventJournal: journal,
  closeEventJournal: true
});

await supervisor.close();
```

Omit `closeEventJournal` or set it to `false` when the journal is shared with another live supervisor or its lifetime is controlled by the host. An owned journal is closed after all components that can emit into it have stopped.

## Security and lifecycle invariants

- No journal close occurs by default; ownership is explicit and opt-in.
- An owned journal is closed only after worker, runtime, process runners and queue cleanup have been attempted.
- `SUPERVISOR_SHUTDOWN_COMPLETED` or `SHUTDOWN_FAILURE` is appended before the journal lock is released.
- The journal's own schema, checksum validation, bounded retention, single-writer lock, restrictive permissions and atomic durability behavior remain unchanged.
- Close errors are represented only by a fixed stage identifier and safe error code; raw filesystem paths and error messages are not exposed.
- Failed close gets one bounded retry to release a potentially held exclusive lock; failure remains visible to the caller.
- Legacy supervisors and externally owned memory/persistent journals retain their previous lifecycle unless ownership is explicitly enabled.
- No dependency, paid service, host-wide privilege or deployment change is introduced.

## Validation

- Persistent journal integrated with queue, worker and supervisor; complete a job and close the supervisor.
- Reopen the durable journal after supervisor shutdown, proving the exclusive lock was released and the shutdown completion event survived restart.
- Verify record attempts after owned close fail with `JOURNAL_CLOSED`.
- Verify unowned journals are not closed by the supervisor.
- Verify ownership is rejected without a trusted `close()` method.
- Verify journal close failure is recorded safely and lock release is retried exactly once.
- Existing supervisor, queue, worker, journal, persistent journal, Linux and Windows containment suites.
- Core Validation, Security QA, Security Guard multi-runtime, JB Engines Certification and both native OS labs.
- All required post-merge workflows must pass on the same `main` SHA.

**Block 12.11 is complete only after explicit ownership behavior, durable restart recovery, bounded shutdown failure handling and post-merge certification pass.**
