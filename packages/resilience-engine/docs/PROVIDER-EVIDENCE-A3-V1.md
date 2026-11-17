# JB Resilience — A3 provider evidence verifier v1

**Status:** laboratory-only evidence verifier  
**Capability:** A3 controlled failover  
**Execution:** disabled; this module never acquires leases, fences a source, promotes a target, changes traffic or authorizes failover.

## Purpose

A3 readiness cannot rely on caller-supplied booleans such as `monitorQuorum: true` or `targetEnforcesFencing: true`. This module verifies short-lived Ed25519 attestations from distinct provider roles, all bound to one exact failover context:

- service asset and environment;
- incident and owner-signed policy ID/revision/hash;
- exact source and target IDs;
- lease ID and monotonic fencing epoch;
- service RPO.

The signed scope prevents mixing a monitor observation for one source, a fencing receipt for another target, and replication evidence from a different lease or policy.

## Provider roles

| Role | Facts it may attest |
|---|---|
| `external-monitor` | independent monitor, monitor quorum |
| `coordination-authority` | durable coordination, exclusive unexpired lease, monotonic fencing |
| `source-fencing-provider` | source fenced |
| `target-fencing-verifier` | target enforces fencing, stale epoch rejected |
| `replication-verifier` | replication healthy, replication within RPO |
| `target-readiness-verifier` | target ready, dependencies ready |
| `traffic-provider` | bounded traffic cutover prepared, rollback prepared |
| `failover-verifier` | post-failover verification |
| `budget-authority` | failover budget available |

Each role has an exact fact schema; unknown fields and non-boolean facts are rejected. The traffic provider and failover verifier, source-fencing provider and target-fencing verifier, and coordination authority and failover verifier must have different provider identities.

## Trust and verification

The host owns the authoritative provider-key registry, enrollment, revocation, monotonic key versions, private signing keys, evidence storage and provider credentials. The injected synchronous `resolveTrustedProviderKey(keyId)` must return the current authoritative record. It must not trust an attestation-supplied public key.

The verifier checks Ed25519 signatures, exact provider/key/role binding, policy and failover scope equality, key status/validity, freshness and maximum attestation lifetime. The signed evidence references carry SHA-256 digests.

The bundle verifier returns `executable: false`. It does not create an authorization token, change the Policy Engine's A3 denial, or run any infrastructure operation.

## Evidence-reference verification

The second-stage API `verifyA3EvidenceReferences({ bundle, resolveEvidenceReference, clock, maxReferenceBytes, maxTotalBytes, timeoutMs })` resolves each signed reference through a host-owned authoritative resolver. The resolver receives the exact source/target/lease/fencing scope and an AbortSignal. The verifier enforces bounded per-reference timeout, object and aggregate byte limits, exact provider/role/scope binding, and SHA-256 equality. It rechecks bundle expiry after asynchronous resolution.

A valid digest proves that the fetched bytes match the signed digest; it does not prove the bytes semantically establish a provider claim. The host must parse and validate the evidence against authoritative control-plane APIs and audit records. Raw evidence bytes are not returned by this module.

## What remains outside this module

No independent monitor/quorum service, consensus protocol, cloud/network/endpoint source-fence operation, target writer-fencing enforcement, replication observer, target promotion, traffic cutover, failback/rollback control plane, durable failover budget or production provider adapter is included.

A PostgreSQL lease and fenced target protect only state mutations routed through that same authoritative PostgreSQL primary. They do not fence another database, the old server's disks/processes, Windows SCM/systemd, object stores, or remote APIs. A signed assertion does not substitute for a live test that the actual target rejects stale epochs.

## Required next certification stage

A real host deployment must provide the typed adapters in [A2/A3 execution adapter contracts v1](./CONTINUITY-EXECUTION-ADAPTER-CONTRACTS-V1.md), resolve every evidence reference, and prove the following in an isolated environment:

- quorum remains unambiguous when the source is partitioned or unavailable;
- the source cannot commit writes after fencing;
- the actual target rejects all writes with stale fencing epochs;
- replication remains within the signed service RPO;
- target dependencies and secrets are ready;
- cutover and rollback are bounded, idempotent and reconcilable after timeouts;
- independent verification proves one writer, correct data state and correct traffic destination;
- provider, lease, database, audit, clock and network failures never create split-brain.

Until those tests pass, the runtime policy must continue to deny `switch-route` and `failover`.

## ARC readiness integration

After the bundle and all referenced objects have been verified, the host may call `evaluateA3ProviderReadiness({ bundle, references, clock })`. This function accepts only the exact branded bundle and reference-verification result produced by this module, requires that both refer to the same bundle, rechecks freshness, maps the verified provider facts into the existing read-only A3 continuity gate and always returns `executable: false`. It also treats `targetEnforcesFencing` as satisfied only when the signed evidence says both that the target enforces the epoch and that a stale-epoch write was rejected.

This closes the contract gap between provider evidence and ARC's readiness checklist. It remains a readiness result—not authorization. The host still must inspect evidence semantics, and the policy engine continues to deny `switch-route` and `failover`.
