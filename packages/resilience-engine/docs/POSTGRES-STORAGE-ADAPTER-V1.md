# JB Resilience PostgreSQL Storage Adapter v3

**Status:** laboratory implementation pending certification; coordination, fencing and signal-replay primitives added in v3  
**Package:** `@jb/resilience-engine/adapters/postgres-storage`  
**Storage target:** PostgreSQL 16 or compatible  
**Driver:** host-injected node-postgres-compatible Pool; no driver is bundled

## Scope

This adapter provides PostgreSQL-backed transactional stores for the existing v0.6 orchestration contract and its related audit/coordination primitives. A separate `createPostgresA2ActionLedger({ pool, providerId, verifierId, recorderId })` factory in the same module implements the A2 controller's own durable action-journal contract. It is exported from the package root and the `@jb/resilience-engine/adapters/postgres-a2-action-ledger` subpath. The existing adapter factory returns five stores:

- `orchestrationStore`: incident state, service state, circuit-breaker state, idempotency claims and one-time action finalization.
- `auditStore`: append-only, SHA-256 hash-chained audit events.
- `coordinationStore`: per-scope leases with database-clock expiry and monotonic fencing-token issuance.
- `fencedTargetStore`: a PostgreSQL-managed JSON state target that atomically enforces the current lease and durable fencing high-water mark on every state mutation.
- `trustedSignalStore`: a durable, database-unique replay registry shared by processes using the same authoritative PostgreSQL primary.

The adapter does not create connections from environment variables, own credentials, install a database driver, contact a hosted database, or provision infrastructure. The A2 action-ledger factory also requires three distinct configured provider/verifier/recorder identities; these are consistency bindings, not proof of operational independence or trust. The host owns the Pool and passes it in explicitly.

## Initialization

Initialization is explicit and idempotent. The host must call `initialize()` and confirm success before passing either store to an orchestrator. Operations before initialization fail closed.

```js
import pg from "pg";
import {
  createPostgresResilienceStorageAdapter
} from "@jb/resilience-engine/adapters/postgres-storage";

const pool = new pg.Pool({
  connectionString: process.env.JB_RESILIENCE_DATABASE_URL,
  max: 8
});

const storage = createPostgresResilienceStorageAdapter({ pool });
await storage.initialize();

// Inject storage.orchestrationStore and storage.auditStore into
// the host-owned Resilience orchestration configuration.
```

The package only requires a Pool with `connect()`, and connected clients with `query()` and `release()`. The application must manage Pool lifecycle and close it when its process shuts down.

## Transactional A2 action journal

The A2 controller has a distinct ledger contract from the older v0.6 orchestration action API. Do not inject `orchestrationStore` as an A2 `actionLedger`: their identifiers, claims, lifecycle states, policy scope and finalization rules are not interchangeable.

A host can create the A2 journal on the same injected Pool:

```js
import pg from "pg";
import { createPostgresA2ActionLedger } from "@jb/resilience-engine/adapters/postgres-a2-action-ledger";

const pool = new pg.Pool({ connectionString: process.env.JB_RESILIENCE_DATABASE_URL, max: 8 });
const actionLedger = createPostgresA2ActionLedger({
  pool,
  providerId: "host-configured-provider-id",
  verifierId: "host-configured-independent-verifier-id",
  recorderId: "host-configured-forensic-recorder-id"
});
await actionLedger.initialize();

// Inject actionLedger into the A2 controller composition.
// The controller still defaults to disabled and ARC keeps A2 denied.
```

Initialization creates or verifies the namespaced `jb_resilience_a2_action_claims` table, its active-asset unique index and its partial pending-sequence index. It also installs and validates the named terminal-outcome and scope-column integrity constraints on existing tables; invalid existing rows cause initialization to fail closed. The table holds the durable claim, exact six-field policy scope, profile, deterministic idempotency key, lease timestamps, lifecycle state, completion reason and complete recovery record in a single row. The sequence index covers only `claimed`/`provider-started` rows so permanent idempotency tombstones do not make pending scans degrade into full-history scans.

The A2 journal provides:

