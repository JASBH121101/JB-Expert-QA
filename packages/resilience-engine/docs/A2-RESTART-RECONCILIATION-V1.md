# JB Resilience — A2 Restart Reconciliation v1 (laboratory)

**Status:** read-only recovery coordinator contract  
**Default capability:** observation only  
**Production status:** not certified; this module does not enable A2 execution or release

## Purpose

A process-local A2 containment result is intentionally not reconstructible after restart. A host therefore needs a safe way to inspect durable pending operations without guessing whether an interrupted provider call took effect.

`createA2RecoveryCoordinator` adds a read-only laboratory workflow. It pages a host-owned durable journal, re-fetches each pending record by exact claim ID, queries provider state by the exact idempotency key, re-fetches and hashes each evidence object, independently verifies the resulting state, and checks the existing forensic retention receipt.

The coordinator does not resume an action. It produces findings only.

## Read-only dependency contract

The host must inject:

- **Durable action journal:** the controller's `actionLedger` must be one host-owned durable source of truth (`durable: true`) and implement `createPendingRecord`, `listPending`, and `getPendingByClaimId`, in addition to its claim/marker/reconcile/complete methods. `listPending({ cursor, limit, atMs, signal })` and `getPendingByClaimId({ claimId, atMs, signal })` are read-only. The list response is exactly `{ claimIds, nextCursor }`; exact lookup is exactly `{ found, record }`. Do not split action claims and recovery records across independently committed stores.
- **Containment provider:** `providerId`, `reconciliationReadOnly: true`, `reconcile`, and `reconcileRelease`. Both reconciliation methods must query authoritative provider state and must never submit, retry, reverse, or otherwise mutate a provider operation.
- **Independent verifier:** a verifier identity distinct from the provider, with `verifyContainment` and `verifyRelease`. It must use an observation path independent of the executor.
- **Forensic recorder:** `recorderId` and read-only `lookupRetention`. It must return the previously stored retention receipt; it must not create a new preservation record during this scan.
- **Evidence resolver:** read-only `resolve`, returning the requested reference ID and its actual UTF-8 or binary content. The coordinator calculates SHA-256 locally and compares it with the durable reference.

The host-provided `durable` and `reconciliationReadOnly` markers are integration assertions, not cryptographic proof. The host remains responsible for demonstrating durable storage, provider read-only behavior, verifier independence and evidence-source integrity.

## Durable recovery record

Every journal record must use schema `jb.resilience.a2-recovery-record/v1` and contain exactly:

- `claimId`, `action` (`apply-containment-profile` or `release-containment`)
- exact `scope`: assetId, environment, incidentId, policyId, policyRevision and policyHash
- `profileId`, `providerId`, `verifierId`, `recorderId`
- deterministic `idempotencyKey` bound to action, exact scope and profile
- `state` (`claimed`, `provider-started`, or `held-for-reconciliation`)
- `originalOperationId` (required for release reconciliation)
- dense, unique `evidenceRefs` containing `refId` and lowercase SHA-256
- `createdAtMs`, `updatedAtMs`, and `leaseExpiresAtMs`

The controller first writes a complete `claimed` recovery record after durable resource reservation and before any provider-start marker. The action ledger's `markProviderStarted` operation must atomically transition both its action claim and the corresponding recovery record to `provider-started`; the controller then exact-reads the record and refuses to invoke the provider unless that transition is confirmed. The action ledger's `complete` operation must atomically remove terminal `succeeded`/`not-applied` records from the pending index, while preserving `held-for-reconciliation` records in that index. These operations must share one durable transaction boundary.

The pending index contains claim IDs only. Each ID is re-fetched from the journal before any provider query. A `claimed` record means the provider-start marker was not durably confirmed: the restart coordinator keeps it held and does not query, retry, or release the provider. A record whose identity, schema, state, action key or scope does not match the configured adapters is held.

## Reconciliation sequence

1. Read bounded pages from the pending index. Detect malformed pages, duplicate claims, repeated cursors and page-limit exhaustion.
2. Re-fetch one exact pending record by claim ID. Never trust scope or provider identifiers supplied only by the page index.
3. Query provider state using the exact action, scope, profile and deterministic idempotency key. Release reconciliation also binds the original containment operation ID.
4. Accept only a typed provider receipt matching provider identity, operation identity, action, profile, idempotency key, exact scope, expected state and bounded timestamp.
5. Resolve every evidence reference again. Hash the returned bytes locally and compare the exact SHA-256 digest. A missing, stale, mismatched or malformed reference holds the record.
6. Obtain fresh independent state verification bound to the exact operation ID and evidence-reference digest.
7. Look up the existing forensic retention receipt and validate its recorder identity, scope, operation ID, evidence digest, retention identifiers and validity window.
8. Emit a read-only finding. Never mutate the journal, budget, policy authorization, provider, containment state or release state.

