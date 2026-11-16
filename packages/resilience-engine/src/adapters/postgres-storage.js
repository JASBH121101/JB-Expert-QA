import { createHash, randomUUID } from "node:crypto";
import { validateTrustedSignalEnvelope } from "../trusted-signal-gateway.js";

const GENESIS_HASH = "0".repeat(64);
const AUDIT_SCHEMA = "jb.resilience.audit-chain/v1";
const INCIDENT_STATES = new Set([
  "OBSERVING", "DEGRADED", "HELD", "ESCALATED", "PLANNED",
  "AUTHORIZED", "EXECUTING", "VERIFYING", "RECOVERED",
  "FAILED", "FAILED_CLOSED", "RECONCILIATION_REQUIRED"
]);
const ACTION_OUTCOMES = new Set([
  "succeeded", "failed", "unverified", "cancelled-before-execution"
]);
const TRANSITIONS = Object.freeze({
  OBSERVING: new Set(["OBSERVING", "DEGRADED", "HELD", "ESCALATED", "PLANNED", "EXECUTING", "RECONCILIATION_REQUIRED", "FAILED_CLOSED"]),
  DEGRADED: new Set(["DEGRADED", "HELD", "ESCALATED", "PLANNED", "EXECUTING", "FAILED_CLOSED"]),
  HELD: new Set(["HELD", "OBSERVING", "ESCALATED", "RECONCILIATION_REQUIRED", "FAILED_CLOSED"]),
  ESCALATED: new Set(["ESCALATED", "HELD", "FAILED_CLOSED"]),
  PLANNED: new Set(["PLANNED", "AUTHORIZED", "HELD", "RECONCILIATION_REQUIRED", "FAILED_CLOSED"]),
  AUTHORIZED: new Set(["AUTHORIZED", "EXECUTING", "HELD", "RECONCILIATION_REQUIRED", "FAILED_CLOSED"]),
  EXECUTING: new Set(["EXECUTING", "VERIFYING", "HELD", "RECONCILIATION_REQUIRED", "FAILED_CLOSED"]),
  VERIFYING: new Set(["VERIFYING", "RECOVERED", "RECONCILIATION_REQUIRED", "FAILED_CLOSED"]),
  RECONCILIATION_REQUIRED: new Set(["RECONCILIATION_REQUIRED", "RECOVERED", "FAILED_CLOSED", "HELD"]),
  RECOVERED: new Set(["RECOVERED"]),
  FAILED: new Set(["FAILED"]),
  FAILED_CLOSED: new Set(["FAILED_CLOSED"])
});
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(label + " is invalid");
  }
  return value;
}

function assertAssetId(value, label) {
  if (typeof value !== "string" || !ASSET_ID.test(value)) {
    throw new TypeError(label + " is invalid");
  }
  return value;
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(label + " must be a non-negative safe integer");
  }
  return value;
}

function toSafeInteger(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(label + " returned an invalid database integer");
  }
  return number;
}

function cloneJsonData(value, depth = 0, seen = new WeakSet()) {
  if (depth > 12) throw new TypeError("record nesting exceeds the supported depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("record contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("record must contain JSON data only");
  if (seen.has(value)) throw new TypeError("record contains circular data");
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length) {
      throw new TypeError("record arrays must be dense and contain no extra properties");
    }
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError("record arrays must not contain accessors");
      }
      output.push(cloneJsonData(descriptor.value, depth + 1, seen));
    }
    seen.delete(value);
    return output;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("record objects must be plain data records");
  }
  if (Object.getOwnPropertySymbols(value).length) {
    throw new TypeError("record objects must not contain symbol properties");
  }
  const output = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (["__proto__", "prototype", "constructor"].includes(key) ||
        !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("record contains an unsafe or accessor property");
    }
    output[key] = cloneJsonData(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(value[key])
  ).join(",") + "}";
}

function auditRecordHash(record) {
  return createHash("sha256").update(canonicalJson({
    schema: record.schema,
    sequence: record.sequence,
    previousHash: record.previousHash,
    entry: record.entry
  }), "utf8").digest("hex");
}

function normalizeAuditEntry(entry) {
  const safe = cloneJsonData(entry);
  if (safe === null || typeof safe !== "object" || Array.isArray(safe)) {
    throw new TypeError("audit entry must be a plain data record");
  }
  if (Buffer.byteLength(JSON.stringify(safe), "utf8") > 32 * 1024) {
    throw new TypeError("audit entry exceeds the 32 KiB limit");
  }
  return safe;
}

function validateIncidentRecord(record) {
  const safe = cloneJsonData(record);
  const required = [
    "incidentId", "assetId", "environment", "serviceId", "state",
    "decision", "decisionRule", "reasonCode", "at"
  ];
  if (safe === null || typeof safe !== "object" || Array.isArray(safe) ||
      Object.keys(safe).length !== required.length ||
      !required.every((key) => Object.hasOwn(safe, key))) {
    throw new TypeError("incident state record has an invalid shape");
  }
  assertIdentifier(safe.incidentId, "incidentId");
  assertAssetId(safe.assetId, "assetId");
  assertIdentifier(safe.environment, "environment");
  assertIdentifier(safe.serviceId, "serviceId");
  if (!INCIDENT_STATES.has(safe.state) ||
      typeof safe.decision !== "string" || safe.decision.length > 64 ||
      typeof safe.decisionRule !== "string" || safe.decisionRule.length > 128 ||
      typeof safe.reasonCode !== "string" || safe.reasonCode.length > 128) {
    throw new TypeError("incident state fields are invalid");
  }
  assertTimestamp(safe.at, "incident state timestamp");
  return safe;
}

function validateClaimInput(input) {
  const safe = cloneJsonData(input);
  const required = [
    "idempotencyKey", "incidentId", "assetId", "environment",
    "serviceId", "action", "claimedAt", "expiresAt"
  ];
  if (safe === null || typeof safe !== "object" || Array.isArray(safe) ||
      Object.keys(safe).length !== required.length ||
      !required.every((key) => Object.hasOwn(safe, key)) ||
      typeof safe.idempotencyKey !== "string" || !SHA256.test(safe.idempotencyKey)) {
    throw new TypeError("action claim is invalid");
  }
  for (const key of ["incidentId", "environment", "serviceId", "action"]) {
    assertIdentifier(safe[key], key);
  }
  assertAssetId(safe.assetId, "assetId");
  assertTimestamp(safe.claimedAt, "claimedAt");
  assertTimestamp(safe.expiresAt, "expiresAt");
  if (safe.expiresAt <= safe.claimedAt) throw new TypeError("action claim expiry is invalid");
  return safe;
}

function validateOutcomes({ outcome, failureThreshold, cooldownMs }) {
  if (!ACTION_OUTCOMES.has(outcome) ||
      !Number.isSafeInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 10 ||
      !Number.isSafeInteger(cooldownMs) || cooldownMs < 1_000 || cooldownMs > 86_400_000) {
    throw new TypeError("action outcome policy is invalid");
  }
}