- **Atomic claim:** a global transaction advisory lock orders A2 identity-sequence allocation through commit so keyset pagination cannot miss a lower sequence that commits late; a second advisory lock serializes contenders for the exact asset/environment pair. A unique idempotency key is retained permanently, and a partial unique index independently prevents a second active claim for that asset/environment.
- **Exact pending record:** `createPendingRecord` binds the full record to an existing unexpired claim, and `getPendingByClaimId` re-fetches the exact durable record.
- **Atomic provider start:** `markProviderStarted` locks the claim row, checks the unexpired claim and full original record, and transitions the claim plus recovery JSON in one transaction.
- **Read-only reconciliation:** `reconcile`, bounded `listPending` keyset pagination and exact lookup expose state without resuming an action. The cursor carries a fixed sequence ceiling and last-seen key; globally ordered claim commits keep that ceiling stable across pages. Held claims stay active; expired claims are not recycled.
- **Fail-closed completion:** success is allowed only after provider start. A post-start `not-applied` completion requires a proof envelope bound to the provider identity, action, exact scope, profile, idempotency key and observation time. Terminal rows preserve idempotency tombstones.

This is a transactional single-primary PostgreSQL implementation, not a multi-region consensus system. Database backups and point-in-time restore must preserve A2 idempotency tombstones; restoring an older snapshot can reopen old idempotency keys and requires an operator-controlled recovery plan before the ledger is trusted again. The host must use least-privilege roles, protect the database endpoint and backups, and independently test failover/restore semantics. The ledger itself does not authenticate policy approval, perform provider operations, validate independent verification, or grant release authority.

## PostgreSQL external monotonic revision anchor

The package also exports `createPostgresA2RevisionAnchor({ pool })` from
`@jb/resilience-engine/adapters/postgres-a2-revision-anchor`. It implements
the file ledger's `revisionAnchor` contract with a separate table,
`public.jb_resilience_a2_revision_anchors`.

- Each opaque `ledgerId` has one state: schema
  `jb.resilience.a2-revision-anchor/v1`, non-negative monotonic revision and
  the SHA-256 digest of the authenticated local journal.
- Initial creation is compare-and-swap from `expected: null` and revision 0.
  Later writes must advance exactly one revision and match the full previous
  schema/revision/digest tuple.
- SQL `UPDATE ... WHERE ledger_id AND state_schema AND revision AND
  ledger_sha256` is the atomic compare-and-swap. A competing or stale writer
  returns `false`; it never silently overwrites the newer anchor.
- The initializer serializes DDL, checks the exact column layout and validates
  the named primary-key and integrity constraints. A malformed/incompatible
  pre-existing table fails closed.
- Pool acquisition and transaction work are bounded with connection,
  statement, lock and idle-transaction timeouts. The late Pool-client path
  releases a client that arrives after the bounded acquisition has expired.

Example composition with a local HMAC-protected file ledger:

```js
import pg from "pg";
import {
  createPostgresA2RevisionAnchor
} from "@jb/resilience-engine/adapters/postgres-a2-revision-anchor";
import {
  createFileA2ActionLedger
} from "@jb/resilience-engine/a2-action-ledger";

const anchorPool = new pg.Pool({
  connectionString: process.env.JB_A2_REVISION_ANCHOR_DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 3_000
});
const revisionAnchor = createPostgresA2RevisionAnchor({ pool: anchorPool });
await revisionAnchor.initialize();

const activeKeyId = process.env.JB_A2_LEDGER_KEY_ID;
const actionLedger = createFileA2ActionLedger({
  filePath: "/var/lib/jb-resilience/a2-actions.json",
  providerId: "host-configured-provider-id",
  verifierId: "host-configured-independent-verifier-id",
  recorderId: "host-configured-forensic-recorder-id",
  integrityKeys: {
    [activeKeyId]: process.env.JB_A2_LEDGER_HMAC_KEY_HEX
  },
  activeIntegrityKeyId: activeKeyId,
  revisionAnchor,
  ledgerId: "host-a2-action-ledger-01"
});

// The controller remains disabled by default and ARC continues to deny A2.
```

**Failure-domain requirement:** the anchor is useful against restoration of an
older local journal/guard pair only while its own high-water mark survives.
The anchor Pool must point to a separately administered PostgreSQL service,
with independently protected credentials, backups, point-in-time recovery,
retention and failover controls. Putting the journal and anchor in the same
PostgreSQL cluster, or restoring both from the same older snapshot, does not
provide independent rollback protection. A second Pool to the same primary is
only a concurrency test, not proof of a separate trust/failure domain.

The CI integration deliberately uses two Pools against one disposable
PostgreSQL 16 primary. It proves transactionally atomic single-primary CAS
(one concurrent writer wins), stale-write rejection, monotonic revision
advance and integration with the local HMAC file ledger. It does **not**
certify split-brain handling, backup/restore independence, regional failover,
or production availability. A production host must separately test those
operational properties before treating the external anchor as a trusted
rollback boundary.

### A2 PostgreSQL execution bounds

