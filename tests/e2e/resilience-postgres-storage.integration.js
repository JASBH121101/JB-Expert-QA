import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import {
  createPostgresResilienceStorageAdapter,
  createPostgresA2ActionLedger
} from "../../packages/resilience-engine/src/adapters/postgres-storage.js";
import {
  createTrustedSignalGateway,
  signTrustedSignalEnvelope
} from "../../packages/resilience-engine/src/trusted-signal-gateway.js";

const connectionString = process.env.QA_DATABASE_URL;
if (!connectionString) throw new Error("QA_DATABASE_URL is required for the PostgreSQL resilience adapter integration test");

const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000 });
const a2SecondaryPool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000 });
const storage = createPostgresResilienceStorageAdapter({ pool });
const secondStorage = createPostgresResilienceStorageAdapter({ pool });

function idempotencyKey({ incidentId, assetId, environment, action, claimedAt }) {
  return createHash("sha256")
    .update(incidentId + ":" + assetId + ":" + environment + ":" + action + ":" + claimedAt)
    .digest("hex");
}

function fencedInput(lease, fields) {
  return {
    scopeId: lease.scopeId,
    holderId: lease.holderId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    ...fields
  };
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

function canonicalA2(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalA2).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalA2(value[key])
  ).join(",") + "}";
}

function a2Scope(assetId, incidentId) {
  return {
    assetId,
    environment: "lab",
    incidentId,
    policyId: "a2-policy-lab",
    policyRevision: 3,
    policyHash: "a".repeat(64)
  };
}