async function withTransaction(pool, operation) {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    const result = await operation(client);
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS jb_resilience_incidents (incident_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, environment TEXT NOT NULL, service_id TEXT NOT NULL, state TEXT NOT NULL, decision TEXT NOT NULL, decision_rule TEXT NOT NULL, reason_code TEXT NOT NULL, updated_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS jb_resilience_incident_history (history_id BIGSERIAL PRIMARY KEY, incident_id TEXT NOT NULL, state TEXT NOT NULL, at BIGINT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS jb_resilience_incident_history_incident_idx ON jb_resilience_incident_history (incident_id, history_id)",
  "CREATE TABLE IF NOT EXISTS jb_resilience_services (environment TEXT NOT NULL, asset_id TEXT NOT NULL, last_action_at BIGINT NULL, last_outcome TEXT NOT NULL DEFAULT 'unknown', consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0), PRIMARY KEY (environment, asset_id))",
  "CREATE TABLE IF NOT EXISTS jb_resilience_actions (action_id UUID PRIMARY KEY, idempotency_key CHAR(64) NOT NULL UNIQUE, incident_id TEXT NOT NULL, asset_id TEXT NOT NULL, environment TEXT NOT NULL, service_id TEXT NOT NULL, action TEXT NOT NULL, claimed_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, completed_at BIGINT NULL, status TEXT NOT NULL, outcome TEXT NULL, reason_code TEXT NULL, CHECK (expires_at > claimed_at))",
  "CREATE UNIQUE INDEX IF NOT EXISTS jb_resilience_one_claim_per_asset_idx ON jb_resilience_actions (environment, asset_id) WHERE status = 'claimed'",
  "CREATE TABLE IF NOT EXISTS jb_resilience_circuits (environment TEXT NOT NULL, asset_id TEXT NOT NULL, action TEXT NOT NULL, failure_count INTEGER NOT NULL CHECK (failure_count >= 0), failure_threshold INTEGER NOT NULL CHECK (failure_threshold BETWEEN 1 AND 10), cooldown_ms BIGINT NOT NULL CHECK (cooldown_ms BETWEEN 1000 AND 86400000), retry_at_ms BIGINT NULL, PRIMARY KEY (environment, asset_id, action))",
  "CREATE TABLE IF NOT EXISTS jb_resilience_audit_heads (head_id SMALLINT PRIMARY KEY CHECK (head_id = 1), sequence BIGINT NOT NULL, last_hash CHAR(64) NOT NULL)",
  "CREATE TABLE IF NOT EXISTS jb_resilience_audit_records (sequence BIGINT PRIMARY KEY, record_schema TEXT NOT NULL, previous_hash CHAR(64) NOT NULL, hash CHAR(64) NOT NULL, entry JSONB NOT NULL)",
  "CREATE TABLE IF NOT EXISTS jb_resilience_coordination_leases (scope_id TEXT PRIMARY KEY, fencing_token BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0), holder_id TEXT NULL, lease_id UUID NULL, acquired_at BIGINT NULL, renewed_at BIGINT NULL, expires_at BIGINT NULL, CHECK ((holder_id IS NULL AND lease_id IS NULL AND acquired_at IS NULL AND renewed_at IS NULL AND expires_at IS NULL) OR (holder_id IS NOT NULL AND lease_id IS NOT NULL AND acquired_at IS NOT NULL AND renewed_at IS NOT NULL AND expires_at IS NOT NULL)))",
  "CREATE TABLE IF NOT EXISTS jb_resilience_fenced_targets (scope_id TEXT NOT NULL, target_id TEXT NOT NULL, fencing_token BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0), holder_id TEXT NULL, lease_id UUID NULL, state JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (scope_id, target_id))",
  "CREATE TABLE IF NOT EXISTS jb_resilience_fenced_mutations (scope_id TEXT NOT NULL, target_id TEXT NOT NULL, mutation_id TEXT NOT NULL, payload_hash CHAR(64) NOT NULL, fencing_token BIGINT NOT NULL, applied_at BIGINT NOT NULL, PRIMARY KEY (scope_id, target_id, mutation_id))",
  "CREATE TABLE IF NOT EXISTS jb_resilience_trusted_signals (source_id TEXT NOT NULL, event_id TEXT NOT NULL, asset_id TEXT NOT NULL, environment TEXT NOT NULL, issued_at_ms BIGINT NOT NULL, expires_at_ms BIGINT NOT NULL, signal_digest CHAR(64) NOT NULL CHECK (signal_digest ~ '^[a-f0-9]{64}
];

function ensurePool(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("pool must provide connect(), query(), and clients with query()/release()");
  }
}

function mapIncident(row) {
  if (!row) return null;
  return Object.freeze({
    incidentId: row.incident_id,
    assetId: row.asset_id,
    environment: row.environment,
    serviceId: row.service_id,
    state: row.state,
    decision: row.decision,
    decisionRule: row.decision_rule,
    reasonCode: row.reason_code,
    updatedAt: toSafeInteger(row.updated_at, "incident updated_at")
  });
}

async function verifyAuditWithClient(client, { lockHead = false } = {}) {
  const headQuery = await client.query(
    "SELECT sequence, last_hash FROM jb_resilience_audit_heads WHERE head_id = 1" +
      (lockHead ? " FOR UPDATE" : " FOR SHARE")
  );
  if (headQuery.rowCount !== 1) throw new Error("audit head is missing; audit writes are blocked");
  const head = headQuery.rows[0];
  const rows = await client.query(
    "SELECT sequence, record_schema, previous_hash, hash, entry FROM jb_resilience_audit_records ORDER BY sequence ASC"
  );
  let sequence = 0;
  let previousHash = GENESIS_HASH;
  for (const row of rows.rows) {
    const currentSequence = toSafeInteger(row.sequence, "audit sequence");
    const record = {
      schema: row.record_schema,
      sequence: currentSequence,
      previousHash: row.previous_hash.trim(),
      entry: row.entry
    };
    if (record.schema !== AUDIT_SCHEMA ||
        currentSequence !== sequence + 1 ||
        record.previousHash !== previousHash ||
        typeof row.hash !== "string" || !SHA256.test(row.hash.trim()) ||
        auditRecordHash(record) !== row.hash.trim()) {
      throw new Error("audit log integrity verification failed");
    }
    sequence = currentSequence;
    previousHash = row.hash.trim();
  }
  if (toSafeInteger(head.sequence, "audit head sequence") !== sequence ||
      head.last_hash.trim() !== previousHash) {
    throw new Error("audit head does not match the verified record chain");
  }
  return Object.freeze({ valid: true, sequence, lastHash: previousHash });
}

/**
 * PostgreSQL-backed transactional storage for the JB Resilience v0.6 orchestrator.
 *
 * The injected object must be a node-postgres-compatible Pool. Call initialize()
 * explicitly before use. No driver, connection URL, credentials, schema migration
 * runner or network client is bundled by this package.
 */
export function createPostgresResilienceStorageAdapter({ pool } = {}) {
  ensurePool(pool);
  let initialized = false;

  function assertInitialized() {
    if (!initialized) throw new Error("PostgreSQL resilience storage is not initialized; call initialize() first");
  }

  async function databaseNow(client) {
    const result = await client.query(
      "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms"
    );
    if (result.rowCount !== 1) throw new Error("database clock is unavailable");
    return toSafeInteger(result.rows[0].now_ms, "database clock");
  }

  function validateLeaseDuration(leaseDurationMs) {
    if (!Number.isSafeInteger(leaseDurationMs) ||
        leaseDurationMs < 1_000 || leaseDurationMs > 300_000) {
      throw new TypeError("leaseDurationMs must be between 1000 and 300000 milliseconds");
    }
    return leaseDurationMs;
  }

  function validateLeaseIdentity(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("lease identity is invalid");
    }
    assertIdentifier(input.scopeId, "scopeId");
    assertIdentifier(input.holderId, "holderId");
    if (typeof input.leaseId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.leaseId) ||
        !Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
      throw new TypeError("lease identity or fencing token is invalid");
    }
    return {
      scopeId: input.scopeId,
      holderId: input.holderId,
      leaseId: input.leaseId,
      fencingToken: input.fencingToken
    };
  }

  function mapLease(row) {
    return Object.freeze({
      scopeId: row.scope_id,
      holderId: row.holder_id,
      leaseId: row.lease_id,
      fencingToken: toSafeInteger(row.fencing_token, "fencing_token"),
      acquiredAt: toSafeInteger(row.acquired_at, "lease acquired_at"),
      renewedAt: toSafeInteger(row.renewed_at, "lease renewed_at"),
      expiresAt: toSafeInteger(row.expires_at, "lease expires_at")
    });
  }

  function leaseIdentityMatches(row, identity) {
    return Boolean(row && row.holder_id === identity.holderId &&
      row.lease_id === identity.leaseId &&
      toSafeInteger(row.fencing_token, "fencing_token") === identity.fencingToken);
  }

  async function acquireLease({ scopeId, holderId, leaseDurationMs } = {}) {
    assertInitialized();
    assertIdentifier(scopeId, "scopeId");
    assertIdentifier(holderId, "holderId");
    validateLeaseDuration(leaseDurationMs);

    return withTransaction(pool, async (client) => {
      await client.query(
        "INSERT INTO jb_resilience_coordination_leases (scope_id, fencing_token) VALUES ($1, 0) ON CONFLICT (scope_id) DO NOTHING",
        [scopeId]
      );
      const selected = await client.query(
        "SELECT scope_id, fencing_token, holder_id, lease_id, acquired_at, renewed_at, expires_at FROM jb_resilience_coordination_leases WHERE scope_id=$1 FOR UPDATE",
        [scopeId]
      );
      if (selected.rowCount !== 1) throw new Error("coordination lease row is unavailable");
      const current = selected.rows[0];
      const now = await databaseNow(client);
      if (current.lease_id !== null &&
          toSafeInteger(current.expires_at, "lease expires_at") > now) {
        return Object.freeze({
          acquired: false,
          reason: "lease-held",
          leaseExpiresAt: toSafeInteger(current.expires_at, "lease expires_at")
        });
      }

      const priorToken = toSafeInteger(current.fencing_token, "fencing_token");
      if (priorToken >= Number.MAX_SAFE_INTEGER) {
        throw new Error("fencing token exhausted; coordination is blocked");
      }
      const fencingToken = priorToken + 1;
      const expiresAt = now + leaseDurationMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new Error("lease expiry exceeds the supported timestamp range");
      }
      const leaseId = randomUUID();
      const updated = await client.query(
        "UPDATE jb_resilience_coordination_leases SET fencing_token=$2, holder_id=$3, lease_id=$4, acquired_at=$5, renewed_at=$5, expires_at=$6 WHERE scope_id=$1 RETURNING scope_id, fencing_token, holder_id, lease_id, acquired_at, renewed_at, expires_at",
        [scopeId, fencingToken, holderId, leaseId, now, expiresAt]
      );
      if (updated.rowCount !== 1) throw new Error("coordination lease acquisition did not persist");
      return Object.freeze({ acquired: true, lease: mapLease(updated.rows[0]) });
    });
  }

  async function renewLease({ scopeId, holderId, leaseId, fencingToken, leaseDurationMs } = {}) {
    assertInitialized();
    const identity = validateLeaseIdentity({ scopeId, holderId, leaseId, fencingToken });
    validateLeaseDuration(leaseDurationMs);

    return withTransaction(pool, async (client) => {
      const selected = await client.query(
        "SELECT scope_id, fencing_token, holder_id, lease_id, acquired_at, renewed_at, expires_at FROM jb_resilience_coordination_leases WHERE scope_id=$1 FOR UPDATE",
        [identity.scopeId]
      );
      if (selected.rowCount !== 1) {
        return Object.freeze({ renewed: false, reason: "lease-not-current" });
      }
      const current = selected.rows[0];
      if (!leaseIdentityMatches(current, identity)) {
        return Object.freeze({ renewed: false, reason: "lease-not-current" });
      }
      const now = await databaseNow(client);
      if (toSafeInteger(current.expires_at, "lease expires_at") <= now) {
        return Object.freeze({ renewed: false, reason: "lease-expired" });
      }
      const expiresAt = now + leaseDurationMs;
      if (!Number.isSafeInteger(expiresAt)) throw new Error("lease expiry exceeds the supported timestamp range");
      const updated = await client.query(
        "UPDATE jb_resilience_coordination_leases SET renewed_at=$2, expires_at=$3 WHERE scope_id=$1 AND holder_id=$4 AND lease_id=$5 AND fencing_token=$6 RETURNING scope_id, fencing_token, holder_id, lease_id, acquired_at, renewed_at, expires_at",
        [identity.scopeId, now, expiresAt, identity.holderId, identity.leaseId, identity.fencingToken]
      );
      if (updated.rowCount !== 1) return Object.freeze({ renewed: false, reason: "lease-not-current" });
      return Object.freeze({ renewed: true, lease: mapLease(updated.rows[0]) });
    });
  }

  async function releaseLease(input = {}) {
    assertInitialized();
    const identity = validateLeaseIdentity(input);
    return withTransaction(pool, async (client) => {
      const selected = await client.query(
        "SELECT scope_id, fencing_token, holder_id, lease_id, expires_at FROM jb_resilience_coordination_leases WHERE scope_id=$1 FOR UPDATE",
        [identity.scopeId]
      );
      if (selected.rowCount !== 1 || !leaseIdentityMatches(selected.rows[0], identity)) {
        return Object.freeze({ released: false, reason: "lease-not-current" });
      }
      const now = await databaseNow(client);
      if (toSafeInteger(selected.rows[0].expires_at, "lease expires_at") <= now) {
        return Object.freeze({ released: false, reason: "lease-expired" });
      }
      const updated = await client.query(
        "UPDATE jb_resilience_coordination_leases SET holder_id=NULL, lease_id=NULL, acquired_at=NULL, renewed_at=NULL, expires_at=NULL WHERE scope_id=$1 AND lease_id=$2 AND fencing_token=$3",
        [identity.scopeId, identity.leaseId, identity.fencingToken]
      );
      return Object.freeze({
        released: updated.rowCount === 1,
        reason: updated.rowCount === 1 ? null : "lease-not-current"
      });
    });
  }

  async function verifyLease(input = {}) {
    assertInitialized();
    const identity = validateLeaseIdentity(input);
    return withTransaction(pool, async (client) => {
      const selected = await client.query(
        "SELECT scope_id, fencing_token, holder_id, lease_id, expires_at FROM jb_resilience_coordination_leases WHERE scope_id=$1",
        [identity.scopeId]
      );
      if (selected.rowCount !== 1) {
        return Object.freeze({ valid: false, reason: "lease-not-current" });
      }
      const current = selected.rows[0];
      const fencingToken = toSafeInteger(current.fencing_token, "fencing_token");
      if (!leaseIdentityMatches(current, identity)) {
        return Object.freeze({ valid: false, reason: "lease-not-current", currentFencingToken: fencingToken });
      }
      const now = await databaseNow(client);
      if (toSafeInteger(current.expires_at, "lease expires_at") <= now) {
        return Object.freeze({ valid: false, reason: "lease-expired", currentFencingToken: fencingToken });
      }
      return Object.freeze({
        valid: true,
        fencingToken,
        expiresAt: toSafeInteger(current.expires_at, "lease expires_at")
      });
    });
  }


  function validateFencedStateInput(input) {
    const safe = cloneJsonData(input);
    const required = [
      "scopeId", "targetId", "holderId", "leaseId",
      "fencingToken", "mutationId", "state"
    ];
    if (safe === null || typeof safe !== "object" || Array.isArray(safe) ||
        Object.keys(safe).length !== required.length ||
        !required.every((key) => Object.hasOwn(safe, key))) {
      throw new TypeError("fenced state mutation has an invalid shape");
    }
    const identity = validateLeaseIdentity(safe);
    assertAssetId(safe.targetId, "targetId");
    assertIdentifier(safe.mutationId, "mutationId");
    if (safe.state === null || typeof safe.state !== "object" || Array.isArray(safe.state)) {
      throw new TypeError("fenced state must be a plain JSON object");
    }
    if (Buffer.byteLength(JSON.stringify(safe.state), "utf8") > 64 * 1024) {
      throw new TypeError("fenced state exceeds the 64 KiB limit");
    }
    return { ...identity, targetId: safe.targetId, mutationId: safe.mutationId, state: safe.state };
  }

  async function applyFencedState(input) {
    assertInitialized();
    const safe = validateFencedStateInput(input);
    const payloadHash = createHash("sha256")
      .update(canonicalJson(safe.state), "utf8")
      .digest("hex");

    return withTransaction(pool, async (client) => {
      // Lock the authoritative lease row for the full target mutation. Lease
      // acquisition/replacement uses the same row lock, closing the
      // check-then-write race for this PostgreSQL-managed target.
      const leaseResult = await client.query(
        "SELECT scope_id, fencing_token, holder_id, lease_id, expires_at FROM jb_resilience_coordination_leases WHERE scope_id=$1 FOR UPDATE",
        [safe.scopeId]
      );
      if (leaseResult.rowCount !== 1 || !leaseIdentityMatches(leaseResult.rows[0], safe)) {
        return Object.freeze({ applied: false, reason: "lease-not-current" });
      }
      const now = await databaseNow(client);
      if (leaseResult.rows[0].expires_at === null ||
          toSafeInteger(leaseResult.rows[0].expires_at, "lease expires_at") <= now) {
        return Object.freeze({ applied: false, reason: "lease-expired" });
      }

      await client.query(
        "INSERT INTO jb_resilience_fenced_targets (scope_id, target_id) VALUES ($1,$2) ON CONFLICT (scope_id, target_id) DO NOTHING",
        [safe.scopeId, safe.targetId]
      );
      const targetResult = await client.query(
        "SELECT fencing_token, holder_id, lease_id, state FROM jb_resilience_fenced_targets WHERE scope_id=$1 AND target_id=$2 FOR UPDATE",
        [safe.scopeId, safe.targetId]
      );
      if (targetResult.rowCount !== 1) throw new Error("fenced target row is unavailable");

      const priorMutation = await client.query(
        "SELECT payload_hash FROM jb_resilience_fenced_mutations WHERE scope_id=$1 AND target_id=$2 AND mutation_id=$3",
        [safe.scopeId, safe.targetId, safe.mutationId]
      );
      if (priorMutation.rowCount === 1) {
        const samePayload = priorMutation.rows[0].payload_hash.trim() === payloadHash;
        return Object.freeze({
          applied: false,
          reason: samePayload ? "duplicate-mutation" : "mutation-id-conflict"
        });
      }

      const current = targetResult.rows[0];
      const currentToken = toSafeInteger(current.fencing_token, "target fencing_token");
      if (currentToken > safe.fencingToken) {
        return Object.freeze({ applied: false, reason: "stale-fencing-token", currentFencingToken: currentToken });
      }
      if (currentToken === safe.fencingToken &&
          (current.lease_id !== safe.leaseId || current.holder_id !== safe.holderId)) {
        return Object.freeze({ applied: false, reason: "fencing-token-owner-mismatch" });
      }

      await client.query(
        "UPDATE jb_resilience_fenced_targets SET fencing_token=$3, holder_id=$4, lease_id=$5, state=$6::jsonb, updated_at=$7 WHERE scope_id=$1 AND target_id=$2",
        [
          safe.scopeId, safe.targetId, safe.fencingToken, safe.holderId,
          safe.leaseId, JSON.stringify(safe.state), now
        ]
      );
      await client.query(
        "INSERT INTO jb_resilience_fenced_mutations (scope_id, target_id, mutation_id, payload_hash, fencing_token, applied_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [safe.scopeId, safe.targetId, safe.mutationId, payloadHash, safe.fencingToken, now]
      );
      return Object.freeze({ applied: true, fencingToken: safe.fencingToken, updatedAt: now });
    });
  }

  async function getFencedState({ scopeId, targetId } = {}) {
    assertInitialized();
    assertIdentifier(scopeId, "scopeId");
    assertAssetId(targetId, "targetId");
    return withTransaction(pool, async (client) => {
      const result = await client.query(
        "SELECT fencing_token, holder_id, lease_id, state, updated_at FROM jb_resilience_fenced_targets WHERE scope_id=$1 AND target_id=$2",
        [scopeId, targetId]
      );
      if (result.rowCount !== 1) return null;
      const row = result.rows[0];
      return Object.freeze({
        fencingToken: toSafeInteger(row.fencing_token, "target fencing_token"),
        holderId: row.holder_id,
        leaseId: row.lease_id,
        state: cloneJsonData(row.state),
        updatedAt: toSafeInteger(row.updated_at, "target updated_at")
      });
    });
  }


  function trustedSignalDigest(signal) {
    return createHash("sha256")
      .update(JSON.stringify({ ...signal, evidenceRefs: signal.evidenceRefs }), "utf8")
      .digest("hex");
  }

  async function recordTrustedSignal({
    signal: inputSignal, signalDigest, receivedAtMs, retentionUntilMs
  } = {}) {
    assertInitialized();
    const signal = validateTrustedSignalEnvelope(inputSignal);
    assertTimestamp(receivedAtMs, "receivedAtMs");
    assertTimestamp(retentionUntilMs, "retentionUntilMs");
    if (retentionUntilMs < signal.expiresAtMs) {
      throw new TypeError("retentionUntilMs must be at least expiresAtMs");
    }
    if (typeof signalDigest !== "string" || !SHA256.test(signalDigest) ||
        trustedSignalDigest(signal) !== signalDigest) {
      throw new TypeError("signalDigest does not match the trusted signal");
    }
    return withTransaction(pool, async (client) => {
      const inserted = await client.query(
        "INSERT INTO jb_resilience_trusted_signals (source_id, event_id, asset_id, environment, issued_at_ms, expires_at_ms, signal_digest, signal, received_at_ms, retention_until_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) ON CONFLICT (source_id, event_id) DO NOTHING RETURNING event_id",
        [signal.sourceId, signal.eventId, signal.assetId, signal.environment,
          signal.issuedAtMs, signal.expiresAtMs, signalDigest, JSON.stringify(signal),
          receivedAtMs, retentionUntilMs]
      );
      if (inserted.rowCount === 1) return Object.freeze({ recorded: true });
      const existing = await client.query(
        "SELECT signal_digest FROM jb_resilience_trusted_signals WHERE source_id=$1 AND event_id=$2",
        [signal.sourceId, signal.eventId]
      );
      if (existing.rowCount !== 1) {
        throw new Error("trusted signal replay record disappeared during conflict resolution");
      }
      return Object.freeze({
        recorded: false,
        reason: existing.rows[0].signal_digest.trim() === signalDigest
          ? "signal-replay" : "signal-id-conflict"
      });
    });
  }

  async function listTrustedSignals({ assetId, environment, sinceMs } = {}) {
    assertInitialized();
    assertAssetId(assetId, "assetId");
    assertIdentifier(environment, "environment");
    assertTimestamp(sinceMs, "sinceMs");
    return withTransaction(pool, async (client) => {
      const result = await client.query(
        "SELECT signal, signal_digest, received_at_ms, retention_until_ms FROM jb_resilience_trusted_signals WHERE asset_id=$1 AND environment=$2 AND issued_at_ms >= $3 ORDER BY issued_at_ms ASC, event_id ASC",
        [assetId, environment, sinceMs]
      );
      const records = result.rows.map((row) => {
        const signal = validateTrustedSignalEnvelope(row.signal);
        const signalDigest = row.signal_digest.trim();
        if (!SHA256.test(signalDigest) || trustedSignalDigest(signal) !== signalDigest) {
          throw new Error("trusted signal replay record integrity check failed");
        }
        const receivedAtMs = toSafeInteger(row.received_at_ms, "trusted signal received_at_ms");
        const retentionUntilMs = toSafeInteger(row.retention_until_ms, "trusted signal retention_until_ms");
        if (retentionUntilMs < signal.expiresAtMs) {
          throw new Error("trusted signal replay record has invalid retention");
        }
        return Object.freeze({ signal, signalDigest, receivedAtMs, retentionUntilMs });
      });
      return Object.freeze(records);
    });
  }

  async function initialize() {
    await withTransaction(pool, async (client) => {
      for (const statement of SCHEMA_STATEMENTS) await client.query(statement);
      await client.query(
        "INSERT INTO jb_resilience_audit_heads (head_id, sequence, last_hash) VALUES (1, 0, $1) ON CONFLICT (head_id) DO NOTHING",
        [GENESIS_HASH]
      );
    });
    initialized = true;
    return Object.freeze({ initialized: true, dialect: "postgresql", schemaVersion: 3 });
  }

  async function recordIncidentState(input) {
    assertInitialized();
    const record = validateIncidentRecord(input);
    return withTransaction(pool, async (client) => {
      if (["OBSERVING", "FAILED_CLOSED"].includes(record.state)) {
        const inserted = await client.query(
          "INSERT INTO jb_resilience_incidents (incident_id, asset_id, environment, service_id, state, decision, decision_rule, reason_code, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (incident_id) DO NOTHING RETURNING incident_id",
          [
            record.incidentId, record.assetId, record.environment, record.serviceId,
            record.state, record.decision, record.decisionRule, record.reasonCode, record.at
          ]
        );
        if (inserted.rowCount === 1) {
          await client.query(
            "INSERT INTO jb_resilience_incident_history (incident_id, state, at) VALUES ($1,$2,$3)",
            [record.incidentId, record.state, record.at]
          );
          return true;
        }
      }

      const selected = await client.query(
        "SELECT asset_id, environment, service_id, state, updated_at FROM jb_resilience_incidents WHERE incident_id = $1 FOR UPDATE",
        [record.incidentId]
      );
      if (selected.rowCount !== 1) return false;
      const current = selected.rows[0];
      if (current.asset_id !== record.assetId ||
          current.environment !== record.environment ||
          current.service_id !== record.serviceId ||
          !TRANSITIONS[current.state]?.has(record.state) ||
          record.at < toSafeInteger(current.updated_at, "incident updated_at")) {
        return false;
      }
      const updated = await client.query(
        "UPDATE jb_resilience_incidents SET state=$2, decision=$3, decision_rule=$4, reason_code=$5, updated_at=$6 WHERE incident_id=$1",
        [record.incidentId, record.state, record.decision, record.decisionRule, record.reasonCode, record.at]
      );
      if (updated.rowCount !== 1) return false;
      await client.query(
        "INSERT INTO jb_resilience_incident_history (incident_id, state, at) VALUES ($1,$2,$3)",
        [record.incidentId, record.state, record.at]
      );
      return true;
    });
  }

  async function getIncident(incidentId) {
    assertInitialized();
    assertIdentifier(incidentId, "incidentId");
    return withTransaction(pool, async (client) => {
      const result = await client.query(
        "SELECT incident_id, asset_id, environment, service_id, state, decision, decision_rule, reason_code, updated_at FROM jb_resilience_incidents WHERE incident_id = $1",
        [incidentId]
      );
      return mapIncident(result.rows[0]);
    });
  }

  async function getServiceState({ assetId, environment } = {}) {
    assertInitialized();
    assertAssetId(assetId, "assetId");
    assertIdentifier(environment, "environment");
    return withTransaction(pool, async (client) => {
      const result = await client.query(
        "SELECT last_action_at, last_outcome, consecutive_failures FROM jb_resilience_services WHERE environment=$1 AND asset_id=$2",
        [environment, assetId]
      );
      if (result.rowCount === 0) {
        return Object.freeze({ lastActionAt: null, lastOutcome: "unknown", consecutiveFailures: 0 });
      }
      const row = result.rows[0];
      return Object.freeze({
        lastActionAt: row.last_action_at === null ? null : toSafeInteger(row.last_action_at, "last_action_at"),
        lastOutcome: row.last_outcome,
        consecutiveFailures: toSafeInteger(row.consecutive_failures, "consecutive_failures")
      });
    });
  }

  async function getCircuitState({ assetId, environment, action, now } = {}) {
    assertInitialized();
    assertAssetId(assetId, "assetId");
    assertIdentifier(environment, "environment");
    assertIdentifier(action, "action");
    assertTimestamp(now, "circuit clock");
    return withTransaction(pool, async (client) => {
      const result = await client.query(
        "SELECT failure_count, failure_threshold, retry_at_ms FROM jb_resilience_circuits WHERE environment=$1 AND asset_id=$2 AND action=$3",
        [environment, assetId, action]
      );
      if (result.rowCount === 0) {
        return Object.freeze({ open: false, failureCount: 0, retryAtMs: null });
      }
      const row = result.rows[0];
      const failureCount = toSafeInteger(row.failure_count, "failure_count");
      const retryAtMs = row.retry_at_ms === null ? null : toSafeInteger(row.retry_at_ms, "retry_at_ms");
      const threshold = toSafeInteger(row.failure_threshold, "failure_threshold");
      const open = failureCount >= threshold && retryAtMs !== null && now < retryAtMs;
      return Object.freeze({
        open,
        failureCount,
        retryAtMs: open ? retryAtMs : null
      });
    });
  }

  async function claimAction(input) {
    assertInitialized();
    const safe = validateClaimInput(input);
    try {
      return await withTransaction(pool, async (client) => {
        const prior = await client.query(
          "SELECT action_id FROM jb_resilience_actions WHERE idempotency_key=$1",
          [safe.idempotencyKey]
        );
        if (prior.rowCount > 0) {
          return Object.freeze({ claimed: false, reason: "idempotency-key-already-claimed" });
        }

        await client.query(
          "INSERT INTO jb_resilience_services (environment, asset_id) VALUES ($1,$2) ON CONFLICT (environment, asset_id) DO NOTHING",
          [safe.environment, safe.assetId]
        );
        await client.query(
          "SELECT environment FROM jb_resilience_services WHERE environment=$1 AND asset_id=$2 FOR UPDATE",
          [safe.environment, safe.assetId]
        );

        const idempotencyAfterLock = await client.query(
          "SELECT action_id FROM jb_resilience_actions WHERE idempotency_key=$1",
          [safe.idempotencyKey]
        );
        if (idempotencyAfterLock.rowCount > 0) {
          return Object.freeze({ claimed: false, reason: "idempotency-key-already-claimed" });
        }

        const active = await client.query(
          "SELECT expires_at FROM jb_resilience_actions WHERE environment=$1 AND asset_id=$2 AND status='claimed' FOR UPDATE",
          [safe.environment, safe.assetId]
        );
        if (active.rowCount > 0) {
          const expiresAt = toSafeInteger(active.rows[0].expires_at, "action expires_at");
          return Object.freeze({
            claimed: false,
            reason: expiresAt <= safe.claimedAt
              ? "action-reconciliation-required"
              : "asset-action-already-in-progress"
          });
        }

        const actionId = randomUUID();
        await client.query(
          "INSERT INTO jb_resilience_actions (action_id, idempotency_key, incident_id, asset_id, environment, service_id, action, claimed_at, expires_at, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'claimed')",
          [
            actionId, safe.idempotencyKey, safe.incidentId, safe.assetId,
            safe.environment, safe.serviceId, safe.action, safe.claimedAt, safe.expiresAt
          ]
        );
        return Object.freeze({ claimed: true, actionId });
      });
    } catch (error) {
      if (error?.code !== "23505") throw error;
      const prior = await pool.query(
        "SELECT 1 FROM jb_resilience_actions WHERE idempotency_key=$1",
        [safe.idempotencyKey]
      );
      return Object.freeze({
        claimed: false,
        reason: prior.rowCount > 0
          ? "idempotency-key-already-claimed"
          : "asset-action-already-in-progress"
      });
    }
  }

  async function completeAction({ actionId, outcome, completedAt, reasonCode } = {}) {
    assertInitialized();
    assertIdentifier(actionId, "actionId");
    assertTimestamp(completedAt, "completedAt");
    if (!ACTION_OUTCOMES.has(outcome) ||
        typeof reasonCode !== "string" || reasonCode.length < 1 || reasonCode.length > 128) {
      throw new TypeError("action completion is invalid");
    }
    return withTransaction(pool, async (client) => {
      const updated = await client.query(
        "UPDATE jb_resilience_actions SET status=$2, outcome=$2, completed_at=$3, reason_code=$4 WHERE action_id=$1 AND status='claimed' AND claimed_at <= $3",
        [actionId, outcome, completedAt, reasonCode]
      );
      return updated.rowCount === 1;
    });
  }

  async function recordActionOutcome({
    assetId, environment, action, outcome, at, failureThreshold, cooldownMs
  } = {}) {
    assertInitialized();
    assertAssetId(assetId, "assetId");
    assertIdentifier(environment, "environment");
    assertIdentifier(action, "action");
    assertTimestamp(at, "action outcome timestamp");
    validateOutcomes({ outcome, failureThreshold, cooldownMs });
    if (outcome === "cancelled-before-execution") return true;
    const retryAt = at + cooldownMs;
    if (outcome !== "succeeded" && !Number.isSafeInteger(retryAt)) return false;

    return withTransaction(pool, async (client) => {
      const selected = await client.query(
        "SELECT last_action_at, consecutive_failures FROM jb_resilience_services WHERE environment=$1 AND asset_id=$2 FOR UPDATE",
        [environment, assetId]
      );
      if (selected.rowCount !== 1) return false;
      const current = selected.rows[0];
      const lastActionAt = current.last_action_at === null
        ? null : toSafeInteger(current.last_action_at, "last_action_at");
      if (lastActionAt !== null && at < lastActionAt) return false;

      const consecutiveFailures = toSafeInteger(current.consecutive_failures, "consecutive_failures");
      await client.query(
        "UPDATE jb_resilience_services SET last_action_at=$3, last_outcome=$4, consecutive_failures=$5 WHERE environment=$1 AND asset_id=$2",
        [
          environment, assetId, at, outcome,
          outcome === "succeeded" ? 0 : Math.min(1000, consecutiveFailures + 1)
        ]
      );

      const prior = await client.query(
        "SELECT failure_count FROM jb_resilience_circuits WHERE environment=$1 AND asset_id=$2 AND action=$3 FOR UPDATE",
        [environment, assetId, action]
      );
      const previousFailures = prior.rowCount === 0
        ? 0 : toSafeInteger(prior.rows[0].failure_count, "failure_count");
      const failureCount = outcome === "succeeded"
        ? 0 : Math.min(1_000_000, previousFailures + 1);
      const nextRetryAt = failureCount >= failureThreshold ? retryAt : null;
      await client.query(
        "INSERT INTO jb_resilience_circuits (environment, asset_id, action, failure_count, failure_threshold, cooldown_ms, retry_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (environment, asset_id, action) DO UPDATE SET failure_count=EXCLUDED.failure_count, failure_threshold=EXCLUDED.failure_threshold, cooldown_ms=EXCLUDED.cooldown_ms, retry_at_ms=EXCLUDED.retry_at_ms",
        [environment, assetId, action, failureCount, failureThreshold, cooldownMs, nextRetryAt]
      );
      return true;
    });
  }

  async function appendAudit(entry) {
    assertInitialized();
    const safeEntry = normalizeAuditEntry(entry);
    return withTransaction(pool, async (client) => {
      const verified = await verifyAuditWithClient(client, { lockHead: true });
      const sequence = verified.sequence + 1;
      const record = {
        schema: AUDIT_SCHEMA,
        sequence,
        previousHash: verified.lastHash,
        entry: safeEntry
      };
      const hash = auditRecordHash(record);
      await client.query(
        "INSERT INTO jb_resilience_audit_records (sequence, record_schema, previous_hash, hash, entry) VALUES ($1,$2,$3,$4,$5::jsonb)",
        [sequence, AUDIT_SCHEMA, record.previousHash, hash, JSON.stringify(safeEntry)]
      );
      await client.query(
        "UPDATE jb_resilience_audit_heads SET sequence=$1, last_hash=$2 WHERE head_id=1",
        [sequence, hash]
      );
      return true;
    });
  }

  async function verifyAudit() {
    assertInitialized();
    return withTransaction(pool, async (client) =>
      verifyAuditWithClient(client, { lockHead: false }));
  }

  const orchestrationStore = Object.freeze({
    durable: true,
    distributedTransactions: true,
    recordIncidentState,
    getIncident,
    getServiceState,
    getCircuitState,
    claimAction,
    completeAction,
    recordActionOutcome
  });
  const auditStore = Object.freeze({
    durable: true,
    append: appendAudit,
    verify: verifyAudit
  });

  const coordinationStore = Object.freeze({
    durable: true,
    dialect: "postgresql",
    acquireLease,
    renewLease,
    releaseLease,
    verifyLease
  });
  const fencedTargetStore = Object.freeze({
    durable: true,
    dialect: "postgresql",
    guaranteesAtomicTargetWrites: true,
    applyState: applyFencedState,
    getState: getFencedState
  });

  return Object.freeze({
    durable: true,
    dialect: "postgresql",
    initialize,
    orchestrationStore,
    auditStore,
    coordinationStore,
    fencedTargetStore
  });
}
), signal JSONB NOT NULL, received_at_ms BIGINT NOT NULL, retention_until_ms BIGINT NOT NULL, PRIMARY KEY (source_id, event_id), CHECK (expires_at_ms > issued_at_ms), CHECK (retention_until_ms >= expires_at_ms))",
  "CREATE INDEX IF NOT EXISTS jb_resilience_trusted_signals_asset_idx ON jb_resilience_trusted_signals (asset_id, environment, issued_at_ms, event_id)"
];

