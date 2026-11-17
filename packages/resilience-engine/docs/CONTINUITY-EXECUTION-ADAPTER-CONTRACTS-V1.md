# JB Resilience — A2/A3 execution adapter contracts v1

**Status:** provider-neutral implementation contract; no external provider is bundled  
**Runtime effect:** none. A2 containment and A3 failover remain non-executable.

This document turns the existing A2/A3 readiness requirements into adapter and lifecycle contracts. It does not add a provider, authorization path or infrastructure mutation. A host integration must bind these contracts to its actual control plane and target.

## Shared rules

Every adapter operation must:

- Receive an immutable, exact-scope context: asset, environment, incident, policy ID/revision/hash, capability, profile/target ID, idempotency key and deadline.
- Use server-owned provider credentials and exact configured identifiers. Do not accept arbitrary URLs, shell text, executable paths, firewall rules, route destinations or provider resource IDs from an incident payload.
- Be bounded by a deadline and cancellation signal; return a typed, versioned receipt with a provider identity and operation ID.
- Be idempotent for a caller-supplied operation key, or expose an authoritative reconciliation method before retry.
- Distinguish `succeeded`, `failed`, `unknown` and `not-applied`. A timeout is `unknown`, not `failed` and never permission to retry blindly.
- Emit sanitized audit evidence. Do not log secrets, credentials, raw customer data or unrestricted provider responses.
- Fail closed when the provider, audit ledger, budget ledger, clock, policy revision or evidence source is unavailable.

The host must separately authenticate provider identities and resolve their signing keys/revocation state. A signed statement authenticates its signer and payload integrity; it does not establish that a remote side effect happened.

## A2 — bounded containment

### Required injected roles

1. **Policy authority:** owner-approved exact containment profile and release policy.
2. **Containment provider:** typed, reversible isolation operation.
3. **Independent containment verifier:** different provider identity/account or independent observation path from the executor.
4. **Forensic recorder:** durable evidence preservation and retention receipt.
5. **Budget authority:** atomic reservation and final accounting.

The containment provider and containment verifier must have different identities. A shared cloud account or a single provider's self-reported API result is not independent verification unless the host risk owner explicitly documents the trust boundary and accepts it.

### Typed adapter surface

The host integration must implement equivalents of:

- `preflight({ scope, profileId, deadline, signal })` — resolve the exact asset/profile and prove the target is in the expected environment; verify management, logging and forensic collection paths can remain available.
- `apply({ scope, profileId, idempotencyKey, deadline, signal })` — apply only the pre-approved profile. It must not create a new profile or widen its scope.
- `reconcile({ scope, providerOperationId, idempotencyKey, deadline, signal })` — determine whether an operation that timed out was applied, not applied, or remains unknown.
- `release({ scope, profileId, releaseAuthorization, idempotencyKey, deadline, signal })` — remove containment only with a separate, current release authorization.
- `verify({ scope, profileId, operationReceipt, deadline, signal })` — implemented by the independent verifier, not the containment executor.
- `preserveEvidence({ scope, evidenceRefs, retentionPolicy, deadline, signal })` — implemented through the host forensic system; return immutable evidence IDs and digests.

Every receipt must bind the exact asset, environment, incident, profile, policy revision/hash, provider identity, operation ID, operation time and resulting state. The independent verifier must query authoritative state rather than merely echo the executor's receipt.

### A2 execution lifecycle

`ADMITTED → EVIDENCE_VERIFIED → POLICY_AUTHORIZED → BUDGET_RESERVED → PREFLIGHT_PASSED → CONTAINMENT_REQUESTED → CONTAINMENT_RECONCILED → INDEPENDENTLY_VERIFIED → EVIDENCE_PRESERVED → CONTAINED`

Any uncertain state transitions to `HELD_FOR_RECONCILIATION`; never assume success. If containment is not independently verified, hold and alert. If forensics cannot be preserved as policy requires, do not report successful containment. Releasing isolation is a distinct operation with its own policy gate, idempotency claim, audit record and verification.

### A2 certification tests

- Exact asset/profile binding and wrong-environment denial.
- Invalid/revoked provider key, signature tampering, stale attestation and replay.
- Evidence-reference resolver outage, wrong scope, digest mismatch and size overflow.
- Executor/verifier identity collision.
- Apply timeout followed by reconciliation showing applied, not applied and unknown.
- Partial containment, unavailable management path and unavailable forensic path.
- Rollback/release denied when approval is expired, mismatched or replayed.
- Budget exhaustion, concurrent duplicate incidents, audit/store outage and provider outage.
- Fault injection proving no uncertain result is reported as `CONTAINED`.

**Current boundary:** the package now verifies A2 provider attestations and their referenced byte integrity. It still does not implement these provider operations, semantic evidence checks, release/rollback adapters or A2 authorization. A2 remains blocked.

## A3 — controlled failover

### Required injected roles

