import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createPostgresResilienceStorageAdapter } from "../../packages/resilience-engine/src/adapters/postgres-storage.js";

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

async function runCase(label, operation) {
  await operation();
  process.stdout.write("PASS: " + label + "\n");
}

async function main() {
  assert.throws(() => createPostgresResilienceStorageAdapter(), /pool must provide/);
  await assert.rejects(
    secondStorage.orchestrationStore.getServiceState({ assetId: "host-postgres-01", environment: "test" }),
    /not initialized/
  );
  const initialized = await storage.initialize();
  assert.deepEqual(initialized, { initialized: true, dialect: "postgresql", schemaVersion: 2 });
  await secondStorage.initialize();
  process.stdout.write("PASS: injected Pool and explicit initialization\n");

  await runCase("concurrent lease acquisition, renewal, release and monotonic fencing", async () => {
    const scopeId = "cluster-lab-scope";
    const firstInput = { scopeId, holderId: "host-lab-a", leaseDurationMs: 5_000 };
    const secondInput = { scopeId, holderId: "host-lab-b", leaseDurationMs: 5_000 };
    const [first, second] = await Promise.all([
      storage.coordinationStore.acquireLease(firstInput),
      secondStorage.coordinationStore.acquireLease(secondInput)
    ]);
    assert.equal([first, second].filter((item) => item.acquired).length, 1);
    assert.equal([first, second].filter((item) => !item.acquired && item.reason === "lease-held").length, 1);

    const winner = first.acquired ? first.lease : second.lease;
    const losingStore = first.acquired ? secondStorage.coordinationStore : storage.coordinationStore;
    const winningStore = first.acquired ? storage.coordinationStore : secondStorage.coordinationStore;
    assert.deepEqual(await losingStore.acquireLease(secondInput), {
      acquired: false,
      reason: "lease-held",
      leaseExpiresAt: winner.expiresAt
    });

    const renewed = await winningStore.renewLease({ ...winner, leaseDurationMs: 5_000 });
    assert.equal(renewed.renewed, true);
    assert.ok(renewed.lease.expiresAt >= winner.expiresAt);
    assert.equal((await winningStore.verifyLease(renewed.lease)).valid, true);
    assert.deepEqual(await losingStore.verifyLease({
      ...renewed.lease,
      fencingToken: renewed.lease.fencingToken + 1
    }).then((value) => ({ valid: value.valid, reason: value.reason })), {
      valid: false,
      reason: "lease-not-current"
    });
    assert.equal((await winningStore.releaseLease(renewed.lease)).released, true);
    assert.equal((await winningStore.verifyLease(renewed.lease)).valid, false);

    const successor = await losingStore.acquireLease({
      scopeId,
      holderId: "host-lab-b",
      leaseDurationMs: 5_000
    });
    assert.equal(successor.acquired, true);
    assert.equal(successor.lease.fencingToken, winner.fencingToken + 1);
    assert.equal((await winningStore.verifyLease(winner)).valid, false);
    assert.equal((await losingStore.releaseLease(successor.lease)).released, true);
  });

  await runCase("expired leases cannot renew and successors receive a higher fence", async () => {
    const scopeId = "cluster-expiry-scope";
    const expired = await storage.coordinationStore.acquireLease({
      scopeId,
      holderId: "host-expired",
      leaseDurationMs: 1_000
    });
    assert.equal(expired.acquired, true);
    await delay(1_100);
    assert.deepEqual(await secondStorage.coordinationStore.renewLease({
      ...expired.lease,
      leaseDurationMs: 2_000
    }), { renewed: false, reason: "lease-expired" });
    assert.deepEqual(await secondStorage.coordinationStore.verifyLease(expired.lease).then(
      (value) => ({ valid: value.valid, reason: value.reason })
    ), { valid: false, reason: "lease-expired" });

    const next = await secondStorage.coordinationStore.acquireLease({
      scopeId,
      holderId: "host-successor",
      leaseDurationMs: 3_000
    });
    assert.equal(next.acquired, true);
    assert.equal(next.lease.fencingToken, expired.lease.fencingToken + 1);
    assert.equal((await storage.coordinationStore.verifyLease(expired.lease)).valid, false);
    assert.equal((await secondStorage.coordinationStore.releaseLease(next.lease)).released, true);
  });

  await runCase("transactional incident transitions and identity/time guards", async () => {
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

  await runCase("concurrent idempotency claim across adapter instances", async () => {
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

  await runCase("asset lock blocks competing and expired unresolved actions", async () => {
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

  await runCase("one-time finalization and transactional circuit breaker", async () => {
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

  await runCase("cancelled-before-execution does not change service counters", async () => {
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

  await runCase("hash-chained audit append, verification and tamper detection", async () => {
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
}

try {
  await main();
} finally {
  await pool.end();
}