function ensurePool(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("pool must provide connect(), query(), and clients with query()/release()");
  }
}

function mapIncident(row) {
  if (!row) return null;
  return Object.freeze({
    incidentId: row.incident_id,
    assetId: row.asset_id,
    environment: row.environment,
    serviceId: row.service_id,
    state: row.state,
    decision: row.decision,
    decisionRule: row.decision_rule,
    reasonCode: row.reason_code,
    updatedAt: toSafeInteger(row.updated_at, "incident updated_at")
  });
}

async function verifyAuditWithClient(client, { lockHead = false } = {}) {
  const headQuery = await client.query(
    "SELECT sequence, last_hash FROM jb_resilience_audit_heads WHERE head_id = 1" +
      (lockHead ? " FOR UPDATE" : " FOR SHARE")
  );
  if (headQuery.rowCount !== 1) throw new Error("audit head is missing; audit writes are blocked");
  const head = headQuery.rows[0];
  const rows = await client.query(
    "SELECT sequence, record_schema, previous_hash, hash, entry FROM jb_resilience_audit_records ORDER BY sequence ASC"
  );
  let sequence = 0;
  let previousHash = GENESIS_HASH;
  for (const row of rows.rows) {
    const currentSequence = toSafeInteger(row.sequence, "audit sequence");
    const record = {
      schema: row.record_schema,
      sequence: currentSequence,
      previousHash: row.previous_hash.trim(),
      entry: row.entry
    };
    if (record.schema !== AUDIT_SCHEMA ||
        currentSequence !== sequence + 1 ||
        record.previousHash !== previousHash ||
        typeof row.hash !== "string" || !SHA256.test(row.hash.trim()) ||
        auditRecordHash(record) !== row.hash.trim()) {
      throw new Error("audit log integrity verification failed");
    }
    sequence = currentSequence;
    previousHash = row.hash.trim();
  }
  if (toSafeInteger(head.sequence, "audit head sequence") !== sequence ||
      head.last_hash.trim() !== previousHash) {
    throw new Error("audit head does not match the verified record chain");
  }
  return Object.freeze({ valid: true, sequence, lastHash: previousHash });
}

