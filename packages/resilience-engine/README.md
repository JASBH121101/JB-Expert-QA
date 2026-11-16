# JB Resilience Engine

Independent, policy-bounded service health and recovery engine for Linux and Windows.

## Target autonomy profile

The selected target profile is **autonomous-advanced**. Its architecture and policy are specified in [ADVANCED-AUTONOMY-ARCHITECTURE.md](./docs/ADVANCED-AUTONOMY-ARCHITECTURE.md). This is a design target, not a runtime capability yet: the current implementation remains `semi-autonomous`, with bounded allowlisted restarts and the existing approval boundary for critical services. Do not configure or advertise advanced autonomy as enabled until the implementation roadmap and certification gates in that specification are complete.

## v0.2 laboratory scope

- Validated, server-owned service allowlist.
- Bounded recovery policy: failure threshold, restart limit and cooldown. The health monitor continues recording observations at its own attempt cap while suppressing further recovery proposals.
- Recovery proposals contain random IDs/nonces and expire after 60 seconds. Expiry is checked after asynchronous approval, before the durable claim, and again immediately before adapter invocation.
- Atomic recovery claims prevent reuse of the same proposal and enforce the policy restart limit across engine instances when a shared durable store is configured.
- Built-in JSON file ledger uses exclusive lock creation, bounded lock waits, dead-process lock recovery, restrictive file modes, write-to-temp + fsync + atomic rename, bounded history, and fail-closed validation. It is a single-host store, not a distributed database.
- A memory-only ledger remains available for tests and development. Production configurations should set \`requireDurableStore: true\` and inject \`createFileRecoveryStore(...)\` or a host-provided transactional store.
- Automatic execution is limited to explicitly allowlisted, non-critical services.
- Critical services require an injected human-approval verifier. The host verifier must validate a signed approval bound to the exact proposal ID, nonce, service, action, issue/expiry times and authorized human subject; it must also enforce durable one-time replay protection.
- Linux systemd and Windows Service Control Manager adapters use fixed executables, fixed argument shapes, shell disabled, and caller-injected command runners. Windows recovery waits for SCM \`STOPPED\` before issuing \`start\`, then confirms \`RUNNING\` with a bounded timeout.
- Built-in adapters expose \`verifyService()\`; the engine can also run a host-owned application health check. Set \`requireHealthVerification: true\` to refuse configurations without at least one verifier.
- Execution and recovery outcome are reported separately: a restart command may execute successfully while the service remains unhealthy. A failed post-recovery check is recorded as \`verification-failed\`.
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

## Not included

Cross-host failover, database restore, infrastructure provisioning, autonomous firewall changes, AI-driven shell commands, telemetry upload, and production service installation are out of scope. A fully unavailable host cannot recover itself; cross-host failover requires an independent external monitor and a separately provisioned healthy destination.


## v0.3 policy and capability control

The v2 policy engine is available as `@jb/resilience-engine/policy-engine`. It validates the complete `jb.resilience.policy/v2` contract, computes and verifies a canonical SHA-256 policy hash, and delegates cryptographic signature verification to an injected host-owned verifier. No signing key, trust root or permissive verifier is bundled.

Production use requires two host-provided durable transactional components:

- `policyRevisionStore.assertCurrent({ policyId, revision, policyHash })` confirms the exact owner-activated revision/hash. The host's policy activation path must atomically advance revisions and reject rollback or equal-revision hash substitution; the runtime only reads this state and cannot activate its own policy.
- `capabilityLedger.reserveAction(...)`, `assertReservation(...)` and `completeAction(...)` atomically enforce incident concurrency and per-incident/per-asset budgets.

The policy gate uses exact service IDs, exact environments and explicit action capabilities. Unknown actions, wildcard grants, unsafe policy defaults, invalid signatures, stale policies, unknown security state and unavailable stores fail closed. The policy object is defensively copied, deeply frozen and re-verified before authorization and immediately before a caller uses its short-lived in-process authorization.

The included `createMemoryPolicyRevisionStore()` and `createMemoryCapabilityLedger()` are test/development fixtures only. They have `durable: false` and are rejected unless `allowInMemoryStores: true` is explicitly set. They are not suitable for production or multiple processes.

**Runtime boundary:** v2 authorization is a policy-control API, not an operating-system executor. v0.3 certifies only the A1 `restart-service` capability for exact, stateless, standard-criticality assets with application health verification. A2 containment remains blocked until the trusted signal gateway is certified. A3 failover remains blocked until external monitoring, transactional coordination, quorum and fencing are certified. Other declared capabilities are denied until their typed adapters and verification paths are certified. Existing v1 `semi-autonomous` execution remains unchanged; v2 does not silently switch the runtime or deploy any key material.

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

A2 containment and A3 failover remain denied by the existing policy gate until
their independent signal, containment, external monitoring, quorum, fencing
and consistency certification requirements are complete. No arbitrary shell
commands, self-modifying policy, evidence deletion, binary restoration or
destructive data actions are permitted.

Production activation is not part of this branch. The implementation must pass
the full laboratory, fault-injection, concurrency, regression and platform
certification gates before any merge or operational enablement.
