# JB Resilience PostgreSQL Storage Adapter v2

**Status:** laboratory implementation pending certification; coordination primitives added in v2  
**Package:** \`@jb/resilience-engine/adapters/postgres-storage\`  
**Storage target:** PostgreSQL 16 or compatible  
**Driver:** host-injected node-postgres-compatible Pool; no driver is bundled

## Scope

This adapter replaces the single-host JSON-file orchestration ledger with a PostgreSQL-backed transactional implementation of the existing v0.6 orchestration-store contract. It returns three stores:

- \`orchestrationStore\`: incident state, service state, circuit-breaker state, idempotency claims and one-time action finalization.
- \`auditStore\`: append-only, SHA-256 hash-chained audit events.

The adapter does not create connections from environment variables, own credentials, install a database driver, contact a hosted database, or provision infrastructure. The host owns the Pool and passes it in explicitly.

## Initialization

Initialization is explicit and idempotent. The host must call \`initialize()\` and confirm success before passing either store to an orchestrator. Operations before initialization fail closed.

\`\`\`js
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
\`\`\`

The package only requires a Pool with \`connect()\`, and connected clients with \`query()\` and \`release()\`. The application must manage Pool lifecycle and close it when its process shuts down.

## Transaction and concurrency guarantees

Each mutating operation is enclosed in an explicit database transaction with rollback on error.

- Incident transitions lock and validate the exact incident row. Asset, environment, service identity, transition legality and monotonic timestamps are checked.
- Action idempotency keys have a database-level unique constraint.
- A service row is locked before checking or creating an action claim. This serializes contenders for the exact \`(environment, asset_id)\` scope across processes using the same PostgreSQL primary.
- A partial unique index is a second guard against more than one unresolved \`claimed\` action for an asset/environment.
- An expired unresolved claim is not recycled. It returns \`action-reconciliation-required\` and remains held until an operator-controlled reconciliation path exists.
- Action finalization is one-time. Service and circuit-breaker updates are persisted transactionally.
- A \`cancelled-before-execution\` outcome does not increment failure counters or last-action time.
- The audit head row is locked while appending. The record and updated head are committed in the same transaction.
- Audit verification checks contiguous sequence numbers, previous hashes, record hashes, and the stored head. A broken chain blocks further audit appends.

The adapter preserves the current file-store method shapes so it can be introduced behind the existing dependency-injection boundary. The PostgreSQL store is shareable across multiple application processes attached to the same authoritative database primary. The coordination store adds exclusive per-scope leases and monotonically increasing fencing-token issuance, serialized by a PostgreSQL row lock. Database time, rather than a host clock, determines lease expiry. This is a single-primary coordination primitive, not a consensus or quorum implementation.

## Database objects

Initialization creates only these namespaced tables and indexes:

- \`jb_resilience_incidents\`
- \`jb_resilience_incident_history\`
- \`jb_resilience_services\`
- \`jb_resilience_actions\`
- \`jb_resilience_circuits\`
- \`jb_resilience_audit_heads\`
- \`jb_resilience_audit_records\`

Use a dedicated database or a role/schema policy that confines the runtime role to these objects. The initializer requires DDL rights. A hardened deployment should separate one-time schema initialization privileges from the runtime role and grant only the minimum table/sequence permissions needed for reads, inserts, updates and audit appends.

## Security and failure behaviour

- The adapter uses parameterized SQL for all variable values.
- No dynamic table names, shell commands, extensions, superuser rights, credentials or keys are accepted or created.
- A database error, unavailable database, failed transaction, invalid record, duplicate claim or broken audit chain is surfaced as an error or a conservative non-claim result; it never bypasses storage to permit recovery.
- Do not configure the database connection with an owner/superuser account for routine runtime use.
- Keep the database endpoint private, enforce TLS where supported, use encrypted backups and protect the runtime credential in the host secret manager.

## Explicit limitations

This v1 is not production-certified and does not provide:

- target-enforced consumption of fencing tokens by OS execution adapters or application resources;
- leader election, quorum, split-brain resolution or multi-region consensus;
- A2 containment or A3 failover authorization;
- automatic retries of uncertain actions;
- audit archival, retention, partitioning or external immutable checkpoints;
- automatic migration from an existing file ledger;
- production database provisioning or credential management.

A single PostgreSQL primary provides transaction serialization for this adapter, but host execution fencing and failover coordination are separate certification work. Do not interpret \`distributedTransactions: true\` as proof of A3 readiness.

## Laboratory certification

The CI workflow starts a disposable PostgreSQL 16 service, installs \`pg\` without modifying the package manifests, and runs the integration suite on Node.js 22 and 24. Tests cover initialization, incident transitions, concurrent idempotency, active/expired claim handling, one-time finalization, circuit-breaker state, cancellation and audit-chain tamper detection.

No production database or Neon credentials are used by this test.


## Coordination API

The returned \`coordinationStore\` exposes:

- \`acquireLease({ scopeId, holderId, leaseDurationMs })\` — acquires an available/expired scope and increments its durable fencing token. Durations are restricted to 1,000–300,000 ms. A live lease is never stolen.
- \`renewLease({ scopeId, holderId, leaseId, fencingToken, leaseDurationMs })\` — renews only the exact current, unexpired lease.
- \`releaseLease({ scopeId, holderId, leaseId, fencingToken })\` — releases only the exact current, unexpired lease. The last fencing token is retained.
- \`verifyLease({ scopeId, holderId, leaseId, fencingToken })\` — checks the current lease against PostgreSQL state and database time. This is a point-in-time coordination check, not a lock held across a subsequent external operation.

Every newly acquired lease receives a greater fencing token for its scope, including after expiry or explicit release. Concurrent acquisition is serialized by the scope row lock. Invalid, expired, replaced or unavailable leases fail closed.

**Critical integration rule:** the lease holder must pass its fencing token to the protected target, and that target must enforce a durable monotonic high-water mark atomically with each protected mutation. A preflight call to \`verifyLease()\` alone cannot close the race between verification and an OS/service action. Because systemd and Windows SCM do not currently enforce this token, this v2 coordination store is not an A3 execution authorization mechanism.