function a2Key(action, scope, profileId) {
  return createHash("sha256").update(canonicalA2({
    schema: "jb.resilience.a2-operation-key/v1",
    action, scope, profileId
  }), "utf8").digest("hex");
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
  assert.deepEqual(initialized, { initialized: true, dialect: "postgresql", schemaVersion: 4 });
  await secondStorage.initialize();
  process.stdout.write("PASS: injected Pool and explicit initialization\n");

  const a2Identities = {
    providerId: "pg-a2-provider",
    verifierId: "pg-a2-independent-verifier",
    recorderId: "pg-a2-forensic-recorder"
  };
  const a2First = createPostgresA2ActionLedger({ pool, ...a2Identities });
  const a2Second = createPostgresA2ActionLedger({ pool: a2SecondaryPool, ...a2Identities });
  assert.throws(() => createPostgresA2ActionLedger({
    pool, ...a2Identities, connectionTimeoutMs: 50
  }), /connectionTimeoutMs is invalid/);
  assert.throws(() => createPostgresA2ActionLedger({
    pool, ...a2Identities, statementTimeoutMs: 50
  }), /statementTimeoutMs is invalid/);
  assert.throws(() => createPostgresA2ActionLedger({
    pool, ...a2Identities, lockTimeoutMs: 0
  }), /lockTimeoutMs is invalid/);
  await assert.rejects(
    a2Second.listPending({ cursor: null, limit: 10, atMs: 1_800_000_000_000 }),
    /not initialized/
  );
  assert.deepEqual(await a2First.initialize(), {
    initialized: true, dialect: "postgresql", schemaVersion: 1
  });
  assert.deepEqual(await a2Second.initialize(), {
    initialized: true, dialect: "postgresql", schemaVersion: 1
  });

  await runCase("PostgreSQL A2 Pool connection wait timeout releases a late client", async () => {
    let lateClientReleased = 0;
    const lateConnectionPool = {
      query: async () => { throw new Error("late Pool client should not execute SQL"); },
      connect: () => new Promise((resolve) => setTimeout(() => resolve({
        query: async () => { throw new Error("late Pool client should not execute SQL"); },
        release: () => { lateClientReleased += 1; }
      }), 150))
    };
    const boundedConnectionLedger = createPostgresA2ActionLedger({
      pool: lateConnectionPool,
      ...a2Identities,
      connectionTimeoutMs: 100
    });
    await assert.rejects(
      boundedConnectionLedger.initialize(),
      /Pool connection wait timed out/
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(lateClientReleased, 1);
  });

  await runCase("PostgreSQL A2 ledger serializes unique claims across adapter instances", async () => {
    const scope = a2Scope("pg-a2-claim-race", "pg-a2-incident-race");
    const profileId = "approved-a2-profile";
    const action = "apply-containment-profile";
    const idempotency = a2Key(action, scope, profileId);
    const input = {
      action, scope, profileId, idempotencyKey: idempotency,
      claimedAtMs: 1_800_000_000_000,
      expiresAtMs: 1_800_000_030_000
    };
    const [left, right] = await Promise.all([
      a2First.claim(input),
      a2Second.claim(input)
    ]);
    assert.equal([left, right].filter((value) => value.claimed).length, 1);
    assert.equal([left, right].filter((value) => !value.claimed).length, 1);
    const winner = left.claimed ? left : right;
    const competingScope = { ...scope, incidentId: "pg-a2-incident-race-2" };
    const competingKey = a2Key(action, competingScope, profileId);
    assert.deepEqual(await a2Second.claim({
      action, scope: competingScope, profileId, idempotencyKey: competingKey,
      claimedAtMs: input.claimedAtMs + 1,
      expiresAtMs: input.expiresAtMs + 1
    }), { claimed: false, claimId: null });
    assert.deepEqual(await a2Second.getPendingByClaimId({
      claimId: winner.claimId, atMs: input.claimedAtMs + 1
    }), { found: false, record: null });
    const orphanPage = await a2Second.listPending({
      cursor: null, limit: 10, atMs: input.claimedAtMs + 1
    });
    assert.ok(orphanPage.claimIds.includes(winner.claimId));
    assert.deepEqual(await a2First.reconcile({
      action, scope, profileId, idempotencyKey: idempotency,
      atMs: input.claimedAtMs + 1
    }), { state: "claimed", claimId: winner.claimId });
  });

  await runCase("PostgreSQL A2 pending record and provider-start transition survive another adapter instance", async () => {
    const scope = a2Scope("pg-a2-lifecycle", "pg-a2-incident-lifecycle");
    const profileId = "approved-a2-profile";
    const action = "apply-containment-profile";
    const idempotencyKey = a2Key(action, scope, profileId);
    const claimedAtMs = 1_800_000_100_000;
    const claim = await a2First.claim({
      action, scope, profileId, idempotencyKey,
      claimedAtMs, expiresAtMs: claimedAtMs + 30_000
    });
    assert.equal(claim.claimed, true);
    const evidenceRefs = [{
      refId: "pg-a2-evidence-01",
      sha256: createHash("sha256").update("postgres A2 evidence").digest("hex")
    }];
    const record = {
      schema: "jb.resilience.a2-recovery-record/v1",
      claimId: claim.claimId,
      action, scope, profileId,
      ...a2Identities,
      idempotencyKey,
      state: "claimed",
      originalOperationId: null,
      evidenceRefs,
      createdAtMs: claimedAtMs + 1,
      updatedAtMs: claimedAtMs + 1,
      leaseExpiresAtMs: claimedAtMs + 20_000
    };
    assert.deepEqual(await a2First.createPendingRecord({
      record, atMs: record.createdAtMs
    }), { created: true });
    const pendingPage = await a2Second.listPending({
      cursor: null, limit: 10, atMs: record.createdAtMs + 1
    });
    assert.ok(pendingPage.claimIds.includes(claim.claimId));
    assert.equal(pendingPage.nextCursor, null);
    assert.deepEqual(await a2Second.getPendingByClaimId({
      claimId: claim.claimId, atMs: record.createdAtMs + 1
    }), { found: true, record });

    const startedAtMs = record.createdAtMs + 1;
    const startedRecord = {
      ...record, state: "provider-started", updatedAtMs: startedAtMs
    };
    assert.deepEqual(await a2Second.markProviderStarted({
      claimId: claim.claimId, action, scope, profileId, idempotencyKey,
      recoveryRecord: startedRecord, atMs: startedAtMs
    }), { started: true });
    const observed = await a2First.getPendingByClaimId({
      claimId: claim.claimId, atMs: startedAtMs + 1
    });
    assert.deepEqual(observed, { found: true, record: startedRecord });
    assert.deepEqual(await a2First.reconcile({
      action, scope, profileId, idempotencyKey, atMs: startedAtMs + 1
    }), { state: "provider-started", claimId: claim.claimId });

    assert.deepEqual(await a2First.complete({
      claimId: claim.claimId, outcome: "held-for-reconciliation",
      reason: "restart-lab-hold", completedAtMs: startedAtMs + 2
    }), { completed: true });
    const held = await a2Second.getPendingByClaimId({
      claimId: claim.claimId, atMs: startedAtMs + 3
    });
    assert.equal(held.found, true);
    assert.equal(held.record.state, "held-for-reconciliation");

    assert.deepEqual(await a2Second.complete({
      claimId: claim.claimId,
      outcome: "not-applied",
      reason: "provider-confirmed-not-applied",
      completedAtMs: startedAtMs + 5
    }), { completed: false });
    const wrongProviderProof = {
      schema: "jb.resilience.a2-provider-non-application/v1",
      providerId: "spoofed-pg-provider",
      action, scope, profileId, idempotencyKey,
      outcome: "not-applied",
      observedAtMs: startedAtMs + 4
    };
    assert.deepEqual(await a2Second.complete({
      claimId: claim.claimId,
      outcome: "not-applied",
      reason: "provider-confirmed-not-applied",
      completedAtMs: startedAtMs + 5,
      providerReconciliation: wrongProviderProof
    }), { completed: false });
    const proof = {
      schema: "jb.resilience.a2-provider-non-application/v1",
      providerId: a2Identities.providerId,
      action, scope, profileId, idempotencyKey,
      outcome: "not-applied",
      observedAtMs: startedAtMs + 4
    };
    assert.deepEqual(await a2Second.complete({
      claimId: claim.claimId,
      outcome: "not-applied",
      reason: "provider-confirmed-not-applied",
      completedAtMs: startedAtMs + 5,
      providerReconciliation: proof
    }), { completed: true });
    assert.deepEqual(await a2First.getPendingByClaimId({
      claimId: claim.claimId, atMs: startedAtMs + 6
    }), { found: false, record: null });
    assert.deepEqual(await a2First.claim({
      action, scope, profileId, idempotencyKey,
      claimedAtMs: startedAtMs + 7, expiresAtMs: startedAtMs + 30_000
    }), { claimed: false, claimId: null });
  });

  await runCase("PostgreSQL A2 pending journal uses bounded stable keyset pagination under concurrent claims", async () => {
    const inputs = Array.from({ length: 3 }, (_, index) => {
      const scope = a2Scope(
        "pg-a2-page-" + String(index + 1),
        "pg-a2-page-incident-" + String(index + 1)
      );
      const profileId = "approved-a2-profile";
      const action = "apply-containment-profile";
      return {
        action, scope, profileId,
        idempotencyKey: a2Key(action, scope, profileId),
        claimedAtMs: 1_800_000_250_000 + index,
        expiresAtMs: 1_800_000_280_000 + index
      };
    });
    const claimResults = await Promise.all(inputs.map((input, index) =>
      (index % 2 === 0 ? a2First : a2Second).claim(input)
    ));
    assert.equal(claimResults.every((result) => result.claimed), true);
    const created = claimResults.map((result) => result.claimId);
    const first = await a2First.listPending({
      cursor: null, limit: 2, atMs: 1_800_000_250_100
    });
    assert.equal(first.claimIds.length, 2);
    assert.ok(first.nextCursor);
    const second = await a2Second.listPending({
      cursor: first.nextCursor, limit: 2, atMs: 1_800_000_250_100
    });
    assert.ok(second.claimIds.length >= 1);
    const all = [...first.claimIds, ...second.claimIds];
    assert.equal(new Set(all).size, all.length);
    for (const claimId of created) assert.ok(all.includes(claimId));
    assert.equal(second.nextCursor, null);
  });

  await runCase("PostgreSQL A2 lock timeout releases a contended asset claim", async () => {
    const scope = a2Scope("pg-a2-lock-timeout", "pg-a2-incident-lock-timeout");
    const profileId = "approved-a2-profile";
    const action = "apply-containment-profile";
    const idempotencyKey = a2Key(action, scope, profileId);
    const claimedAtMs = 1_800_000_325_000;
    const input = {
      action, scope, profileId, idempotencyKey,
      claimedAtMs, expiresAtMs: claimedAtMs + 30_000
    };
    const boundedLedger = createPostgresA2ActionLedger({
      pool: a2SecondaryPool,
      ...a2Identities,
      statementTimeoutMs: 2_000,
      lockTimeoutMs: 100,
      idleInTransactionTimeoutMs: 2_000
    });
    await boundedLedger.initialize();
    const locker = await pool.connect();
    let locked = false;
    try {
      await locker.query("BEGIN");
      locked = true;
      await locker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [canonicalA2([scope.environment, scope.assetId])]
      );
      await assert.rejects(
        boundedLedger.claim(input),
        (error) => error && error.code === "55P03"
      );
    } finally {
      if (locked) await locker.query("ROLLBACK").catch(() => {});
      locker.release();
    }
    const retriedAfterLockRelease = await a2First.claim(input);
    assert.equal(retriedAfterLockRelease.claimed, true);
    assert.deepEqual(await a2Second.complete({
      claimId: retriedAfterLockRelease.claimId,
      outcome: "not-applied",
      reason: "no-provider-call-made",
      completedAtMs: claimedAtMs + 1
    }), { completed: true });
  });

  await runCase("PostgreSQL A2 server statement timeout releases a blocked row lock", async () => {
    const scope = a2Scope("pg-a2-timeout", "pg-a2-incident-timeout");
    const profileId = "approved-a2-profile";
    const action = "apply-containment-profile";
    const idempotencyKey = a2Key(action, scope, profileId);
    const claimedAtMs = 1_800_000_350_000;
    const claim = await a2First.claim({
      action, scope, profileId, idempotencyKey,
      claimedAtMs, expiresAtMs: claimedAtMs + 30_000
    });
    assert.equal(claim.claimed, true);
    const record = {
      schema: "jb.resilience.a2-recovery-record/v1",
      claimId: claim.claimId,
      action, scope, profileId,
      ...a2Identities,
      idempotencyKey,
      state: "claimed",
      originalOperationId: null,
      evidenceRefs: [{
        refId: "pg-a2-timeout-evidence",
        sha256: createHash("sha256").update("timeout evidence").digest("hex")
      }],
      createdAtMs: claimedAtMs + 1,
      updatedAtMs: claimedAtMs + 1,
      leaseExpiresAtMs: claimedAtMs + 20_000
    };
    assert.deepEqual(await a2First.createPendingRecord({
      record, atMs: record.createdAtMs
    }), { created: true });
    const startedAtMs = record.createdAtMs + 1;
    assert.deepEqual(await a2First.markProviderStarted({
      claimId: claim.claimId, action, scope, profileId, idempotencyKey,
      recoveryRecord: { ...record, state: "provider-started", updatedAtMs: startedAtMs },
      atMs: startedAtMs
    }), { started: true });

    const boundedLedger = createPostgresA2ActionLedger({
      pool: a2SecondaryPool,
      ...a2Identities,
      statementTimeoutMs: 100,
      lockTimeoutMs: 1_000,
      idleInTransactionTimeoutMs: 2_000
    });
    await boundedLedger.initialize();
    const locker = await pool.connect();
    let locked = false;
    try {
      await locker.query("BEGIN");
      locked = true;
      await locker.query(
        "SELECT claim_id FROM jb_resilience_a2_action_claims WHERE claim_id=$1 FOR UPDATE",
        [claim.claimId]
      );
      await assert.rejects(
        boundedLedger.complete({
          claimId: claim.claimId,
          outcome: "held-for-reconciliation",
          reason: "timeout-lab",
          completedAtMs: startedAtMs + 2
        }),
        (error) => error && error.code === "57014"
      );
    } finally {
      if (locked) await locker.query("ROLLBACK").catch(() => {});
      locker.release();
    }
    const stillPending = await a2First.getPendingByClaimId({
      claimId: claim.claimId, atMs: startedAtMs + 3
    });
    assert.equal(stillPending.found, true);
    assert.equal(stillPending.record.state, "provider-started");
  });

  await runCase("PostgreSQL A2 altered recovery JSONB fails closed on exact read and finalization", async () => {
    const scope = a2Scope("pg-a2-tamper", "pg-a2-incident-tamper");
    const profileId = "approved-a2-profile";
    const action = "apply-containment-profile";
    const idempotencyKey = a2Key(action, scope, profileId);
    const claimedAtMs = 1_800_000_300_000;
    const claim = await a2First.claim({
      action, scope, profileId, idempotencyKey,
      claimedAtMs, expiresAtMs: claimedAtMs + 30_000
    });
    assert.equal(claim.claimed, true);
    const record = {
      schema: "jb.resilience.a2-recovery-record/v1",
      claimId: claim.claimId,
      action, scope, profileId,
      ...a2Identities,
      idempotencyKey,
      state: "claimed",
      originalOperationId: null,
      evidenceRefs: [{
        refId: "pg-a2-tamper-evidence",
        sha256: createHash("sha256").update("integrity evidence").digest("hex")
      }],
      createdAtMs: claimedAtMs + 1,
      updatedAtMs: claimedAtMs + 1,
      leaseExpiresAtMs: claimedAtMs + 20_000
    };
    assert.deepEqual(await a2First.createPendingRecord({
      record, atMs: record.createdAtMs
    }), { created: true });
    const startedAtMs = record.createdAtMs + 1;
    assert.deepEqual(await a2First.markProviderStarted({
      claimId: claim.claimId, action, scope, profileId, idempotencyKey,
      recoveryRecord: { ...record, state: "provider-started", updatedAtMs: startedAtMs },
      atMs: startedAtMs
    }), { started: true });
    await pool.query(
      "UPDATE jb_resilience_a2_action_claims SET recovery_record=jsonb_set(recovery_record, '{providerId}', to_jsonb($2::text)) WHERE claim_id=$1",
      [claim.claimId, "tampered-provider"]
    );
    await assert.rejects(a2Second.getPendingByClaimId({
      claimId: claim.claimId, atMs: startedAtMs + 1
    }), /identities do not match/);
    assert.deepEqual(await a2Second.complete({
      claimId: claim.claimId,
      outcome: "succeeded",
      reason: null,
      completedAtMs: startedAtMs + 2
    }), { completed: false });
    assert.deepEqual(await a2Second.complete({
      claimId: claim.claimId,
      outcome: "held-for-reconciliation",
      reason: "tampered-record",
      completedAtMs: startedAtMs + 2
    }), { completed: false });
  });

  await runCase("PostgreSQL A2 pre-provider claims remain held and expiry blocks provider start", async () => {
    const scope = a2Scope("pg-a2-expiry", "pg-a2-incident-expiry");
    const profileId = "approved-a2-profile";
    const action = "release-containment";
    const idempotencyKey = a2Key(action, scope, profileId);
    const claimedAtMs = 1_800_000_200_000;
    const claim = await a2First.claim({
      action, scope, profileId, idempotencyKey,
      claimedAtMs, expiresAtMs: claimedAtMs + 5
    });
    assert.equal(claim.claimed, true);
    const record = {
      schema: "jb.resilience.a2-recovery-record/v1",
      claimId: claim.claimId,
      action, scope, profileId,
      ...a2Identities,
      idempotencyKey,
      state: "claimed",
      originalOperationId: "pg-original-containment-op",
      evidenceRefs: [{
        refId: "pg-a2-release-evidence",
        sha256: createHash("sha256").update("release evidence").digest("hex")
      }],
      createdAtMs: claimedAtMs + 1,
      updatedAtMs: claimedAtMs + 1,
      leaseExpiresAtMs: claimedAtMs + 20_000
    };
    assert.deepEqual(await a2First.createPendingRecord({
      record, atMs: record.createdAtMs
    }), { created: true });
    const staleMarker = {
      ...record, state: "provider-started", updatedAtMs: claimedAtMs + 6
    };
    assert.deepEqual(await a2Second.markProviderStarted({
      claimId: claim.claimId, action, scope, profileId, idempotencyKey,
      recoveryRecord: staleMarker, atMs: claimedAtMs + 6
    }), { started: false });
    assert.deepEqual(await a2Second.complete({
      claimId: claim.claimId, outcome: "held-for-reconciliation",
      reason: "pre-marker-restart", completedAtMs: claimedAtMs + 7
    }), { completed: true });
    const page = await a2First.listPending({
      cursor: null, limit: 10, atMs: claimedAtMs + 8
    });
    assert.ok(page.claimIds.includes(claim.claimId));
    const held = await a2Second.getPendingByClaimId({
      claimId: claim.claimId, atMs: claimedAtMs + 8
    });
    assert.equal(held.found, true);
    assert.equal(held.record.state, "claimed");
  });

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


  await runCase("fenced PostgreSQL targets reject stale epochs and duplicate mutation IDs", async () => {
    const scopeId = "fenced-target-scope";
    const targetId = "catalog-state-record";
    const firstLease = await storage.coordinationStore.acquireLease({
      scopeId, holderId: "target-holder-a", leaseDurationMs: 5_000
    });
    assert.equal(firstLease.acquired, true);
    const firstState = { status: "ready", revision: 1 };
    const firstApplied = await storage.fencedTargetStore.applyState(
      fencedInput(firstLease.lease, { targetId, mutationId: "mutation-001", state: firstState })
    );
    assert.equal(firstApplied.applied, true);
    assert.equal(firstApplied.fencingToken, firstLease.lease.fencingToken);
    assert.deepEqual(await secondStorage.fencedTargetStore.applyState(
      fencedInput(firstLease.lease, { targetId, mutationId: "mutation-001", state: firstState })
    ), { applied: false, reason: "duplicate-mutation" });
    assert.deepEqual(await storage.fencedTargetStore.applyState({
      ...fencedInput(firstLease.lease, { targetId, mutationId: "mutation-001",
      state: { status: "tampered", revision: 99 } })
    }), { applied: false, reason: "mutation-id-conflict" });

    assert.equal((await storage.fencedTargetStore.applyState({
      ...fencedInput(firstLease.lease, { targetId, mutationId: "mutation-002",
      state: { status: "ready", revision: 2 } })
    })).applied, true);
    assert.equal((await storage.coordinationStore.releaseLease(firstLease.lease)).released, true);

    const successor = await secondStorage.coordinationStore.acquireLease({
      scopeId, holderId: "target-holder-b", leaseDurationMs: 5_000
    });
    assert.equal(successor.acquired, true);
    assert.equal(successor.lease.fencingToken, firstLease.lease.fencingToken + 1);
    assert.equal((await secondStorage.fencedTargetStore.applyState({
      ...fencedInput(successor.lease, { targetId, mutationId: "mutation-003",
      state: { status: "recovered", revision: 3 } })
    })).applied, true);

    const beforeStaleWrite = await storage.fencedTargetStore.getState({ scopeId, targetId });
    assert.deepEqual({ ...beforeStaleWrite.state }, { status: "recovered", revision: 3 });
    assert.deepEqual(await storage.fencedTargetStore.applyState({
      ...fencedInput(firstLease.lease, { targetId, mutationId: "mutation-stale",
      state: { status: "stale-overwrite", revision: 4 } })
    }), { applied: false, reason: "lease-not-current" });
    assert.deepEqual({ ...(await storage.fencedTargetStore.getState({ scopeId, targetId })).state },
      { status: "recovered", revision: 3 });

    const highWaterScope = "fenced-highwater-scope";
    const highWaterLease = await storage.coordinationStore.acquireLease({
      scopeId: highWaterScope, holderId: "highwater-holder", leaseDurationMs: 5_000
    });
    assert.equal(highWaterLease.acquired, true);
    await storage.fencedTargetStore.applyState({
      ...fencedInput(highWaterLease.lease, { targetId: "highwater-target", mutationId: "highwater-init",
      state: { version: "initial" } })
    });
    await pool.query(
      "UPDATE jb_resilience_fenced_targets SET fencing_token=$3 WHERE scope_id=$1 AND target_id=$2",
      [highWaterScope, "highwater-target", highWaterLease.lease.fencingToken + 1]
    );
    assert.deepEqual(await storage.fencedTargetStore.applyState({
      ...fencedInput(highWaterLease.lease, { targetId: "highwater-target", mutationId: "highwater-stale",
      state: { version: "must-not-apply" } })
    }), {
      applied: false,
      reason: "stale-fencing-token",
      currentFencingToken: highWaterLease.lease.fencingToken + 1
    });
    assert.deepEqual({ ...(await storage.fencedTargetStore.getState({
      scopeId: highWaterScope, targetId: "highwater-target"
    })).state }, { version: "initial" });
    await secondStorage.coordinationStore.releaseLease(successor.lease);
    await storage.coordinationStore.releaseLease(highWaterLease.lease);
  });


  await runCase("PostgreSQL trusted signal store enforces cross-instance replay and integrity", async () => {
    const issuedAtMs = 1_800_000_000_000;
    const key = "ci-only-multi-host-trusted-signal-key";
    const sources = [{
      sourceId: "malware-ci",
      engine: "malware-engine",
      environment: "test",
      assetIds: ["host-postgres-01"],
      key
    }];
    const clock = () => issuedAtMs + 1_000;
    const firstGateway = createTrustedSignalGateway({
      sources, replayStore: storage.trustedSignalStore, clock
    });
    const secondGateway = createTrustedSignalGateway({
      sources, replayStore: secondStorage.trustedSignalStore, clock
    });
    const signal = signTrustedSignalEnvelope({
      schema: "jb.resilience.trusted-signal/v1",
      eventId: "3d6f12c0-129a-4f80-8af1-2a02f1edb001",
      sourceId: "malware-ci",
      sourceEngine: "malware-engine",
      environment: "test",
      assetId: "host-postgres-01",
      issuedAtMs,
      expiresAtMs: issuedAtMs + 120_000,
      state: "confirmed",
      severity: "critical",
      reasonCode: "MALWARE_VERIFIED",
      evidenceRefs: [{
        refId: "artifact:incident-001",
        sha256: "a".repeat(64)
      }]
    }, key);

    const ingested = await Promise.all([
      firstGateway.ingest(signal),
      secondGateway.ingest(signal)
    ]);
    assert.equal(ingested.filter((item) => item.accepted).length, 1);
    assert.equal(ingested.filter((item) => item.reason === "signal-replay").length, 1);

    const records = await secondStorage.trustedSignalStore.listSignals({
      assetId: "host-postgres-01", environment: "test", sinceMs: issuedAtMs
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].signal.eventId, signal.eventId);
    assert.equal(records[0].signalDigest.length, 64);
    assert.equal(records[0].retentionUntilMs >= signal.expiresAtMs, true);

    const state = await secondGateway.getSecurityState({
      assetId: "host-postgres-01", environment: "test"
    });
    assert.equal(state.state, "confirmed");
    assert.equal(state.authorizationGranted, false);
    assert.equal(state.preserveEvidence, true);

    const conflictingSignal = signTrustedSignalEnvelope({
      schema: signal.schema,
      eventId: signal.eventId,
      sourceId: signal.sourceId,
      sourceEngine: signal.sourceEngine,
      environment: signal.environment,
      assetId: signal.assetId,
      issuedAtMs: signal.issuedAtMs,
      expiresAtMs: signal.expiresAtMs,
      state: signal.state,
      severity: signal.severity,
      reasonCode: "DIFFERENT_VERDICT",
      evidenceRefs: signal.evidenceRefs
    }, key);
    const conflict = await firstGateway.ingest(conflictingSignal);
    assert.deepEqual(conflict, { accepted: false, reason: "signal-id-conflict" });

    await pool.query(
      "UPDATE jb_resilience_trusted_signals SET signal=jsonb_set(signal, '{reasonCode}', to_jsonb('TAMPERED'::text)) WHERE source_id=$1 AND event_id=$2",
      ["malware-ci", signal.eventId]
    );
    await assert.rejects(secondStorage.trustedSignalStore.listSignals({
      assetId: "host-postgres-01", environment: "test", sinceMs: issuedAtMs
    }), /integrity check failed/);

    await pool.query(
      "UPDATE jb_resilience_trusted_signal_capacity SET record_count=max_records WHERE capacity_id=1"
    );
    const capacitySignal = signTrustedSignalEnvelope({
      schema: signal.schema,
      eventId: "3d6f12c0-129a-4f80-8af1-2a02f1edb002",
      sourceId: signal.sourceId,
      sourceEngine: signal.sourceEngine,
      environment: signal.environment,
      assetId: signal.assetId,
      issuedAtMs,
      expiresAtMs: issuedAtMs + 120_000,
      state: "confirmed",
      severity: "critical",
      reasonCode: "MALWARE_VERIFIED",
      evidenceRefs: signal.evidenceRefs
    }, key);
    assert.deepEqual(await firstGateway.ingest(capacitySignal), {
      accepted: false,
      reason: "replay-store-capacity-exceeded"
    });
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
  await Promise.all([pool.end(), a2SecondaryPool.end()]);
}
