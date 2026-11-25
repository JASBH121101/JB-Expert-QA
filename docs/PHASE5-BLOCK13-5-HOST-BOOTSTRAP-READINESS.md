# Phase 5 — Block 13.5: Autonomous Host Bootstrap & Operational Readiness

## Objective

Provide one explicit application-owned entrypoint that validates the runtime environment before starting the already implemented autonomous host, then exposes local liveness, readiness and privacy-safe diagnostics.

This block composes the existing sealed engine registry/orchestrator, durable queue, durable event journal, exclusive storage locks, autonomous runner and service signal lifecycle. It does not replace those components or create a new policy authority.

## Public API

Available from the repository API and the standalone @jb/expert-qa package:

- createAutonomousExecutionHostBootstrap(options) creates an inert bootstrap controller.
- bootstrapAutonomousExecutionHost(options) creates the controller, runs startup and returns it only after startup succeeds.
- AutonomousExecutionHostBootstrapError exposes a stable error code without embedding raw configuration values or exception messages.

Package subpath: @jb/expert-qa/autonomous-execution-host-bootstrap.

Importing the module performs no filesystem writes, starts no worker, installs no signal listeners and does not invoke an engine. Startup is an explicit call. The bootstrap requires enabled: true; there is no implicit opt-in.

## Preflight

await bootstrap.preflight() checks the application-provided trusted orchestrator before creating the host:

1. The storage path is absolute and non-root. A missing leaf directory may be created with owner-only permissions; existing directories are never silently chmodded.
2. The directory is not a symbolic link. On POSIX, its canonical path must match, its owner must match the current service UID and group/other permissions must be absent. A private create/write/fsync/delete probe verifies writability.
3. The engine catalog contains 1–256 unique, correctly namespaced IDs. Discovery calls metadata methods only; it never invokes a runner.
4. The policy snapshot has a valid ID and execution limits, grants qa:engine-execute, and allowlists at least one action belonging to the registered engine catalog. No new permissions or action types are synthesized.
5. The orchestrator's execution ledger verifies successfully.

The report contains named pass/fail checks and stable error codes. It omits the storage path and raw error messages. The caller remains responsible for constructing a trusted, sealed registry and supplying its real policy and external approval integration. Preflight can validate the policy snapshot and permission/allowlist shape; it cannot prove that a production approval provider is available or approve any action.

## Startup sequence

await bootstrap.start() executes this order:

1. Run preflight. A failed check prevents host construction.
2. Construct the existing autonomous host with execution explicitly enabled.
3. Require both durable stores to report persistence enabled.
4. Verify the job-store and event-journal lock files exist, are regular non-link files, and contain the current process PID/host/token. On POSIX, owner and private file permissions are checked too.
5. Verify the host's execution ledger again after opening persistent state.
6. Construct the existing host-service adapter, attach only its configured signals (SIGINT/SIGTERM by default), and explicitly start the runner.

Any failure closes partially created resources, records a sanitized diagnostic and leaves the bootstrap terminal. It never retries indefinitely or installs a service-manager entry.

## Liveness and readiness

The methods are local library probes, not network endpoints:

- getLiveness() is synchronous and reports whether the bootstrap process is in a non-terminal state. It does not perform filesystem or ledger I/O.
- await getReadiness() verifies the service, runtime, supervisor and runner are running; the queue and event journal are persistent; the storage directory remains secure; both lock files are still owned by this process; and the execution ledger remains valid.
- await getStatus() returns the bootstrap state, a bounded host-state summary, preflight report and current liveness/readiness results.

An embedding application may map these methods to its own local health interface. This package does not start an HTTP server or open a network port.

## Diagnostics and sanitized event view

await getDiagnostics() returns a bounded operational snapshot: state, liveness/readiness checks, engine/policy counts, queue-state counts, ledger verification, a stable last error code, up to 50 bootstrap diagnostics and the last 20 sanitized execution events.

