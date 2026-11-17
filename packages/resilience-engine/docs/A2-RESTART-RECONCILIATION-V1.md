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

- **Durable journal:** `durable: true`, `listPending({ cursor, limit, atMs, signal })`, and `getPendingByClaimId({ claimId, atMs, signal })`. Both methods must be read-only. The list response is exactly `{ claimIds, nextCursor }`; exact lookup is exactly `{ found, record }`.
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
- `state` (`provider-started` or `held-for-reconciliation`)
- `originalOperationId` (required for release reconciliation)
- dense, unique `evidenceRefs` containing `refId` and lowercase SHA-256
- `createdAtMs`, `updatedAtMs`, and `leaseExpiresAtMs`

The pending index contains claim IDs only. Each ID is re-fetched from the journal before any provider query. A record whose identity, schema, state, action key or scope does not match the configured adapters is held.

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

The existing A2 controller's successful result handle remains process-local. Its current action-ledger contract does not itself expose this complete pending-record schema, paginated read-only index, exact record lookup, evidence resolver or retention lookup contract. A host adapter must implement and certify those interfaces before this coordinator can inspect real interrupted operations. The coordinator is not automatically wired into the existing controller and does not close the production restart-recovery gap by itself.

## Lab test coverage

The tests cover successful observational reconciliation, expired lease non-retry, unknown provider outcomes, evidence digest mismatch, mismatched record identity, release-operation observation, cursor-cycle detection and accessor-backed claim-ID rejection.

Passing these tests certifies only this provider-neutral read-only contract with test doubles. It does not certify a real provider, durable store, endpoint, firewall, hypervisor, production response process or A2 production readiness.