`createPostgresA2ActionLedger` applies transaction-local PostgreSQL limits to every operation, including read-only reconciliation and exact lookup:

- `connectionTimeoutMs`: default 3,000 ms; accepted range 100–60,000 ms. This sits below the A2 controller's default per-dependency timeout. If a Pool client arrives after the wait has timed out or been aborted, the late client is immediately released.
- `statementTimeoutMs`: default 4,000 ms; accepted range 100–60,000 ms.
- `lockTimeoutMs`: default 1,500 ms; accepted range 50–30,000 ms.
- `idleInTransactionTimeoutMs`: default 10,000 ms; accepted range 100–120,000 ms.

The transaction limits are set with transaction-local `set_config(..., true)`; they do not modify the Pool's session defaults. Pool acquisition is bounded by the ledger's `connectionTimeoutMs`, while the host should also configure node-postgres `connectionTimeoutMillis` on its Pool as defense in depth. Abort signals are checked during acquisition, before commit and around read-only reconciliation; node-postgres does not expose a universal AbortSignal cancellation contract, so the server-side statement/lock limits remain the authoritative bound once a query has been sent.

A controller-side timeout can still make the caller uncertain about a query already sent to PostgreSQL. The adapter never converts that uncertainty into success or a retry; the controller keeps the action held and resolves it through exact durable lookup/reconciliation.


## Transaction and concurrency guarantees

Each mutating operation is enclosed in an explicit database transaction with rollback on error.

- Incident transitions lock and validate the exact incident row. Asset, environment, service identity, transition legality and monotonic timestamps are checked.
- Action idempotency keys have a database-level unique constraint.
- A service row is locked before checking or creating an action claim. This serializes contenders for the exact `(environment, asset_id)` scope across processes using the same PostgreSQL primary.
- A partial unique index is a second guard against more than one unresolved `claimed` action for an asset/environment.
- An expired unresolved claim is not recycled. It returns `action-reconciliation-required` and remains held until an operator-controlled reconciliation path exists.
- Action finalization is one-time. Service and circuit-breaker updates are persisted transactionally.
- A `cancelled-before-execution` outcome does not increment failure counters or last-action time.
- The audit head row is locked while appending. The record and updated head are committed in the same transaction.
- Audit verification checks contiguous sequence numbers, previous hashes, record hashes, and the stored head. A broken chain blocks further audit appends.

The adapter preserves the current file-store method shapes so it can be introduced behind the existing dependency-injection boundary. The PostgreSQL store is shareable across multiple application processes attached to the same authoritative database primary. The coordination store adds exclusive per-scope leases and monotonically increasing fencing-token issuance, serialized by a PostgreSQL row lock. Database time, rather than a host clock, determines lease expiry. This is a single-primary coordination primitive, not a consensus or quorum implementation.

## Fenced PostgreSQL state targets

`fencedTargetStore.applyState({ scopeId, targetId, holderId, leaseId, fencingToken, mutationId, state })` writes one JSON state object under the current lease. The lease row is locked for the full transaction, lease identity and expiry are checked against PostgreSQL state/database time, the target row is locked, and the target's persisted fencing token is checked before the state is updated. `getState({ scopeId, targetId })` reads the committed state and accepted token.

The target stores a durable high-water mark and mutation receipt. A lower token is rejected; equal tokens are accepted only from the same lease identity; a duplicate mutation ID with the same payload is a no-op, while reusing it with different content is rejected. State payloads are limited to 64 KiB and must be plain JSON objects.

**Guarantee boundary:** this closes the verify-then-write race for application state that is itself stored in this same PostgreSQL primary and modified only through this store. It does not fence `systemd`, Windows SCM, arbitrary files, remote APIs or other external side effects. Do not place network calls or OS commands behind this state API and label them fenced. A real OS fence still requires an enforcing host agent/resource that atomically consumes epochs at the destination.

## PostgreSQL trusted-signal replay store

The returned `trustedSignalStore` implements the existing Trusted Signal Gateway replay-store contract:

- `recordSignal({ signal, signalDigest, receivedAtMs, retentionUntilMs })` validates the normalized envelope and digest, then claims `(source_id,event_id)` using a database unique key. Repeated identical IDs return `signal-replay`; the same source/event ID with a different digest returns `signal-id-conflict`.
- `listSignals({ assetId, environment, sinceMs })` reads records in deterministic issue-time/event-ID order, revalidates the envelope and recomputes its digest before returning it.

