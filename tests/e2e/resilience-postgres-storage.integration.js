import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createPostgresResilienceStorageAdapter } from "../../packages/resilience-engine/src/adapters/postgres-storage.js";

const { Pool } = pg;
const connectionString = process.env.QA_DATABASE_URL;
if (!connectionString) throw new Error("QA_DATABASE_URL is required for the PostgreSQL resilience adapter integration test");

const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000 });
const storage = createPostgresResilienceStorageAdapter({ pool });
const secondStorage = createPostgresResilienceStorageAdapter({ pool });

function idempotencyKey({ incidentId, assetId, environment, action, claimedAt }) {
  return createHash("sha256")
    .update(incidentId + ":" + assetId + ":" + environment + ":" + action + ":" + claimedAt)
    .digest("hex");
}

function claim(overrides = {}) {
  const values = {
    incidentId: "incident-postgres-001",
    assetId: "host-postgres-01",
    environment: "test",
    serviceId: "catalog-api",
    action: "restart-service",
    claimedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_030_000,
    ...overrides
  };
  return { ...values, idempotencyKey: idempotencyKey(values) };
}

function incident(state, overrides = {}) {
  return {
    incidentId: "incident-postgres-001",
    assetId: "host-postgres-01",
    environment: "test",
    serviceId: "catalog-api",
    state,
    decision: "review-recovery-policy",
    decisionRule: "HEALTH_FAILURE_THRESHOLD",
    reasonCode: "TEST",
    at: 1_800_000_000_000,
    ...overrides
  };
}

test("PostgreSQL resilience storage requires an injected Pool and explicit initialization", async () => {
  assert.throws(() => createPostgresResilienceStorageAdapter(), /pool must provide connect/);
  await assert.rejects(
    secondStorage.orchestrationStore.getServiceState({ assetId: "host-postgres-01", environment: "test" }),
    /not initialized/
  );
  const result = await storage.initialize();
  assert.deepEqual(result, { initialized: true, dialect: "postgresql", schemaVersion: 1 });
  await secondStorage.initialize();
});

test("transactional incident ledger accepts legal transitions and rejects asset/time conflicts", async () => {
  const store = storage.orchestrationStore;
  assert.equal(await store.recordIncidentState(incident("OBSERVING")), true);
  assert.equal(await store.recordIncidentState(incident("EXECUTING", { at: 1_800_000_000_010 })), true);
  assert.equal(await store.recordIncidentState(incident("VERIFYING", { at: 1_800_000_000_020 })), true);
  assert.equal(await store.recordIncidentState(incident("RECOVERED", { at: 1_800_000_000_030 })), true);
  assert.equal(await store.recordIncidentState(incident("EXECUTING", { at: 1_800_000_000_040 })), false);
  assert.equal(await store.recordIncidentState(incident("HELD", {
    assetId: "different-host",
    at: 1_800_000_000_040
  })), false);
  assert.equal(await store.recordIncidentState(incident("OBSERVING", { at: 1_800_000_000_029 })), false);
  const persisted = await store.getIncident("incident-postgres-001");
  assert.equal(persisted.state, "RECOVERED");
  assert.equal(persisted.updatedAt, 1_800_000_000_030);
});

test("concurrent idempotency claims across adapter instances permit exactly one claim", async () => {
  const input = claim();
  const [first, second] = await Promise.all([
    storage.orchestrationStore.claimAction(input),
    secondStorage.orchestrationStore.claimAction(input)
  ]);
  assert.equal([first, second].filter((value) => value.claimed).length, 1);
  assert.equal([first, second].filter((value) => !value.claimed).length, 1);
  assert.ok([first, second].some((value) => value.reason === "idempotency-key-already-claimed"));
  const state = await storage.orchestrationStore.getServiceState({
    assetId: input.assetId,
    environment: input.environment
  });
  assert.equal(state.lastActionAt, null);
});