1. **Independent monitor/quorum provider:** produces signed observations from configured failure domains and an unambiguous quorum under the service policy.
2. **Coordination provider:** obtains and renews the authoritative exclusive lease and monotonically increasing fencing epoch.
3. **Source-fencing provider:** prevents the former writer from committing writes.
4. **Target-fencing provider:** proves the actual promoted resource rejects every write carrying a stale fencing epoch. This must be enforced at the write destination, not by a preflight `verifyLease()` call.
5. **Replication verifier:** measures source/target position and lag against the service's explicit RPO.
6. **Target-readiness verifier:** checks target capacity, dependencies, credentials and application readiness.
7. **Traffic-control provider:** prepares, cuts over and can reverse a preconfigured route/traffic policy.
8. **Independent failover verifier:** verifies the resulting writer identity, fencing epoch, data consistency and traffic path independently from the cutover executor.
9. **Budget authority:** atomically reserves and accounts for the failover action.

The monitor/quorum must be independent of the failed source. The target-fencing mechanism must be enforced by each stateful resource that can accept writes. A PostgreSQL lease and fenced JSON target protect only state mutations routed through that same PostgreSQL primary; they do not automatically fence systemd, Windows SCM, other databases, object stores or external APIs.

### Typed adapter surface

The host integration must implement equivalents of:

- `observeQuorum({ scope, monitorPolicy, deadline, signal })` — return signed, fresh, source-independent observations with voter identities, failure-domain IDs, observation times and quorum calculation.
- `acquireLease({ scope, holderId, deadline, signal })` — obtain an exclusive lease plus monotonic fencing epoch from durable coordination.
- `fenceSource({ scope, fencingEpoch, idempotencyKey, deadline, signal })` — enforce and independently verify that the prior writer cannot mutate state.
- `verifyTargetFencing({ scope, targetId, fencingEpoch, deadline, signal })` — prove the actual target rejects stale epochs on writes; a test-only database row is not proof for a different resource.
- `measureReplication({ scope, sourceId, targetId, rpoMs, deadline, signal })` — return authoritative source/target positions, measured lag and consistency state.
- `verifyTargetReady({ scope, targetId, dependencies, deadline, signal })` — verify the exact pre-provisioned target and required dependencies.
- `prepareCutover({ scope, targetId, fencingEpoch, deadline, signal })` — validate an exact preconfigured route and rollback plan without switching traffic.
- `cutover({ scope, targetId, fencingEpoch, idempotencyKey, deadline, signal })` — perform only the prepared bounded cutover.
- `reconcileCutover(...)` and `rollbackCutover(...)` — resolve uncertain state and execute only the separately authorized rollback procedure.
- `verifyFailover({ scope, sourceId, targetId, fencingEpoch, deadline, signal })` — independently verify single-writer state, target identity, replication/data consistency and traffic destination.

### A3 execution lifecycle

`ADMITTED → QUORUM_CONFIRMED → LEASE_ACQUIRED → SOURCE_FENCED → TARGET_FENCE_VERIFIED → REPLICATION_WITHIN_RPO → TARGET_READY → CUTOVER_PREPARED → TARGET_PROMOTED → TRAFFIC_CUTOVER → INDEPENDENTLY_VERIFIED → COMPLETED`

The source must be fenced before a new writer is promoted. If fencing cannot be proven, promotion is prohibited. If quorum is split or unknown, stop. If replication lag exceeds RPO or is unknown, stop. If the target cannot enforce the fencing epoch on actual writes, stop. A lease expiry or database outage must not cause a second controller to assume ownership without reconciliation.

Rollback is not a simple inverse command. After a new writer accepts writes, failback requires a separate consistency/replication plan, source re-fencing, a newer fencing epoch and independently verified cutback. If any step is unknown, keep the system in the safest available degraded/read-only state and escalate.

### A3 certification tests

- Quorum ambiguity, monitor compromise, stale monitor votes and loss of independent monitor.
- Competing lease acquisition, lease expiry during each phase and stale fencing epochs.
- Old source attempting writes after fencing; actual target rejecting stale epochs.
- Replication healthy, lag over RPO, replication pause and divergent history.
- Target/dependency readiness failure.
- Traffic provider timeout before, during and after cutover.
- Duplicate request, stale policy, budget exhaustion, audit outage and coordinator/database outage.
- Split-brain fault injection with two competing controllers.
- Rollback after pre-promotion, post-promotion and post-cutover faults.
- Independent post-failover verification and reconciliation of every unknown outcome.

**Current boundary:** PostgreSQL coordination leases and fencing are implemented for the PostgreSQL-managed target only. No independent quorum provider, source fencing across arbitrary resources, replication observer, target promotion provider, traffic controller or complete rollback/failover control plane is bundled. A3 remains blocked.

## Certification rule

The ARC readiness evaluator is a read-only checklist. A complete set of `true` predicates may indicate that a host believes its prerequisites are present; it is not a cryptographic proof, authorization token or execution permission. Only an integrated host implementation that supplies authoritative, scoped evidence and passes provider-specific end-to-end fault-injection tests can request a capability certification. Until then, policy authorization for `apply-containment-profile`, `switch-route` and `failover` must continue to deny.
