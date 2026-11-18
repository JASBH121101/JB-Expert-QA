# JB Resilience — Durable A2 Action Ledger v1

**Implementation:** `createFileA2ActionLedger(...)`  
**Storage model:** one-host transactional JSON ledger  
**Production status:** implementation available; host configuration and operational certification still required  
**Execution default:** A2 remains disabled and policy-denied

## Purpose

The A2 containment controller needs one durable state machine for action claims and restart-recovery records. The claim, pending recovery record, provider-start marker, pending index and terminal completion must not be split across independent stores.

`createFileA2ActionLedger` implements that contract for a single host. It is exported from the package root and from the `@jb/resilience-engine/a2-action-ledger` subpath.

## Construction

The host must provide a private file path and the identities of the three separate A2 components:

```js
import { createFileA2ActionLedger } from "@jb/resilience-engine/a2-action-ledger";

const actionLedger = createFileA2ActionLedger({
  filePath: "/var/lib/jb-resilience/a2-actions.json",
  providerId: "containment-provider",
  verifierId: "independent-verifier",
  recorderId: "forensic-recorder"
});
```

The example path and identifiers are illustrative. The host must choose a protected writable location, configure the actual adapter identities, and keep the write-capable ledger object inside the trusted controller composition. Do not expose `claim`, `createPendingRecord`, `markProviderStarted` or `complete` to untrusted callers.

The default bounds are a 5-second lock wait, 120-second dead-process lock threshold, 25-millisecond lock polling interval, 20,000 lifetime claims and a 16 MiB ledger file. Limits can be lowered or raised within validated bounds. Capacity exhaustion is fail-closed: old idempotency keys are not silently evicted to make room.

## Atomic lifecycle

All state below is persisted in the same file and protected by the same exclusive lock.

1. **Claim:** an atomic unique idempotency claim is created for the deterministic key derived from action, exact scope and profile. A claim that already exists is never recycled. A different active operation for the same asset and environment also blocks a new claim.
2. **Pending record:** the controller persists a complete `claimed` recovery record against the exact claim ID. A missing recovery record is still visible as an orphan pending claim; exact lookup reports it missing so startup reconciliation holds it.
3. **Provider-start marker:** the ledger permits the transition only from an unexpired `claimed` state and only when the supplied `provider-started` record exactly matches the original action, scope, profile, idempotency key and evidence references. Claim and record transition in one locked atomic write.
4. **Reconciliation:** exact action/scope/profile/key lookup returns `claimed`, `provider-started`, `completed`, `not-found` or an error/unknown state. Unknown, corrupt or unavailable state is never converted into permission to retry.
5. **Held state:** a pre-marker held claim stays in `claimed` state so the read-only coordinator will not query the provider. A provider-started hold remains in the pending index as `held-for-reconciliation`.
6. **Terminal state:** `succeeded` can complete only after provider start. `not-applied` before provider start can complete without provider evidence; after provider start it requires a controller-supplied, exact-scope provider non-application observation. Terminal records leave the pending index, but their idempotency tombstones remain to prevent replay.

The pending index uses bounded keyset pagination against a ledger revision snapshot. Each listed claim must still be re-fetched by exact ID; a missing, malformed or mismatched record remains held.

## File integrity and concurrency

The adapter uses:

- exclusive lock-file creation to serialize local processes;
- bounded lock acquisition and conservative dead-process lock recovery;
- private file permissions for lock, temporary and ledger files;
- descriptor-based no-follow opening (with a conservative metadata comparison fallback on platforms without `O_NOFOLLOW`) and rejection of symbolic-link ledger files;
- bounded file size and lifetime claim count;
- write-to-new-temporary-file, file `fsync`, atomic rename and directory sync where supported;
- a revision/SHA-256 `.guard` sidecar that detects a missing journal or guard, same-revision content tampering and rollback to an older journal revision;
- guard bootstrap only for a genuinely empty revision-zero journal; a used journal with a missing guard fails closed;
- strict record, identity, idempotency, timestamp and evidence-reference validation;
- abort-aware lock waiting and bounded host operations through the controller's `AbortSignal`.

A write can still complete after its caller times out if the filesystem operation had already begun. The controller therefore resolves ambiguous writes through exact read-back/reconciliation and holds the operation whenever the stored state cannot be confirmed.

## Deployment boundary

This adapter is **single-host only**. It is not a distributed lock, consensus system, multi-host lease service or safe shared-network-filesystem journal. Do not share the file across hosts, replicas or eventually consistent mounts.

A multi-host deployment can inject the separate `createPostgresA2ActionLedger(...)` adapter exported from `@jb/resilience-engine/adapters/postgres-a2-action-ledger`. It stores claims and recovery records in the same PostgreSQL row, uses transactional conditional transitions, unique idempotency, per-asset advisory-lock serialization, bounded transactions and keyset paging. The real PostgreSQL integration suite exercises it using two independently created Pool instances against a disposable PostgreSQL CI service. This is adapter integration evidence, not production database certification.

The adapter's `durable: true` property describes the implemented local-file mechanism; it does not prove the host's filesystem, disk controller, volume configuration, backup/restore path, process supervisor or disaster-recovery behavior. Back up and restore the journal and its `.guard` sidecar together. A simultaneous rollback of both files to a matching older copy cannot be detected by this local pair alone and requires an independent off-host or monotonic backup/restore control. Those host operations require fault injection and independent certification.

## Required host tests before enabling A2

- restart/reopen the same ledger file between every lifecycle boundary;
- kill a process while it owns the lock and while a temporary write is in progress;
- run concurrent claims from independent processes, not only independent objects in one process;
- exercise full capacity, malformed/truncated JSON, schema tampering, symlink replacement, missing guard, same-revision digest mismatch, stale journal restore, permission denial, disk-full and fsync/rename failure;
- prove that backup restore does not roll back idempotency tombstones or policy revision, including coordinated journal-and-guard rollback;
- verify the real provider's read-only reconciliation behavior, independent verifier path, evidence resolver and forensic retention lookup;
- test provider-specific rollback/fencing, policy revocation and mutation-stop changes.

Passing the package tests proves only the implemented file adapter contract with local test doubles and temporary directories. It does not certify a production host, provider, distributed store, endpoint, firewall, hypervisor or A2 autonomous operation.
