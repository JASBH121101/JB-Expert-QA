import { createHash, randomUUID } from "node:crypto";

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
  "CREATE TABLE IF NOT EXISTS jb_resilience_audit_records (sequence BIGINT PRIMARY KEY, schema TEXT NOT NULL, previous_hash CHAR(64) NOT NULL, hash CHAR(64) NOT NULL, entry JSONB NOT NULL)"
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

  async function initialize() {
    await withTransaction(pool, async (client) => {
      for (const statement of SCHEMA_STATEMENTS) await client.query(statement);
      await client.query(
        "INSERT INTO jb_resilience_audit_heads (head_id, sequence, last_hash) VALUES (1, 0, $1) ON CONFLICT (head_id) DO NOTHING",
        [GENESIS_HASH]
      );
    });
    initialized = true;
    return Object.freeze({ initialized: true, dialect: "postgresql", schemaVersion: 1 });
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
        "UPDATE jb_resilience_audit_heads SET sequence=$2, last_hash=$3 WHERE head_id=1",
        [1, sequence, hash]
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

  return Object.freeze({
    durable: true,
    dialect: "postgresql",
    initialize,
    orchestrationStore,
    auditStore
  });
}