The diagnostic sink (onDiagnostic) receives only a timestamp, component, event name and optional stable code. Sink failures are swallowed and cannot change service availability.

Event summaries use an allowlist of sequence, timestamp, event type, severity, code and stage. Raw event messages, job IDs, engine/execution IDs, plan content, file paths, tokens and exception stacks are not copied into these diagnostic views. Normal job-management methods may still return caller-requested job records; applications must apply their own access control before exposing those records.

## Persistence, permissions and locks

The bootstrap relies on the hardened persistent stores already owned by the host:

- execution-jobs.json and execution-events.json use the existing checksummed, atomic persistence implementation.
- Both stores must hold their exclusive lock files for the lifetime of this host.
- POSIX storage directory permissions are checked without silently changing an existing directory. The existing store implementation continues to protect its data and lock files.
- Windows filesystem ACLs are not changed by the host. As of Phase 6 Blocks 6.3–6.4, Windows startup requires an expected LocalService or NetworkService SID and a trusted native token/NTFS verifier. `createWindowsPowerShellStorageSecurityVerifier()` provides the built-in read-only Windows adapter; it checks the live token, directory owner, complete DACL and reparse-point path chain. The bootstrap validates the report fail-closed and does not create a missing Windows state directory. Service identity and the protected state-directory ACL still require operator provisioning; see `docs/PHASE6-BLOCK6-3-WINDOWS-STORAGE-ACL-GATE.md` and `docs/PHASE6-BLOCK6-4-WINDOWS-NATIVE-STORAGE-VERIFIER.md`.

A second process cannot pass startup while another process owns the durable locks. The bootstrap does not remove a live lock or ask for elevated permissions to bypass it.

## Interrupted jobs — operator control only

The bootstrap does not scan for interrupted jobs and does not automatically resume, replay, retry or fail them. They remain quarantined by the existing host queue contract.

An operator-facing application can invoke recoverInterrupted(id) only after reviewing that specific job. failInterrupted(id, reason) and retryFailed(id, options) are likewise explicit calls. Each method records only a sanitized operation code; the bootstrap does not make recovery decisions.

## Example

    import { bootstrapAutonomousExecutionHost } from "@jb/expert-qa";

    const bootstrap = await bootstrapAutonomousExecutionHost({
      orchestrator: trustedApplicationOrchestrator,
      storageDirectory: "/var/lib/jb-expert-qa",
      enabled: true,
      signalSource: process,
      hostOptions: {
        pollIntervalMs: 1000,
        maxJobsPerTick: 2,
        maxConsecutiveErrors: 5
      },
      onDiagnostic: event => logger.info(event)
    });

    const readiness = await bootstrap.getReadiness();
    if (!readiness.ready) {
      throw new Error("JB Expert QA host is not ready");
    }

    // Application-owned API/service code may now enqueue explicitly approved work.

Use await bootstrap.stop() for an application-controlled shutdown. The configured process signals are attached by the host-service adapter and await the same ordered graceful close.

## Validation gate

The Block 13.5 PR must include:

- Unit tests for inert construction, strict option/accessor validation, engine catalog and policy preflight, ledger integrity, storage ownership/permissions/write probe, lock collision, readiness/liveness and idempotent graceful stop.
- A test proving no signal listener is installed and no host lock is acquired before successful preflight.
- A test proving interrupted work remains quarantined until a specific manual recovery call.
- A privacy test proving diagnostics omit job IDs, payloads, paths and raw event messages.
- Standalone package root/subpath smoke tests from a clean npm consumer.
- Core Validation, Security QA, Language QA regression, Security Guard multi-runtime, database integration when path filters apply, NPM distribution, JB Engines Integration Certification and JB Engines Certification on one exact PR head.

A passing CI run certifies the code contracts on that runner/platform. It does not certify a customer's service identity, ACLs, host baseline or production approval process.