test("per-asset transaction lock blocks competing and expired unresolved actions", async () => {
  const store = storage.orchestrationStore;
  const first = claim({
    incidentId: "incident-postgres-asset-lock",
    assetId: "host-postgres-lock",
    claimedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_030_000
  });
  assert.equal((await store.claimAction(first)).claimed, true);

  const competing = claim({
    incidentId: "incident-postgres-asset-lock-2",
    assetId: first.assetId,
    claimedAt: first.claimedAt + 1,
    expiresAt: first.expiresAt + 30_000
  });
  assert.deepEqual(await store.claimAction(competing), {
    claimed: false,
    reason: "asset-action-already-in-progress"
  });

  const expired = claim({
    incidentId: "incident-postgres-asset-lock-3",
    assetId: first.assetId,
    claimedAt: first.expiresAt + 1,
    expiresAt: first.expiresAt + 30_001
  });
  assert.deepEqual(await store.claimAction(expired), {
    claimed: false,
    reason: "action-reconciliation-required"
  });

  const otherEnvironment = claim({
    incidentId: "incident-postgres-asset-lock-4",
    assetId: first.assetId,
    environment: "staging",
    claimedAt: first.claimedAt + 2,
    expiresAt: first.expiresAt + 30_002
  });
  assert.equal((await store.claimAction(otherEnvironment)).claimed, true);
});

test("action completion is one-time and circuit-breaker state is transactional", async () => {
  const store = storage.orchestrationStore;
  const input = claim({
    incidentId: "incident-postgres-circuit",
    assetId: "host-postgres-circuit"
  });
  const claimed = await store.claimAction(input);
  assert.equal(claimed.claimed, true);
  assert.equal(await store.completeAction({
    actionId: claimed.actionId,
    outcome: "unverified",
    completedAt: input.claimedAt + 1,
    reasonCode: "UNVERIFIED"
  }), true);
  assert.equal(await store.completeAction({
    actionId: claimed.actionId,
    outcome: "succeeded",
    completedAt: input.claimedAt + 2,
    reasonCode: "SECOND_FINALIZATION"
  }), false);
  assert.equal(await store.recordActionOutcome({
    assetId: input.assetId,
    environment: input.environment,
    action: input.action,
    outcome: "unverified",
    at: input.claimedAt + 1,
    failureThreshold: 1,
    cooldownMs: 60_000
  }), true);

  const service = await store.getServiceState({
    assetId: input.assetId,
    environment: input.environment
  });
  assert.equal(service.lastActionAt, input.claimedAt + 1);
  assert.equal(service.consecutiveFailures, 1);

  const circuit = await store.getCircuitState({
    assetId: input.assetId,
    environment: input.environment,
    action: input.action,
    now: input.claimedAt + 2
  });
  assert.equal(circuit.open, true);
  assert.equal(circuit.retryAtMs, input.claimedAt + 60_001);
});

test("cancelled-before-execution preserves service and circuit counters", async () => {
  const store = storage.orchestrationStore;
  const input = claim({
    incidentId: "incident-postgres-cancel",
    assetId: "host-postgres-cancel"
  });
  const claimed = await store.claimAction(input);
  assert.equal(claimed.claimed, true);
  assert.equal(await store.completeAction({
    actionId: claimed.actionId,
    outcome: "cancelled-before-execution",
    completedAt: input.claimedAt + 1,
    reasonCode: "STOP_SWITCH"
  }), true);
  assert.equal(await store.recordActionOutcome({
    assetId: input.assetId,
    environment: input.environment,
    action: input.action,
    outcome: "cancelled-before-execution",
    at: input.claimedAt + 1,
    failureThreshold: 2,
    cooldownMs: 60_000
  }), true);
  const service = await store.getServiceState({
    assetId: input.assetId,
    environment: input.environment
  });
  assert.equal(service.lastActionAt, null);
  assert.equal(service.consecutiveFailures, 0);
});

test("PostgreSQL audit store appends atomic hash-chained events and detects tampering", async () => {
  const audit = storage.auditStore;
  assert.equal(await audit.append({ event: "incident-evaluated", incidentId: "incident-postgres-001" }), true);
  assert.equal(await audit.append({ event: "action-authorized", action: "restart-service" }), true);
  const verified = await audit.verify();
  assert.equal(verified.valid, true);
  assert.equal(verified.sequence, 2);
  assert.match(verified.lastHash, /^[a-f0-9]{64}$/);

  await pool.query(
    "UPDATE jb_resilience_audit_records SET entry = jsonb_set(entry, '{event}', '\"tampered\"'::jsonb) WHERE sequence = 1"
  );
  await assert.rejects(audit.verify(), /integrity verification failed/);
  await assert.rejects(audit.append({ event: "must-not-append" }), /integrity verification failed/);
});

try {
  await storage.initialize();
  await secondStorage.initialize();
  await test.run();
} finally {
  await pool.end();
}
