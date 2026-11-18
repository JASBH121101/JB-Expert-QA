# JB Resilience Engine

Independent, policy-bounded service health and recovery engine for Linux and Windows.

## Target autonomy profile

The selected target profile is **autonomous-advanced**. The runtime descriptor reports `mode: "semi-autonomous"` and `targetMode: "autonomous-advanced"` so integrations can distinguish active behavior from the target design. Its architecture and policy are specified in [ADVANCED-AUTONOMY-ARCHITECTURE.md](./docs/ADVANCED-AUTONOMY-ARCHITECTURE.md). This is a design target, not a runtime capability yet: the current implementation remains `semi-autonomous`, with bounded allowlisted restarts and the existing approval boundary for critical services. Do not configure or advertise advanced autonomy as enabled until the implementation roadmap and certification gates in that specification are complete.

## v0.2 laboratory scope

- Validated, server-owned service allowlist.
- Bounded recovery policy: failure threshold, restart limit and cooldown. The health monitor continues recording observations at its own attempt cap while suppressing further recovery proposals.
- Recovery proposals contain random IDs/nonces and expire after 60 seconds. Expiry is checked after asynchronous approval, before the durable claim, and again immediately before adapter invocation. OS restart and service-verification adapter calls are bounded by `adapterTimeoutMs` (100–60,000 ms) and receive an `AbortSignal`; a timeout or ambiguous adapter exception is recorded as `unverified`, consumes the claimed attempt and is never retried automatically.
- Atomic recovery claims prevent reuse of the same proposal and enforce the policy restart limit across engine instances when a shared durable store is configured.
- Built-in JSON file ledger uses exclusive lock creation, bounded lock waits, dead-process lock recovery, restrictive file modes, write-to-temp + fsync + atomic rename, bounded history, and fail-closed validation. It is a single-host store, not a distributed database.
- A2 containment has a separate `createFileA2ActionLedger()` adapter. Claims and restart-recovery records share one single-host lock-protected JSON journal with atomic provider-start and terminal transitions. Its versioned `.guard` sidecar authenticates the revision and journal digest with HMAC-SHA-256 and supports dual-key rotation. Keys are injected from a host secret store and never persisted beside the journal. The file adapter exposes an optional revisionAnchor/ledgerId contract to compare the local revision and digest against an independently administered monotonic store; this repository does not provide that production anchor service. Without it, replay of a previously valid journal/guard pair remains possible. Missing keys, MAC mismatches, anchor mismatches and state divergence fail closed. The adapter is laboratory-only and not a multi-host database.
- Multi-host A2 hosts can inject `createPostgresA2ActionLedger()` from the PostgreSQL storage adapter. It persists claims and recovery records in one transactional PostgreSQL row, with cross-instance idempotency, per-asset serialization, bounded transactions and stable pending pagination. The real PostgreSQL CI E2E exercises this adapter; the existing v0.6 `orchestrationStore` remains a different contract.
- `createA2RecoveryCoordinator()` provides explicit read-only restart reconciliation: it observes provider state, re-hashes evidence, checks independent verification and existing forensic retention, and emits non-executable findings. It never retries, applies or releases. There is no automatic startup worker and no reconstructed release handle.
- Both ledgers and the read-only coordinator are laboratory capabilities. ARC continues to deny A2 until production providers, database operations, independent verification, forensic retention, rollback and end-to-end fault-injection are separately certified.
- A memory-only ledger remains available for tests and development. Production configurations should set \`requireDurableStore: true\` and inject \`createFileRecoveryStore(...)\` or a host-provided transactional store.
- Automatic execution is limited to explicitly allowlisted, non-critical services.
- Critical services require an injected human-approval verifier. The host verifier must validate a signed approval bound to the exact proposal ID, nonce, service, action, issue/expiry times and authorized human subject; it must also enforce durable one-time replay protection.
- Linux systemd and Windows Service Control Manager adapters use fixed executables, fixed argument shapes, shell disabled, and caller-injected command runners. Windows recovery waits for SCM \`STOPPED\` before issuing \`start\`, then confirms \`RUNNING\` with a bounded timeout.
- Built-in adapters expose `verifyService()`; the engine can also run a host-owned application health check. Set `requireHealthVerification: true` to refuse configurations without at least one verifier. Adapter timeouts, thrown errors and malformed health responses remain `unverified`; only an explicit unhealthy result is recorded as `verification-failed`.
- Execution and recovery outcome are reported separately: a restart command may execute successfully while the service remains unhealthy. An adapter timeout means the OS operation may have started but was not confirmed; the durable attempt remains consumed for reconciliation instead of risking a duplicate restart.
- A host-provided active Security Guard/Malware Engine threat or tamper signal suspends recovery. Resilience never overwrites binaries or attempts file repair.

## Durable recovery ledger

\`\`\`js
import {
  createResilienceEngine,
  createFileRecoveryStore
} from "@jb/resilience-engine";

const recoveryStore = createFileRecoveryStore({
  filePath: "/var/lib/jb-resilience/recovery-ledger.json"
});

const engine = createResilienceEngine({
  policy,
  adapter,
  recoveryStore,
  requireDurableStore: true,
  requireHealthVerification: true,
  // approvalVerifier: verifySignedOneTimeApproval,
  // healthCheck: async ({ proposal }) => checkApplicationHealth(proposal.serviceId)
});
\`\`\`

The file store serializes local operations across processes on the same host. It protects each claim with an atomic lock and increments the per-service attempt counter before invoking the OS adapter. Thus a process crash after the claim does not silently permit a repeated attempt. A claimed attempt that cannot be conclusively finalized is deliberately left consumed for operator review. Store lock timeout, malformed ledger, exhausted capacity, and failed storage writes block recovery rather than bypassing the ledger.

The file ledger is not a cross-host consensus system. For multi-host orchestration, inject a database-backed store whose claim operation uses a transaction/unique constraint or compare-and-swap. Keep the durable ledger on a protected local volume and back it up under the host's operational policy. It contains operational metadata, not approval signatures or application secrets.

## Usage boundary

The host application provides health observations and a command runner with appropriate OS permissions. Adapters do not spawn processes themselves. The caller must authenticate and audit human approvals. A boolean supplied by an untrusted client is not an approval mechanism; use \`approvalVerifier\` to validate a signed, one-time, actor-bound record covering the exact proposal ID, nonce, service ID, action and expiry. The host verifier remains responsible for signature validation, actor authorization and replay protection across process restarts.

The health monitor's observation counters are still in-memory by default, but `restoreState()` lets the host hydrate the monitor before its first observation. Use `await recoveryStore.getServiceState(serviceId)` and pass its `attemptCount` and `lastAttemptAt` as `restartCount` and `lastRestartAt`. The durable ledger independently enforces the actual number of claimed recovery attempts across engine restarts. Hosts that need to restore failure trends should persist those observations in their monitoring system.


## Transactional PostgreSQL storage adapter (v3 laboratory)

The optional `./adapters/postgres-storage` entry point provides the v0.6 orchestration store, hash-chained audit store, PostgreSQL lease coordinator, fenced PostgreSQL state target, and durable trusted-signal replay store. The host injects a node-postgres-compatible Pool and explicitly calls `initialize()`; no driver, credential, network endpoint or hosted database is bundled.

`fencedTargetStore.applyState(...)` serializes application-state mutations against the authoritative lease row and target fencing high-water mark in one PostgreSQL transaction. It rejects expired/stale lease epochs, owner mismatches and conflicting mutation IDs. Its guarantee applies only to state stored through this PostgreSQL target; it does not fence systemd, Windows SCM, files or external APIs.

`trustedSignalStore.recordSignal(...)` and `listSignals(...)` back the existing Trusted Signal Gateway with a shared PostgreSQL replay registry. The database enforces uniqueness of `(sourceId,eventId)` across processes using the same primary. Signal-envelope validation and signature/source-scope verification remain the gateway's responsibility; the store recomputes and checks the envelope digest when reading. It does not grant action authorization, and the gateway continues to return `authorizationGranted: false`. Replay admission is bounded by a persistent database capacity row (`maxTrustedSignals`, default 10,000, maximum 10,000); all instances must use the same value. At capacity, the gateway fails closed and no old replay IDs are silently removed.

Neither this store nor the single PostgreSQL primary provides quorum, consensus, an independent external monitor, OS-level fencing or A3 failover. A2 containment and A3 failover remain disabled until their separate enforcement, policy and lab certification gates pass. See [PostgreSQL Storage Adapter v3](./docs/POSTGRES-STORAGE-ADAPTER-V1.md).

## Bounded Health Monitor Probe Adapter (v1 laboratory)

The optional `./adapters/health-monitor-probes` entry point converts host-configured, read-only HTTP(S), TCP and custom checks into observations for the existing Health Monitor. It uses exact origin and host/port allowlists, GET/HEAD only, manual redirects, loopback-only cleartext HTTP, bounded timeouts and a global concurrency limit across services. Required probe failures mark a service unhealthy; optional probe failures remain advisory. The adapter never executes recovery or operating-system actions. The host owns scheduling and security-state input. See [Health Monitor Probe Adapter v1](./docs/HEALTH-MONITOR-PROBES-V1.md).


## Restricted Host Command Runner (v1 laboratory)

The optional `./adapters/restricted-host-command-runner` entry point supplies a constrained `execFile` runner for the existing systemd and Windows SCM adapters. It uses fixed absolute executable paths, exact service allowlists, a fixed verb/argument grammar, `shell: false`, minimal child-process environment, timeouts and bounded output. It cannot execute arbitrary shell commands, elevate privileges, install services or expand the policy engine's authority. The runner must be injected into the existing typed adapter and executes with the host process identity. See [Restricted Host Command Runner v1](./docs/RESTRICTED-HOST-COMMAND-RUNNER-V1.md).

## Signed A2 Provider Evidence (v1 laboratory)

The optional `./provider-evidence` entry point verifies short-lived Ed25519 attestations for the owner-approved containment profile, reversible provider adapter and rollback plan, independent containment verification, forensic preservation and budget availability. Each attestation is bound to the exact asset, environment, incident and signed policy revision/hash. Five separately scoped provider roles are required, and the containment verifier must be a different provider identity from the containment executor.

The host owns provider enrollment, authoritative key/revocation records and evidence retrieval. A valid signature proves which enrolled key signed the statement; it does not prove that an external action actually occurred. The host must fetch and validate referenced evidence against authoritative provider APIs. This package performs no containment, traffic change, OS command or authorization. A2 remains disabled until a concrete typed provider adapter, independently verified provider state, rollback testing, durable host policy and end-to-end fault-injection certification are complete. See [A2 Provider Evidence v1](./docs/PROVIDER-EVIDENCE-V1.md).


## Signed A3 Provider Evidence (v1 laboratory)

The optional `./provider-evidence-a3` entry point verifies nine Ed25519 provider roles for one exact failover source, target, lease, fencing epoch, policy revision/hash and RPO. It checks independent identities for traffic execution versus failover verification, source fencing versus target fencing verification, and coordination versus failover verification. Its second-stage evidence resolver checks scope and SHA-256 with bounded timeouts and size limits.

These are signed evidence contracts, not a failover controller. They do not supply quorum, source-fence operations, target-enforced fencing, replication, target promotion, traffic cutover or rollback. A3 remains denied by the policy engine. See [A3 Provider Evidence v1](./docs/PROVIDER-EVIDENCE-A3-V1.md).

### A2 provider evidence to ARC readiness

The read-only `evaluateA2ProviderReadiness({ bundle, references, securityState, clock })` function combines the verified A2 provider bundle and byte-integrity result with an exact Trusted Signal Gateway result. It rejects copied/fabricated Gateway outputs, non-durable replay stores, missing evidence, non-confirmed states and stale signals. It maps only authenticated Gateway provenance and signed provider facts into the existing A2 readiness gate. Its result always has `executable: false` and does not grant containment authorization.


### A2 provider-neutral containment controller (laboratory)

The opt-in `./containment-controller` entry point defines a generic A2 apply/reconcile/independent-verify/forensics/release lifecycle. It requires an exact branded A2 readiness result, an injected host policy authority, distinct provider/verifier/recorder identities, durable host action/budget/audit stores, mutation control and a typed provider implementation. The controller defaults to disabled and does not ship a firewall, cloud, endpoint or hypervisor adapter. The existing Policy Engine continues to deny A2 actions; this controller does not change that decision or grant authorization. The process-local success handle is not reconstructed after restart. The separate `./a2-recovery-coordinator` is read-only and must be explicitly invoked; it does not create a release handle or automatically resume work. Passing the controller, file-ledger and PostgreSQL E2E suites validates laboratory contracts, not production provider readiness. See [A2 Containment Controller v1](./docs/A2-CONTAINMENT-CONTROLLER-V1.md) and [A2 Restart Reconciliation v1](./docs/A2-RESTART-RECONCILIATION-V1.md).


## Not included

Cross-host failover, database restore, infrastructure provisioning, autonomous firewall changes, AI-driven shell commands, telemetry upload, and production service installation are out of scope. A fully unavailable host cannot recover itself; cross-host failover requires an independent external monitor and a separately provisioned healthy destination.


## v0.3 policy and capability control

The v2 policy engine is available as `@jb/resilience-engine/policy-engine`. It validates the complete `jb.resilience.policy/v2` contract, computes and verifies a canonical SHA-256 policy hash, and delegates cryptographic signature verification to an injected host-owned verifier. No signing key, trust root or permissive verifier is bundled.

Production use requires two host-provided durable transactional components:

- `policyRevisionStore.assertCurrent({ policyId, revision, policyHash })` confirms the exact owner-activated revision/hash. The host's policy activation path must atomically advance revisions and reject rollback or equal-revision hash substitution; the runtime only reads this state and cannot activate its own policy.
- `capabilityLedger.reserveAction(...)`, `assertReservation(...)` and `completeAction(...)` atomically enforce incident concurrency and per-incident/per-asset budgets.

The policy gate uses exact service IDs, exact environments and explicit action capabilities. Unknown actions, wildcard grants, unsafe policy defaults, invalid signatures, stale policies, unknown security state and unavailable stores fail closed. The policy object is defensively copied, deeply frozen and re-verified before authorization and immediately before a caller uses its short-lived in-process authorization.

The included `createMemoryPolicyRevisionStore()` and `createMemoryCapabilityLedger()` are test/development fixtures only. They have `durable: false` and are rejected unless `allowInMemoryStores: true` is explicitly set. They are not suitable for production or multiple processes.

**Runtime boundary:** v2 authorization is a policy-control API, not an operating-system executor. v0.3 certifies only the A1 `restart-service` capability for exact, stateless, standard-criticality assets with application health verification. The Trusted Signal Gateway, replay protection, producer adapters and signed A2 provider-attestation verifier exist as laboratory components. A2 containment remains blocked until authoritative evidence-reference retrieval/semantic validation, a concrete typed containment provider, independent out-of-band verification, tested rollback, durable budget/action authorization and end-to-end fault-injection certification are complete. A3 failover remains blocked until an independent external monitor/quorum, source and target-enforced fencing, replication/RPO validation, a traffic-cutover provider, rollback and post-failover verification are certified. Other declared capabilities are denied until their typed adapters and verification paths are certified. Existing v1 `semi-autonomous` execution remains unchanged; v2 does not silently switch the runtime or deploy any key material.

See [POLICY-V2-CONTROL.md](./docs/POLICY-V2-CONTROL.md) for the schema, injected-store contracts and integration boundary.

## Trusted Signal Gateway (v0.4)

The optional `./trusted-signal-gateway` entry point authenticates signed, time-bounded signals from explicitly registered Security Guard and Malware Engine sources. Producer identity is bound to an exact engine, environment and asset allowlist. HMAC keys are injected by the host; none are bundled.

A durable, atomic replay store is required by default. The in-memory store is available only for tests/development with explicit opt-in. Missing, stale, replayed, tampered, unknown or contradictory signals fail closed. Evidence references are preserved. The gateway never grants authorization and performs no operating-system or containment action.

See [Trusted Signal Gateway v0.4](./docs/TRUSTED-SIGNAL-GATEWAY.md) for the envelope, store contract and aggregation rules.

## Producer adapters and durable signal store (laboratory)

The Security Guard and Malware Engine adapters are available through `./producers/security-guard` and `./producers/malware-engine`. They translate existing source outputs conservatively: Security Guard never emits a confirmed host-compromise verdict, and Malware Engine `no_match` remains `unknown`. `createFileTrustedSignalStore()` supplies a durable single-host replay ledger; it is not a cross-host database. These are integration prerequisites only and do not enable production recovery or OS actions. See [TRUSTED-SIGNAL-INTEGRATION.md](./docs/TRUSTED-SIGNAL-INTEGRATION.md).

## v0.5 Incident Correlation & Decision Engine (laboratory)

The `./incident-correlation-engine` module combines a Trusted Signal Gateway snapshot with bounded host-provided health observations for one exact asset, environment and service. It generates a deterministic incident identifier, deduplicates observations, detects conflicting timestamps/IDs, ranks risk and emits an auditable rule trace. It is read-only: it never authorizes recovery, executes an action or replaces the v2 policy gate. A recovery-related result only recommends a separate A1 policy evaluation.


## v0.6 Response Orchestrator (isolated laboratory)

The v0.6 Response Orchestrator is being developed on the isolated branch
`feature/jb-resilience-engine-v06-orchestrator`. It connects the read-only
v0.5 incident decision to the signed v2 policy gate, durable action lifecycle,
typed adapter execution, post-action verification and audit trail.

The selected target mode is `autonomous-advanced`, but autonomy remains
strictly bounded by owner-signed policy and certified capabilities. In this
laboratory increment, the only executable capability is A1
`restart-service` for an exact allowlisted stateless, standard-criticality
service, with clear trusted security state, durable budgets and both
service-manager and application-level health verification.

A2 containment and A3 failover remain denied by the existing policy gate.
A2 now has a second-stage authoritative evidence-reference integrity check, but
still lacks a concrete containment provider and independently verified execution.
A3 has a single-PostgreSQL-primary lease/fencing primitive, not external quorum
or target-enforced fencing for unrelated resources. Both capabilities remain
non-executable until provider-specific end-to-end certification is complete. No arbitrary shell
commands, self-modifying policy, evidence deletion, binary restoration or
destructive data actions are permitted.

Production activation is not part of this branch. The implementation must pass
the full laboratory, fault-injection, concurrency, regression and platform
certification gates before any merge or operational enablement.

## Identity & Policy Bridge v1 (laboratory)

The optional `./adapters/identity-policy-bridge` entry point verifies owner-signed v2 policy payloads with Ed25519 using an exact trusted-key record resolved by the host. It delegates policy evaluation, authorization, pre-execution assertions and completion to the existing Policy Engine; it does not duplicate that engine, its capability ledger, or PostgreSQL persistence.

The host owns the authoritative trust registry. Its synchronous resolver must return the current durable key status/version for every check and enforce monotonic versions and revocation. The bridge's in-process rollback tracker is defense in depth only; it is not durable across restarts or processes. No trust registry, private key, signing service, production credential or key vault is provisioned by this package. See [Identity & Policy Bridge v1](./docs/IDENTITY-POLICY-BRIDGE-V1.md).

The bridge does not expand the capability matrix: A2 containment and A3 failover remain denied pending their separate certification gates.
