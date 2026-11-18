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
  recorderId: "forensic-recorder",
  // Load this secret from a protected host secret store; never from the ledger directory.
  integrityKeys: { "a2-2026-11": process.env.JB_RESILIENCE_A2_HMAC_KEY_HEX },
  activeIntegrityKeyId: "a2-2026-11",
  ledgerId: "production-a2-actions",
  // Host supplies a separately administered, durable, linearizable anchor.
  revisionAnchor: hostMonotonicRevisionAnchor
});
```

The example path and identifiers are illustrative. integrityKeys is a keyring of 32-4096-byte keys (or lowercase hex encodings); activeIntegrityKeyId selects the key used for new guard writes. Obtain keys from a host-managed secret store or HSM/TPM-backed provider, keep them outside the journal directory, and never commit them. Keep the write-capable ledger object inside the trusted controller composition. Do not expose claim, createPendingRecord, markProviderStarted or complete to untrusted callers.

The default bounds are a 5-second lock wait, 120-second dead-process lock threshold, 25-millisecond lock polling interval, 20,000 lifetime claims and a 16 MiB ledger file. Limits can be lowered or raised within validated bounds. Capacity exhaustion is fail-closed: old idempotency keys are not silently evicted to make room. The optional revisionAnchor and ledgerId must be supplied together when the host requires coordinated journal/guard rollback detection.

## External monotonic revision anchor

For rollback resistance against restoring both local files to an older, previously valid snapshot, the host can inject a separate revisionAnchor adapter and stable ledgerId. The adapter contract is:

- read({ ledgerId }) returns null only before the first anchor commit, or { schema: jb.resilience.a2-revision-anchor/v1, revision, ledgerSha256 }.
- compareAndSwap({ ledgerId, expected, next }) atomically and durably replaces the exact expected state with next; expected is null only during empty-ledger bootstrap. It returns true only when the requested transition is committed.
- The anchor service must provide linearizable compare-and-swap, authenticate its callers, retain monotonic state independently of the ledger directory, and have a backup/restore policy that cannot be rolled back together with the local journal. A second file beside the journal is not an independent anchor.

Every ledger read verifies that anchor revision and digest exactly match the authenticated local journal. A mutation first fsyncs the HMAC guard and journal, then advances the external anchor with compare-and-swap. If that CAS is lost or uncertain, the call fails and every later read holds because local and external state diverge; it never assumes success. A coordinated restoration of an older journal/guard pair is rejected while the external anchor retains the newer revision/digest.

This package implements the adapter boundary and lab test doubles only. It does not provide or host an off-host anchor service. Without revisionAnchor, HMAC still prevents a writer without the key from forging a new guard, but replay of both old local files remains possible. Production A2 must require a host-owned anchor appropriate to the threat model and fault-test its durability, access controls, failover and restore behavior.

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
- a versioned HMAC-SHA-256 `.guard` sidecar (guard schema v2) that authenticates the revision and journal digest with a key ID; MAC comparisons use constant-time comparison and fail closed on missing keys or authentication errors;
- guard bootstrap only for a genuinely empty revision-zero journal; a used journal with a missing guard fails closed;
- strict record, identity, idempotency, timestamp and evidence-reference validation;
- abort-aware lock waiting and bounded host operations through the controller's `AbortSignal`.

A write can still complete after its caller times out if the filesystem operation had already begun. The controller therefore resolves ambiguous writes through exact read-back/reconciliation and holds the operation whenever the stored state cannot be confirmed.

## Deployment boundary

This adapter is **single-host only**. It is not a distributed lock, consensus system, multi-host lease service or safe shared-network-filesystem journal. Do not share the file across hosts, replicas or eventually consistent mounts.

A multi-host deployment can inject the separate `createPostgresA2ActionLedger(...)` adapter exported from `@jb/resilience-engine/adapters/postgres-a2-action-ledger`. It stores claims and recovery records in the same PostgreSQL row, uses transactional conditional transitions, unique idempotency, per-asset advisory-lock serialization, bounded transactions and keyset paging. The real PostgreSQL integration suite exercises it using two independently created Pool instances against a disposable PostgreSQL CI service. This is adapter integration evidence, not production database certification.

The adapter's `durable: true` property describes the implemented local-file mechanism; it does not prove the host's filesystem, disk controller, volume configuration, backup/restore path, process supervisor or disaster-recovery behavior. Back up and restore the journal and its `.guard` sidecar together. A simultaneous rollback of both files to a matching older copy cannot be detected by this local pair alone and requires an independent off-host or monotonic backup/restore control. Those host operations require fault injection and independent certification.

**Cryptographic threat-model boundary:** guard schema v2 authenticates the journal revision and SHA-256 digest with HMAC-SHA-256. A writer who can modify the journal and guard but does not possess an accepted key cannot forge a new valid guard. Key rotation requires the host to dual-load the old and new key IDs, set the new ID as active, verify/re-sign, and only then retire the old key. HMAC alone does not prevent replay of a previously valid journal/guard pair. The optional revisionAnchor contract allows a host to bind the monotonic revision and digest to an independently administered anchor; this repository contains only the adapter contract and a deterministic test double, not a production anchor service. Do not enable A2 against a hostile rollback threat model until a real independent anchor is configured and fault-tested.

## Required host tests before enabling A2

- restart/reopen the same ledger file between every lifecycle boundary;
- kill a process while it owns the lock and while a temporary write is in progress;
- run concurrent claims from independent processes, not only independent objects in one process;
- exercise full capacity, malformed/truncated JSON, schema tampering, symlink replacement, missing guard, same-revision digest mismatch, stale journal restore, permission denial, disk-full and fsync/rename failure;
- prove that backup restore does not roll back idempotency tombstones or policy revision, including coordinated journal-and-guard rollback;
- verify the real provider's read-only reconciliation behavior, independent verifier path, evidence resolver and forensic retention lookup;
- test provider-specific rollback/fencing, policy revocation and mutation-stop changes.

Passing the package tests proves only the implemented file adapter contract with local test doubles and temporary directories. It does not certify a production host, provider, distributed store, endpoint, firewall, hypervisor or A2 autonomous operation.
