# Phase 5 — Block 9: Local Process Isolation & Hard Execution Termination

## Verified architectural gap

Blocks 3 and 6 explicitly define execution as in-process and state that process isolation is not yet provided. Block 5 documents that cancellation is cooperative. The current autonomous execution engine's bounded call can report timeout/cancellation without forcibly stopping a non-cooperative in-process handler. Therefore a handler may continue running after the logical action has settled.

## Scope

Add an opt-in local Node child-process runner compatible with the existing engine registry `run(input, { signal })` function contract. Each invocation starts a fresh child process and runs one host-configured adapter module.

The parent process retains the trusted engine registry, orchestrator, policy checks, approval provider, permission enforcement and Phase 4 execution ledger. The adapter is invoked in the child only after the parent orchestrator has completed its existing authorization and approval checks.

## Public API

- `createLocalProcessEngineRunner({ engineId, moduleRoot, modulePath, exportName, cwd, timeoutMs, killGraceMs, maxInputBytes, maxOutputBytes })`
- `runner.run(input, { signal })` — registry-compatible runner function.
- `runner.getStatus()` — read-only active process and lifecycle counters.
- `runner.close()` — stops admission, cooperatively cancels an active child, then force-terminates it after the bounded grace period.

The module path and export name are fixed by trusted host configuration at runner construction. Job inputs cannot select modules, paths, executables, shell commands or environment variables. The module must export a function accepting `(input, { signal })`.

## IPC and process controls

- A fixed internal Node bootstrap is launched with `child_process.fork()`, `shell: false` semantics (no shell is used), `execArgv: []`, a constrained environment allowlist, and a fixed working directory inside the configured module root.
- IPC messages use a versioned exact-key protocol and JSON serialization.
- Input and output are validated as bounded plain JSON before crossing the process boundary.
- The child receives only the engine input and an AbortSignal created inside the child; policy, permissions and approval receipts are not forwarded.
- Abort first sends a cooperative cancellation message. If the child does not exit within `killGraceMs`, the parent sends a forced termination signal.
- A runner instance admits one active child at a time. It does not create a process pool, scheduler, watcher or background polling loop.
- Unexpected exit, invalid protocol, oversized logs/output and bootstrap errors fail closed with stable error codes. Raw child errors and stack traces are not returned to the parent.

## Supervisor integration

The lifecycle supervisor accepts an optional list of trusted process runners. During shutdown it stops the worker, closes the runtime, closes process runners and releases queue persistence last. This ensures child processes are not left alive after host shutdown.

## Security and limitations

This is process fault isolation and hard termination of the direct child process; it is not an OS sandbox or a hostile-code security boundary. The child runs under the same OS user and retains that user's filesystem/network permissions. Process descendants created by an adapter are not guaranteed to be terminated as a process tree. Hosts must continue to use adapter-specific path/origin allowlists, read-only rules, policy scope checks and external approval.

A killed child may have performed an external side effect before termination. Queue recovery and retries remain manual. This block does not provide exactly-once execution.

## Non-goals

- No change to Orchestrator policy or approval authority.
- No auto-retry, replay, scheduler, polling, remote workers, distributed queue or HA.
- No automatic adapter discovery, arbitrary job-selected module loading or shell execution.
- No OS container, VM, seccomp profile, Windows Job Object or cross-user sandbox.
- No new third-party dependency or paid service.
- No changes to durable queue format or Phase 4 evidence-ledger format.

## Validation

- Child success, failure, malformed protocol and output limits.
- Cooperative abort and forced termination of a non-cooperative runner.
- No child process starts before the parent orchestrator has approved the action.
- Supervisor shutdown terminates active child processes before queue storage is closed.
- Package root/subpath import and clean NPM tarball smoke tests.
- Core Validation, Security QA, Security Guard, package distribution, JB Engines Integration and JB Engines Certification must all pass before merge.