/**
 * PostgreSQL-backed transactional storage for the JB Resilience v0.6 orchestrator.
 *
 * The injected object must be a node-postgres-compatible Pool. Call initialize()
 * explicitly before use. No driver, connection URL, credentials, schema migration
 * runner or network client is bundled by this package.
 */
export function createPostgresResilienceStorageAdapter({ pool } = {}) {
  ensurePool(pool);
  let initialized = false;

  function assertInitialized() {
    if (!initialized) throw new Error("PostgreSQL resilience storage is not initialized; call initialize() first");
  }

  async function databaseNow(client) {
    const result = await client.query(
      "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms"
    );
    if (result.rowCount !== 1) throw new Error("database clock is unavailable");
    return toSafeInteger(result.rows[0].now_ms, "database clock");
  }

  function validateLeaseDuration(leaseDurationMs) {
    if (!Number.isSafeInteger(leaseDurationMs) ||
        leaseDurationMs < 1_000 || leaseDurationMs > 300_000) {
      throw new TypeError("leaseDurationMs must be between 1000 and 300000 milliseconds");
    }
    return leaseDurationMs;
  }

  function validateLeaseIdentity(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("lease identity is invalid");
    }
    assertIdentifier(input.scopeId, "scopeId");
    assertIdentifier(input.holderId, "holderId");
    if (typeof input.leaseId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.leaseId) ||
        !Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
      throw new TypeError("lease identity or fencing token is invalid");
    }
    return {
      scopeId: input.scopeId,
      holderId: input.holderId,
      leaseId: input.leaseId,
      fencingToken: input.fencingToken
    };
  }

  function mapLease(row) {
    return Object.freeze({
      scopeId: row.scope_id,
      holderId: row.holder_id,
      leaseId: row.lease_id,
      fencingToken: toSafeInteger(row.fencing_token, "fencing_token"),
      acquiredAt: toSafeInteger(row.acquired_at, "lease acquired_at"),
      renewedAt: toSafeInteger(row.renewed_at, "lease renewed_at"),
      expiresAt: toSafeInteger(row.expires_at, "lease expires_at")
    });
  }

  function leaseIdentityMatches(row, identity) {
    return Boolean(row && row.holder_id === identity.holderId &&
      row.lease_id === identity.leaseId &&
      toSafeInteger(row.fencing_token, "fencing_token") === identity.fencingToken);
  }

  async function acquireLease({ scopeId, holderId, leaseDurationMs } = {}) {
    assertInitialized();
    assertIdentifier(scopeId, "scopeId");
    assertIdentifier(holderId, "holderId");
    validateLeaseDuration(leaseDurationMs);

    return withTransaction(pool, async (client) => {
      await client.query(
        "INSERT INTO jb_resilience_coordination_leases (scope_id, fencing_token) VALUES ($1, 0) ON CONFLICT (scope_id) DO NOTHING",
        [scopeId]
      );
      const selected = await client.query(
        "SELECT scope_id, fencing_token, holder_id, lease_id, acquired_at, renewed_at, expires_at FROM jb_resilience_coordination_leases WHERE scope_id=$1 FOR UPDATE",
        [scopeId]
      );
      if (selected.rowCount !== 1) throw new Error("coordination lease row is unavailable");
      const current = selected.rows[0];
      const now = await databaseNow(client);
      if (current.lease_id !== null &&
          toSafeInteger(current.expires_at, "lease expires_at") > now) {
        return Object.freeze({
          acquired: false,
          reason: "lease-held",
          leaseExpiresAt: toSafeInteger(current.expires_at, "lease expires_at")
        });
      }

      const priorToken = toSafeInteger(current.fencing_token, "fencing_token");
      if (priorToken >= Number.MAX_SAFE_INTEGER) {
        throw new Error("fencing token exhausted; coordination is blocked");
      }
      const fencingToken = priorToken + 1;
      const expiresAt = now + leaseDurationMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new Error("lease expiry exceeds the supported timestamp range");
      }
      const leaseId = randomUUID();
      const updated = await client.query(
        "UPDATE jb_resilience_coordination_leases SET fencing_token=$2, holder_id=$3, lease_id=$4, acquired_at=$5, renewed_at=$5, expires_at=$6 WHERE scope_id=$1 RETURNING scope_id, fencing_token, holder_id, lease_id, acquired_at, renewed_at, expires_at",
        [scopeId, fencingToken, holderId, leaseId, now, expiresAt]
      );
      if (updated.rowCount !== 1) throw new Error("coordination lease acquisition did not persist");
      return Object.freeze({ acquired: true, lease: mapLease(updated.rows[0]) });
    });
  }

  async function renewLease({ scopeId, holderId, leaseId, fencingToken, leaseDurationMs } = {}) {
    assertInitialized();
    const identity = validateLeaseIdentity({ scopeId, holderId, leaseId, fencingToken });
    validateLeaseDuration(leaseDurationMs);

    return withTransaction(pool, async (client) => {
      const selected = await client.query(
        "SELECT scope_id, fencing_token, holder_id, lease_id, acquired_at, renewed_at, expires_at FROM jb_resilience_coordination_leases WHERE scope_id=$1 FOR UPDATE",
        [identity.scopeId]
      );
      if (selected.rowCount !== 1) {
        return Object.freeze({ renewed: false, reason: "lease-not-current" });
      }
      const current = selected.rows[0];
      if (!leaseIdentityMatches(current, identity)) {
        return Object.freeze({ renewed: false, reason: "lease-not-current" });
      }
      const now = await databaseNow(client);
      if (toSafeInteger(current.expires_at, "lease expires_at") <= now) {
        return Object.freeze({ renewed: false, reason: "lease-expired" });
      }
      const expiresAt = now + leaseDurationMs;
      if (!Number.isSafeInteger(expiresAt)) throw new Error("lease expiry exceeds the supported timestamp range");
      const updated = await client.query(
        "UPDATE jb_resilience_coordination_leases SET renewed_at=$2, expires_at=$3 WHERE scope_id=$1 AND holder_id=$4 AND lease_id=$5 AND fencing_token=$6 RETURNING scope_id, fencing_token, holder_id, lease_id, acquired_at, renewed_at, expires_at",
        [identity.scopeId, now, expiresAt, identity.holderId, identity.leaseId, identity.fencingToken]
      );
      if (updated.rowCount !== 1) return Object.freeze({ renewed: false, reason: "lease-not-current" });
      return Object.freeze({ renewed: true, lease: mapLease(updated.rows[0]) });
    });
  }

  async function releaseLease(input = {}) {
    assertInitialized();
    const identity = validateLeaseIdentity(input);
    return withTransaction(pool, async (client) => {
      const selected = await client.query(
        "SELECT scope_id, fencing_token, holder_id, lease_id, expires_at FROM jb_resilience_coordination_leases WHERE scope_id=$1 FOR UPDATE",
        [identity.scopeId]
      );
      if (selected.rowCount !== 1 || !leaseIdentityMatches(selected.rows[0], identity)) {
        return Object.freeze({ released: false, reason: "lease-not-current" });
      }
      const now = await databaseNow(client);
      if (toSafeInteger(selected.rows[0].expires_at, "lease expires_at") <= now) {
        return Object.freeze({ released: false, reason: "lease-expired" });
      }
      const updated = await client.query(
        "UPDATE jb_resilience_coordination_leases SET holder_id=NULL, lease_id=NULL, acquired_at=NULL, renewed_at=NULL, expires_at=NULL WHERE scope_id=$1 AND lease_id=$2 AND fencing_token=$3",
        [identity.scopeId, identity.leaseId, identity.fencingToken]
      );
      return Object.freeze({
        released: updated.rowCount === 1,
        reason: updated.rowCount === 1 ? null : "lease-not-current"
      });
    });
  }

  async function verifyLease(input = {}) {
    assertInitialized();
    const identity = validateLeaseIdentity(input);
    return withTransaction(pool, async (client) => {
      const selected = await client.query(
        "SELECT scope_id, fencing_token, holder_id, lease_id, expires_at FROM jb_resilience_coordination_leases WHERE scope_id=$1",
        [identity.scopeId]
      );
      if (selected.rowCount !== 1) {
        return Object.freeze({ valid: false, reason: "lease-not-current" });
      }
      const current = selected.rows[0];
      const fencingToken = toSafeInteger(current.fencing_token, "fencing_token");
      if (!leaseIdentityMatches(current, identity)) {
        return Object.freeze({ valid: false, reason: "lease-not-current", currentFencingToken: fencingToken });
      }
      const now = await databaseNow(client);
      if (toSafeInteger(current.expires_at, "lease expires_at") <= now) {
        return Object.freeze({ valid: false, reason: "lease-expired", currentFencingToken: fencingToken });
      }
      return Object.freeze({
        valid: true,
        fencingToken,
        expiresAt: toSafeInteger(current.expires_at, "lease expires_at")
      });
    });
  }


  function validateFencedStateInput(input) {
    const safe = cloneJsonData(input);
    const required = [
      "scopeId", "targetId", "holderId", "leaseId",
      "fencingToken", "mutationId", "state"
    ];
    if (safe === null || typeof safe !== "object" || Array.isArray(safe) ||
        Object.keys(safe).length !== required.length ||
        !required.every((key) => Object.hasOwn(safe, key))) {
      throw new TypeError("fenced state mutation has an invalid shape");
    }
    const identity = validateLeaseIdentity(safe);
    assertAssetId(safe.targetId, "targetId");
    assertIdentifier(safe.mutationId, "mutationId");
    if (safe.state === null || typeof safe.state !== "object" || Array.isArray(safe.state)) {
      throw new TypeError("fenced state must be a plain JSON object");
    }
    if (Buffer.byteLength(JSON.stringify(safe.state), "utf8") > 64 * 1024) {
      throw new TypeError("fenced state exceeds the 64 KiB limit");
    }
    return { ...identity, targetId: safe.targetId, mutationId: safe.mutationId, state: safe.state };
  }

  async function applyFencedState(input) {
    assertInitialized();
    const safe = validateFencedStateInput(input);
    const payloadHash = createHash("sha256")
      .update(canonicalJson(safe.state), "utf8")
      .digest("hex");

    return withTransaction(pool, async (client) => {
      // Lock the authoritative lease row for the full target mutation. Lease
      // acquisition/replacement uses the same row lock, closing the
      // check-then-write race for this PostgreSQL-managed target.
      const leaseResult = await client.query(
        "SELECT scope_id, fencing_token, holder_id, lease_id, expires_at FROM jb_resilience_coordination_leases WHERE scope_id=$1 FOR UPDATE",
        [safe.scopeId]
      );
      if (leaseResult.rowCount !== 1 || !leaseIdentityMatches(leaseResult.rows[0], safe)) {
        return Object.freeze({ applied: false, reason: "lease-not-current" });
      }
      const now = await databaseNow(client);
      if (leaseResult.rows[0].expires_at === null ||
          toSafeInteger(leaseResult.rows[0].expires_at, "lease expires_at") <= now) {
        return Object.freeze({ applied: false, reason: "lease-expired" });
      }

      await client.query(
        "INSERT INTO jb_resilience_fenced_targets (scope_id, target_id) VALUES ($1,$2) ON CONFLICT (scope_id, target_id) DO NOTHING",
        [safe.scopeId, safe.targetId]
      );
      const targetResult = await client.query(
        "SELECT fencing_token, holder_id, lease_id, state FROM jb_resilience_fenced_targets WHERE scope_id=$1 AND target_id=$2 FOR UPDATE",
        [safe.scopeId, safe.targetId]
      );
      if (targetResult.rowCount !== 1) throw new Error("fenced target row is unavailable");

      const priorMutation = await client.query(
        "SELECT payload_hash FROM jb_resilience_fenced_mutations WHERE scope_id=$1 AND target_id=$2 AND mutation_id=$3",
        [safe.scopeId, safe.targetId, safe.mutationId]
      );
      if (priorMutation.rowCount === 1) {
        const samePayload = priorMutation.rows[0].payload_hash.trim() === payloadHash;
        return Object.freeze({
          applied: false,
          reason: samePayload ? "duplicate-mutation" : "mutation-id-conflict"
        });
      }

      const current = targetResult.rows[0];
      const currentToken = toSafeInteger(current.fencing_token, "target fencing_token");
      if (currentToken > safe.fencingToken) {
        return Object.freeze({ applied: false, reason: "stale-fencing-token", currentFencingToken: currentToken });
      }
      if (currentToken === safe.fencingToken &&
          (current.lease_id !== safe.leaseId || current.holder_id !== safe.holderId)) {
        return Object.freeze({ applied: false, reason: "fencing-token-owner-mismatch" });
      }

      await client.query(
        "UPDATE jb_resilience_fenced_targets SET fencing_token=$3, holder_id=$4, lease_id=$5, state=$6::jsonb, updated_at=$7 WHERE scope_id=$1 AND target_id=$2",
        [
          safe.scopeId, safe.targetId, safe.fencingToken, safe.holderId,
          safe.leaseId, JSON.stringify(safe.state), now
        ]
      );
      await client.query(
        "INSERT INTO jb_resilience_fenced_mutations (scope_id, target_id, mutation_id, payload_hash, fencing_token, applied_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [safe.scopeId, safe.targetId, safe.mutationId, payloadHash, safe.fencingToken, now]
      );
      return Object.freeze({ applied: true, fencingToken: safe.fencingToken, updatedAt: now });
    });
  }

  async function getFencedState({ scopeId, targetId } = {}) {
    assertInitialized();
    assertIdentifier(scopeId, "scopeId");
    assertAssetId(targetId, "targetId");
    return withTransaction(pool, async (client) => {
      const result = await client.query(
        "SELECT fencing_token, holder_id, lease_id, state, updated_at FROM jb_resilience_fenced_targets WHERE scope_id=$1 AND target_id=$2",
        [scopeId, targetId]
      );
      if (result.rowCount !== 1) return null;
      const row = result.rows[0];
      return Object.freeze({
        fencingToken: toSafeInteger(row.fencing_token, "target fencing_token"),
        holderId: row.holder_id,
        leaseId: row.lease_id,
        state: cloneJsonData(row.state),
        updatedAt: toSafeInteger(row.updated_at, "target updated_at")
      });
    });
  }


  function trustedSignalDigest(signal) {
    return createHash("sha256")
      .update(JSON.stringify({ ...signal, evidenceRefs: signal.evidenceRefs }), "utf8")
      .digest("hex");
  }

  async function recordTrustedSignal({
    signal: inputSignal, signalDigest, receivedAtMs, retentionUntilMs
  } = {}) {
    assertInitialized();
    const signal = validateTrustedSignalEnvelope(inputSignal);
    assertTimestamp(receivedAtMs, "receivedAtMs");
    assertTimestamp(retentionUntilMs, "retentionUntilMs");
    if (retentionUntilMs < signal.expiresAtMs) {
      throw new TypeError("retentionUntilMs must be at least expiresAtMs");
    }
    if (typeof signalDigest !== "string" || !SHA256.test(signalDigest) ||
        trustedSignalDigest(signal) !== signalDigest) {
      throw new TypeError("signalDigest does not match the trusted signal");
    }
    return withTransaction(pool, async (client) => {
      const inserted = await client.query(
        "INSERT INTO jb_resilience_trusted_signals (source_id, event_id, asset_id, environment, issued_at_ms, expires_at_ms, signal_digest, signal, received_at_ms, retention_until_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) ON CONFLICT (source_id, event_id) DO NOTHING RETURNING event_id",
        [signal.sourceId, signal.eventId, signal.assetId, signal.environment,
          signal.issuedAtMs, signal.expiresAtMs, signalDigest, JSON.stringify(signal),
          receivedAtMs, retentionUntilMs]
      );
      if (inserted.rowCount === 1) return Object.freeze({ recorded: true });
      const existing = await client.query(
        "SELECT signal_digest FROM jb_resilience_trusted_signals WHERE source_id=$1 AND event_id=$2",
        [signal.sourceId, signal.eventId]
      );
      if (existing.rowCount !== 1) {
        throw new Error("trusted signal replay record disappeared during conflict resolution");
      }
      return Object.freeze({
        recorded: false,
        reason: existing.rows[0].signal_digest.trim() === signalDigest
          ? "signal-replay" : "signal-id-conflict"
      });
    });
  }

  async function listTrustedSignals({ assetId, environment, sinceMs } = {}) {
    assertInitialized();
    assertAssetId(assetId, "assetId");
    assertIdentifier(environment, "environment");
    assertTimestamp(sinceMs, "sinceMs");
    return withTransaction(pool, async (client) => {
      const result = await client.query(
        "SELECT signal, signal_digest, received_at_ms, retention_until_ms FROM jb_resilience_trusted_signals WHERE asset_id=$1 AND environment=$2 AND issued_at_ms >= $3 ORDER BY issued_at_ms ASC, event_id ASC",
        [assetId, environment, sinceMs]
      );
      const records = result.rows.map((row) => {
        const signal = validateTrustedSignalEnvelope(row.signal);
        const signalDigest = row.signal_digest.trim();
        if (!SHA256.test(signalDigest) || trustedSignalDigest(signal) !== signalDigest) {
          throw new Error("trusted signal replay record integrity check failed");
        }
        const receivedAtMs = toSafeInteger(row.received_at_ms, "trusted signal received_at_ms");
        const retentionUntilMs = toSafeInteger(row.retention_until_ms, "trusted signal retention_until_ms");
        if (retentionUntilMs < signal.expiresAtMs) {
          throw new Error("trusted signal replay record has invalid retention");
        }
        return Object.freeze({ signal, signalDigest, receivedAtMs, retentionUntilMs });
      });
      return Object.freeze(records);
    });
  }

  async function initialize() {
    await withTransaction(pool, async (client) => {
      for (const statement of SCHEMA_STATEMENTS) await client.query(statement);
      await client.query(
        "INSERT INTO jb_resilience_audit_heads (head_id, sequence, last_hash) VALUES (1, 0, $1) ON CONFLICT (head_id) DO NOTHING",
        [GENESIS_HASH]
      );
    });
    initialized = true;
    return Object.freeze({ initialized: true, dialect: "postgresql", schemaVersion: 3 });
  }

  async function recordIncidentState(input) {
    assertInitialized();
    const record = validateIncidentRecord(input);
    return withTransaction(pool, async (client) => {
      if (["OBSERVING", "FAILED_CLOSED"].includes(record.state)) {
        const inserted = await client.query(
          "INSERT INTO jb_resilience_incidents (incident_id, asset_id, environment, service_id, state, decision, decision_rule, reason_code, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (incident_id) DO NOTHING RETURNING incident_id",
          [
            record.incidentId, record.assetId, record.environment, record.serviceId,
            record.state, record.decision, record.decisionRule, record.reasonCode, record.at
          ]
        );
        if (inserted.rowCount === 1) {
          await client.query(
            "INSERT INTO jb_resilience_incident_history (incident_id, state, at) VALUES ($1,$2,$3)",
            [record.incidentId, record.state, record.at]
          );
          return true;
        }
      }

      const selected = await client.query(
        "SELECT asset_id, environment, service_id, state, updated_at FROM jb_resilience_incidents WHERE incident_id = $1 FOR UPDATE",
        [record.incidentId]
      );
      if (selected.rowCount !== 1) return false;
      const current = selected.rows[0];
      if (current.asset_id !== record.assetId ||
          current.environment !== record.environment ||
          current.service_id !== record.serviceId ||
          !TRANSITIONS[current.state]?.has(record.state) ||
          record.at < toSafeInteger(current.updated_at, "incident updated_at")) {
        return false;
      }
      const updated = await client.query(
        "UPDATE jb_resilience_incidents SET state=$2, decision=$3, decision_rule=$4, reason_code=$5, updated_at=$6 WHERE incident_id=$1",
        [record.incidentId, record.state, record.decision, record.decisionRule, record.reasonCode, record.at]
      );
      if (updated.rowCount !== 1) return false;
      await client.query(
        "INSERT INTO jb_resilience_incident_history (incident_id, state, at) VALUES ($1,$2,$3)",
        [record.incidentId, record.state, record.at]
      );
      return true;
    });
  }

  async function getIncident(incidentId) {
    assertInitialized();
    assertIdentifier(incidentId, "incidentId");
    return withTransaction(pool, async (client) => {
      const result = await client.query(
        "SELECT incident_id, asset_id, environment, service_id, state, decision, decision_rule, reason_code, updated_at FROM jb_resilience_incidents WHERE incident_id = $1",
        [incidentId]
      );
      return mapIncident(result.rows[0]);
    });
  }

  async function getServiceState({ assetId, environment } = {}) {
    assertInitialized();
    assertAssetId(assetId, "assetId");
    assertIdentifier(environment, "environment");
    return withTransaction(pool, async (client) => {
      const result = await client.query(
        "SELECT last_action_at, last_outcome, consecutive_failures FROM jb_resilience_services WHERE environment=$1 AND asset_id=$2",
        [environment, assetId]
      );
      if (result.rowCount === 0) {
        return Object.freeze({ lastActionAt: null, lastOutcome: "unknown", consecutiveFailures: 0 });
      }
      const row = result.rows[0];
      return Object.freeze({
        lastActionAt: row.last_action_at === null ? null : toSafeInteger(row.last_action_at, "last_action_at"),
        lastOutcome: row.last_outcome,
        consecutiveFailures: toSafeInteger(row.consecutive_failures, "consecutive_failures")
      });
    });
  }

  async function getCircuitState({ assetId, environment, action, now } = {}) {
    assertInitialized();
    assertAssetId(assetId, "assetId");
    assertIdentifier(environment, "environment");
    assertIdentifier(action, "action");
    assertTimestamp(now, "circuit clock");
    return withTransaction(pool, async (client) => {
      const result = await client.query(
        "SELECT failure_count, failure_threshold, retry_at_ms FROM jb_resilience_circuits WHERE environment=$1 AND asset_id=$2 AND action=$3",
        [environment, assetId, action]
      );
      if (result.rowCount === 0) {
        return Object.freeze({ open: false, failureCount: 0, retryAtMs: null });
      }
      const row = result.rows[0];
      const failureCount = toSafeInteger(row.failure_count, "failure_count");
      const retryAtMs = row.retry_at_ms === null ? null : toSafeInteger(row.retry_at_ms, "retry_at_ms");
      const threshold = toSafeInteger(row.failure_threshold, "failure_threshold");
      const open = failureCount >= threshold && retryAtMs !== null && now < retryAtMs;
      return Object.freeze({
        open,
        failureCount,
        retryAtMs: open ? retryAtMs : null
      });
    });
  }

  async function claimAction(input) {
    assertInitialized();
    const safe = validateClaimInput(input);
    try {
      return await withTransaction(pool, async (client) => {
        const prior = await client.query(
          "SELECT action_id FROM jb_resilience_actions WHERE idempotency_key=$1",
          [safe.idempotencyKey]
        );
        if (prior.rowCount > 0) {
          return Object.freeze({ claimed: false, reason: "idempotency-key-already-claimed" });
        }

        await client.query(
          "INSERT INTO jb_resilience_services (environment, asset_id) VALUES ($1,$2) ON CONFLICT (environment, asset_id) DO NOTHING",
          [safe.environment, safe.assetId]
        );
        await client.query(
          "SELECT environment FROM jb_resilience_services WHERE environment=$1 AND asset_id=$2 FOR UPDATE",
          [safe.environment, safe.assetId]
        );

        const idempotencyAfterLock = await client.query(
          "SELECT action_id FROM jb_resilience_actions WHERE idempotency_key=$1",
          [safe.idempotencyKey]
        );
        if (idempotencyAfterLock.rowCount > 0) {
          return Object.freeze({ claimed: false, reason: "idempotency-key-already-claimed" });
        }

        const active = await client.query(
          "SELECT expires_at FROM jb_resilience_actions WHERE environment=$1 AND asset_id=$2 AND status='claimed' FOR UPDATE",
          [safe.environment, safe.assetId]
        );
        if (active.rowCount > 0) {
          const expiresAt = toSafeInteger(active.rows[0].expires_at, "action expires_at");
          return Object.freeze({
            claimed: false,
            reason: expiresAt <= safe.claimedAt
              ? "action-reconciliation-required"
              : "asset-action-already-in-progress"
          });
        }

        const actionId = randomUUID();
        await client.query(
          "INSERT INTO jb_resilience_actions (action_id, idempotency_key, incident_id, asset_id, environment, service_id, action, claimed_at, expires_at, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'claimed')",
          [
            actionId, safe.idempotencyKey, safe.incidentId, safe.assetId,
            safe.environment, safe.serviceId, safe.action, safe.claimedAt, safe.expiresAt
          ]
        );
        return Object.freeze({ claimed: true, actionId });
      });
    } catch (error) {
      if (error?.code !== "23505") throw error;
      const prior = await pool.query(
        "SELECT 1 FROM jb_resilience_actions WHERE idempotency_key=$1",
        [safe.idempotencyKey]
      );
      return Object.freeze({
        claimed: false,
        reason: prior.rowCount > 0
          ? "idempotency-key-already-claimed"
          : "asset-action-already-in-progress"
      });
    }
  }

  async function completeAction({ actionId, outcome, completedAt, reasonCode } = {}) {
    assertInitialized();
    assertIdentifier(actionId, "actionId");
    assertTimestamp(completedAt, "completedAt");
    if (!ACTION_OUTCOMES.has(outcome) ||
        typeof reasonCode !== "string" || reasonCode.length < 1 || reasonCode.length > 128) {
      throw new TypeError("action completion is invalid");
    }
    return withTransaction(pool, async (client) => {
      const updated = await client.query(
        "UPDATE jb_resilience_actions SET status=$2, outcome=$2, completed_at=$3, reason_code=$4 WHERE action_id=$1 AND status='claimed' AND claimed_at <= $3",
        [actionId, outcome, completedAt, reasonCode]
      );
      return updated.rowCount === 1;
    });
  }

  async function recordActionOutcome({
    assetId, environment, action, outcome, at, failureThreshold, cooldownMs
  } = {}) {
    assertInitialized();
    assertAssetId(assetId, "assetId");
    assertIdentifier(environment, "environment");
    assertIdentifier(action, "action");
    assertTimestamp(at, "action outcome timestamp");
    validateOutcomes({ outcome, failureThreshold, cooldownMs });
    if (outcome === "cancelled-before-execution") return true;
    const retryAt = at + cooldownMs;
    if (outcome !== "succeeded" && !Number.isSafeInteger(retryAt)) return false;

    return withTransaction(pool, async (client) => {
      const selected = await client.query(
        "SELECT last_action_at, consecutive_failures FROM jb_resilience_services WHERE environment=$1 AND asset_id=$2 FOR UPDATE",
        [environment, assetId]
      );
      if (selected.rowCount !== 1) return false;
      const current = selected.rows[0];
      const lastActionAt = current.last_action_at === null
        ? null : toSafeInteger(current.last_action_at, "last_action_at");
      if (lastActionAt !== null && at < lastActionAt) return false;

      const consecutiveFailures = toSafeInteger(current.consecutive_failures, "consecutive_failures");
      await client.query(
        "UPDATE jb_resilience_services SET last_action_at=$3, last_outcome=$4, consecutive_failures=$5 WHERE environment=$1 AND asset_id=$2",
        [
          environment, assetId, at, outcome,
          outcome === "succeeded" ? 0 : Math.min(1000, consecutiveFailures + 1)
        ]
      );

      const prior = await client.query(
        "SELECT failure_count FROM jb_resilience_circuits WHERE environment=$1 AND asset_id=$2 AND action=$3 FOR UPDATE",
        [environment, assetId, action]
      );
      const previousFailures = prior.rowCount === 0
        ? 0 : toSafeInteger(prior.rows[0].failure_count, "failure_count");
      const failureCount = outcome === "succeeded"
        ? 0 : Math.min(1_000_000, previousFailures + 1);
      const nextRetryAt = failureCount >= failureThreshold ? retryAt : null;
      await client.query(
        "INSERT INTO jb_resilience_circuits (environment, asset_id, action, failure_count, failure_threshold, cooldown_ms, retry_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (environment, asset_id, action) DO UPDATE SET failure_count=EXCLUDED.failure_count, failure_threshold=EXCLUDED.failure_threshold, cooldown_ms=EXCLUDED.cooldown_ms, retry_at_ms=EXCLUDED.retry_at_ms",
        [environment, assetId, action, failureCount, failureThreshold, cooldownMs, nextRetryAt]
      );
      return true;
    });
  }

  async function appendAudit(entry) {
    assertInitialized();
    const safeEntry = normalizeAuditEntry(entry);
    return withTransaction(pool, async (client) => {
      const verified = await verifyAuditWithClient(client, { lockHead: true });
      const sequence = verified.sequence + 1;
      const record = {
        schema: AUDIT_SCHEMA,
        sequence,
        previousHash: verified.lastHash,
        entry: safeEntry
      };
      const hash = auditRecordHash(record);
      await client.query(
        "INSERT INTO jb_resilience_audit_records (sequence, record_schema, previous_hash, hash, entry) VALUES ($1,$2,$3,$4,$5::jsonb)",
        [sequence, AUDIT_SCHEMA, record.previousHash, hash, JSON.stringify(safeEntry)]
      );
      await client.query(
        "UPDATE jb_resilience_audit_heads SET sequence=$1, last_hash=$2 WHERE head_id=1",
        [sequence, hash]
      );
      return true;
    });
  }

  async function verifyAudit() {
    assertInitialized();
    return withTransaction(pool, async (client) =>
      verifyAuditWithClient(client, { lockHead: false }));
  }

  const orchestrationStore = Object.freeze({
    durable: true,
    distributedTransactions: true,
    recordIncidentState,
    getIncident,
    getServiceState,
    getCircuitState,
    claimAction,
    completeAction,
    recordActionOutcome
  });
  const auditStore = Object.freeze({
    durable: true,
    append: appendAudit,
    verify: verifyAudit
  });

  const coordinationStore = Object.freeze({
    durable: true,
    dialect: "postgresql",
    acquireLease,
    renewLease,
    releaseLease,
    verifyLease
  });
  const fencedTargetStore = Object.freeze({
    durable: true,
    dialect: "postgresql",
    guaranteesAtomicTargetWrites: true,
    applyState: applyFencedState,
    getState: getFencedState
  });

  return Object.freeze({
    durable: true,
    dialect: "postgresql",
    initialize,
    orchestrationStore,
    auditStore,
    coordinationStore,
    fencedTargetStore
  });
}