A lease expiry is metadata for host recovery coordination; it is not permission to retry. Provider `not-applied` is reported as an observation that still requires a separately authorized decision. Unknown, conflicting, malformed, unavailable or expired evidence remains held.

## Output and authority boundary

Every report and finding has:

- `executable: false`
- `safeToRetry: false`
- `releaseAllowed: false`

A `contained-observed-and-verified` finding means only that the provider state, evidence references, independent verifier and forensic retention were observed as consistent during this scan. A `released-observed-and-verified` finding has the equivalent observation meaning for a release operation. Neither finding is a controller-issued containment handle, policy approval, or permission to perform another operation.

The coordinator intentionally has no policy-authority, `apply`, `release`, journal claim, journal completion, budget settlement, audit mutation, or automatic retry dependency. Any subsequent state change must be a separate workflow with fresh owner-approved policy authorization, current mutation-stop checks, exact-scope binding, independent verification, durable idempotency and a separately certified release path.

## Integration gap that remains open

The A2 controller requires one durable action ledger to own claims, pending records, provider-start transitions, bounded read-only paging and exact record lookup. The package provides two implementations of that contract:

- `createFileA2ActionLedger`: a single-host file journal using an exclusive lock, bounded waits, validated state, atomic temporary-file replacement and filesystem synchronization. Guard schema v2 authenticates the revision and journal digest using HMAC-SHA-256 with a host-injected, versioned keyring; missing keys and MAC failures deny all ledger operations. Dual-loaded keyrings support explicit rotation. The optional revisionAnchor/ledgerId contract checks the local revision and digest against an independently administered monotonic store and rejects paired local journal/guard replay. This repository implements the adapter boundary and test doubles only; a production anchor service and its failover/restore controls remain host responsibilities. Without an external anchor, HMAC alone cannot detect replay of an older, previously valid local pair. A missing guard on a used journal fails closed; back up and restore the journal and guard together. It is not a distributed database.
- `createPostgresA2ActionLedger`: a multi-instance PostgreSQL journal. Claims, recovery records and provider-start transitions share one row and transaction. It uses unique idempotency constraints, per-asset serialization, bounded transaction timeouts and snapshot keyset pagination. The host must inject a node-postgres-compatible Pool and explicitly call `initialize()`.

The PostgreSQL adapter is exercised by `tests/e2e/resilience-postgres-storage.integration.js` against a real PostgreSQL service in CI, including cross-instance claims, atomic record transitions, bounded pagination, lock/statement timeouts, migration validation, tamper rejection and pre-provider holds. This is database-adapter integration evidence, not production certification of a particular database deployment.

The host must still certify its database roles, network boundary, backups/restores, durability and failover characteristics, provider read-only reconciliation, evidence resolver, verifier independence and forensic retention lookup. The successful containment handle remains process-local; the coordinator is an explicit read-only workflow, not an automatic startup worker, and it does not reconstruct release authority after restart or certify production A2 readiness.

## Lab test coverage

The tests cover successful observational reconciliation, concurrent read-only scans, expired lease non-retry, unknown provider outcomes, evidence digest mismatch, mismatched record identity, release-operation observation, cursor-cycle detection and accessor-backed claim-ID rejection. Controller tests also cover exact pending-record persistence, atomic provider-start read-back, pre-marker restart holds, release-operation binding, duplicate concurrent containment requests, mismatched recovery metadata, and retaining records after finalization failure. The file-ledger suite covers process restart, cross-process claim serialization, atomic writes, pagination, terminal idempotency tombstones, malformed/truncated data, symbolic-link rejection and revision-guard detection of missing journals/guards, rollback, revision divergence and same-revision tampering. The real PostgreSQL E2E suite covers cross-instance concurrency, durable lifecycle transitions, keyset pagination, bounded timeouts, schema migration and tamper rejection.

Passing these tests validates the tested code paths and lab database adapter. It does not certify a production provider, production database topology, endpoint, firewall, hypervisor, backup/restore process, operational response process or A2 production readiness.