This allows multiple gateway processes connected to the same PostgreSQL primary to share the replay registry. The store does not authenticate producer signatures or source scopes; the existing gateway does that before recording. The gateway still emits `authorizationGranted: false`; persisted signals are evidence for policy evaluation, not authority to mutate a host.

Replay rows are not automatically evicted. Deleting an event ID would reopen its replay window; retention and safe archival/expiry require a separate, explicitly designed policy. A singleton capacity row is locked by every admission transaction and enforces `maxTrustedSignals` (default 10,000; permitted range 1–10,000). Every writer instance must initialize with the same configured value. At capacity, ingest fails closed with `replay-store-capacity-exceeded`; it never evicts old replay IDs. This table is not a consensus log and inherits the availability/consistency boundary of one PostgreSQL primary.

## Database objects

Initialization creates only these namespaced tables and indexes:

- `jb_resilience_incidents`
- `jb_resilience_incident_history`
- `jb_resilience_services`
- `jb_resilience_actions`
- `jb_resilience_circuits`
- `jb_resilience_audit_heads`
- `jb_resilience_audit_records`
- `jb_resilience_coordination_leases`
- `jb_resilience_fenced_targets`
- `jb_resilience_fenced_mutations`
- `jb_resilience_trusted_signals`
- `jb_resilience_trusted_signal_capacity`

Use a dedicated database or a role/schema policy that confines the runtime role to these objects. The initializer requires DDL rights. A hardened deployment should separate one-time schema initialization privileges from the runtime role and grant only the minimum table/sequence permissions needed for reads, inserts, updates and audit appends.

## Security and failure behaviour

- The adapter uses parameterized SQL for all variable values.
- No dynamic table names, shell commands, extensions, superuser rights, credentials or keys are accepted or created.
- A database error, unavailable database, failed transaction, invalid record, duplicate claim or broken audit chain is surfaced as an error or a conservative non-claim result; it never bypasses storage to permit recovery.
- Do not configure the database connection with an owner/superuser account for routine runtime use.
- Keep the database endpoint private, enforce TLS where supported, use encrypted backups and protect the runtime credential in the host secret manager.

## Explicit limitations

This v3 remains laboratory-only and does not provide:

- target-enforced consumption of fencing tokens by OS execution adapters, external services or resources outside this PostgreSQL primary;
- leader election, quorum, split-brain resolution or multi-region consensus;
- A2 containment or A3 failover authorization;
- automatic retries of uncertain actions;
- audit archival, retention, partitioning or external immutable checkpoints;
- automatic migration from an existing file ledger;
- production database provisioning or credential management.

A single PostgreSQL primary provides transaction serialization for this adapter, but host execution fencing and failover coordination are separate certification work. Do not interpret `distributedTransactions: true` as proof of A3 readiness.

## Laboratory certification

The CI workflow starts a disposable PostgreSQL 16 service, installs `pg` without modifying the package manifests, and runs the integration suite on Node.js 22 and 24. Tests cover initialization, incident transitions, concurrent idempotency, active/expired claim handling, one-time finalization, circuit-breaker state, cancellation, audit-chain tamper detection, competing lease acquisition, successor epochs, fenced target writes, stale-epoch rejection, mutation idempotency, cross-adapter trusted-signal replay claims and stored-envelope integrity checks.

No production database or Neon credentials are used by this test.


## Coordination API

The returned `coordinationStore` exposes:

- `acquireLease({ scopeId, holderId, leaseDurationMs })` — acquires an available/expired scope and increments its durable fencing token. Durations are restricted to 1,000–300,000 ms. A live lease is never stolen.
- `renewLease({ scopeId, holderId, leaseId, fencingToken, leaseDurationMs })` — renews only the exact current, unexpired lease.
- `releaseLease({ scopeId, holderId, leaseId, fencingToken })` — releases only the exact current, unexpired lease. The last fencing token is retained.
- `verifyLease({ scopeId, holderId, leaseId, fencingToken })` — checks the current lease against PostgreSQL state and database time. This is a point-in-time coordination check, not a lock held across a subsequent external operation.

Every newly acquired lease receives a greater fencing token for its scope, including after expiry or explicit release. Concurrent acquisition is serialized by the scope row lock. Invalid, expired, replaced or unavailable leases fail closed.

**Critical integration rule:** the lease holder must pass its fencing token to the protected target, and that target must enforce a durable monotonic high-water mark atomically with each protected mutation. A preflight call to `verifyLease()` alone cannot close the race between verification and an OS/service action. Because systemd and Windows SCM do not currently enforce this token, this v2 coordination store is not an A3 execution authorization mechanism.
