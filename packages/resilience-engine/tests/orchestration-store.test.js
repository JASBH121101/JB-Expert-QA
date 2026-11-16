import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileAuditStore,
  createFileOrchestrationStore
} from "../src/orchestration-store.js";

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "jb-resilience-v06-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function incidentState(state, overrides = {}) {
  return {
    incidentId: "incident-001",
    assetId: "host-erp-01",
    environment: "production",
    serviceId: "catalog-api",
    state,
    decision: "review-recovery-policy",
    decisionRule: "HEALTH_FAILURE_THRESHOLD",
    reasonCode: "TEST",
    at: 1_800_000_000_000,
    ...overrides
  };
}

function claimAction(overrides = {}) {
  const values = {
    incidentId: "incident-001",
    assetId: "host-erp-01",
    environment: "production",
    serviceId: "catalog-api",
    action: "restart-service",
    claimedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_030_000,
    ...overrides
  };
  return {
    ...values,
    idempotencyKey: createHash("sha256")
      .update(values.incidentId + ":" + values.assetId + ":" + values.environment + ":" + values.action + ":" + values.claimedAt)
      .digest("hex")
  };
}

test("file orchestration store persists legal incident state transitions", async () => {
  await withTempDirectory(async (directory) => {
    const store = createFileOrchestrationStore({ filePath: join(directory, "orchestration.json") });

    assert.equal(store.durable, true);
    assert.equal(await store.recordIncidentState(incidentState("OBSERVING")), true);
    assert.equal(await store.recordIncidentState(incidentState("EXECUTING", { at: 1_800_000_000_010 })), true);
    assert.equal(await store.recordIncidentState(incidentState("VERIFYING", { at: 1_800_000_000_020 })), true);
    assert.equal(await store.recordIncidentState(incidentState("RECOVERED", { at: 1_800_000_000_030 })), true);
    assert.equal(await store.recordIncidentState(incidentState("EXECUTING", { at: 1_800_000_000_040 })), false);

    const persisted = await store.getIncident("incident-001");
    assert.equal(persisted.state, "RECOVERED");
    assert.equal(persisted.updatedAt, 1_800_000_000_030);
  });
});

test("file orchestration store rejects cross-asset and backward-time incident transitions", async () => {
  await withTempDirectory(async (directory) => {
    const store = createFileOrchestrationStore({ filePath: join(directory, "orchestration.json") });
    assert.equal(await store.recordIncidentState(incidentState("OBSERVING")), true);
    assert.equal(await store.recordIncidentState(incidentState("HELD", {
      assetId: "different-host",
      at: 1_800_000_000_001
    })), false);
    assert.equal(await store.recordIncidentState(incidentState("HELD", {
      at: 1_800_000_000_001
    })), true);
    assert.equal(await store.recordIncidentState(incidentState("OBSERVING", {
      at: 1_800_000_000_000
    })), false);
  });
});

test("idempotency claims are atomic and survive store instances", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "orchestration.json");
    const first = createFileOrchestrationStore({ filePath });
    const second = createFileOrchestrationStore({ filePath });
    const input = claimAction();

    const results = await Promise.all([
      first.claimAction(input),
      second.claimAction(input)
    ]);
    assert.equal(results.filter((value) => value.claimed === true).length, 1);
    assert.equal(results.filter((value) => value.claimed === false).length, 1);
    assert.ok(results.some((value) => value.reason === "idempotency-key-already-claimed"));

    const state = await first.getServiceState({
      assetId: "host-erp-01",
      environment: "production"
    });
    assert.equal(state.lastActionAt, null);
  });
});

test("an expired claimed action is not silently recycled after an uncertain outcome", async () => {
  await withTempDirectory(async (directory) => {
    const store = createFileOrchestrationStore({ filePath: join(directory, "orchestration.json") });
    const first = claimAction();
    assert.equal((await store.claimAction(first)).claimed, true);

    const second = claimAction({
      incidentId: "incident-002",
      claimedAt: first.expiresAt + 1,
      expiresAt: first.expiresAt + 30_001
    });
    const blocked = await store.claimAction(second);
    assert.equal(blocked.claimed, false);
    assert.equal(blocked.reason, "action-reconciliation-required");
  });
});

test("active mutations are serialized per exact asset and environment", async () => {
  await withTempDirectory(async (directory) => {
    const store = createFileOrchestrationStore({ filePath: join(directory, "orchestration.json") });
    const first = await store.claimAction(claimAction());
    assert.equal(first.claimed, true);

    const competing = await store.claimAction(claimAction({
      incidentId: "incident-002",
      claimedAt: 1_800_000_000_001,
      expiresAt: 1_800_000_030_001
    }));
    assert.equal(competing.claimed, false);
    assert.equal(competing.reason, "asset-action-already-in-progress");

    const otherEnvironment = await store.claimAction(claimAction({
      incidentId: "incident-003",
      environment: "staging",
      claimedAt: 1_800_000_000_002,
      expiresAt: 1_800_000_030_002
    }));
    assert.equal(otherEnvironment.claimed, true);
  });
});

test("action finalization is one-time and updates durable service/circuit state", async () => {
  await withTempDirectory(async (directory) => {
    const store = createFileOrchestrationStore({ filePath: join(directory, "orchestration.json") });
    const input = claimAction();
    const claim = await store.claimAction(input);
    assert.equal(claim.claimed, true);
    assert.equal(await store.completeAction({
      actionId: claim.actionId,
      outcome: "failed",
      completedAt: input.claimedAt + 1,
      reasonCode: "TEST_FAILURE"
    }), true);
    assert.equal(await store.completeAction({
      actionId: claim.actionId,
      outcome: "succeeded",
      completedAt: input.claimedAt + 2,
      reasonCode: "SECOND_FINALIZATION"
    }), false);

    assert.equal(await store.recordActionOutcome({
      assetId: input.assetId,
      environment: input.environment,
      action: input.action,
      outcome: "failed",
      at: input.claimedAt + 1,
      failureThreshold: 2,
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
      action: input.action,
      now: input.claimedAt + 2
    });
    assert.equal(circuit.open, false);
  });
});

test("circuit breaker opens at its configured failure threshold and expires after cooldown", async () => {
  await withTempDirectory(async (directory) => {
    const store = createFileOrchestrationStore({ filePath: join(directory, "orchestration.json") });
    const first = claimAction();
    const claim = await store.claimAction(first);
    assert.equal(claim.claimed, true);
    assert.equal(await store.completeAction({
      actionId: claim.actionId,
      outcome: "unverified",
      completedAt: first.claimedAt + 1,
      reasonCode: "UNVERIFIED"
    }), true);
    assert.equal(await store.recordActionOutcome({
      assetId: first.assetId,
      environment: first.environment,
      action: first.action,
      outcome: "unverified",
      at: first.claimedAt + 1,
      failureThreshold: 1,
      cooldownMs: 60_000
    }), true);

    const open = await store.getCircuitState({
      assetId: first.assetId,
      action: first.action,
      now: first.claimedAt + 2
    });
    assert.equal(open.open, true);
    assert.equal(open.retryAtMs, first.claimedAt + 60_001);

    const expired = await store.getCircuitState({
      assetId: first.assetId,
      action: first.action,
      now: first.claimedAt + 60_002
    });
    assert.equal(expired.open, false);
    assert.equal(expired.retryAtMs, null);
  });
});

test("cancelled-before-execution does not increment failures or last-action time", async () => {
  await withTempDirectory(async (directory) => {
    const store = createFileOrchestrationStore({ filePath: join(directory, "orchestration.json") });
    const input = claimAction();
    const claim = await store.claimAction(input);
    assert.equal(claim.claimed, true);
    assert.equal(await store.completeAction({
      actionId: claim.actionId,
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

    const state = await store.getServiceState({
      assetId: input.assetId,
      environment: input.environment
    });
    assert.equal(state.lastActionAt, null);
    assert.equal(state.consecutiveFailures, 0);
  });
});

test("file audit store appends fsynced hash-chained records and verifies sequence", async () => {
  await withTempDirectory(async (directory) => {
    const store = createFileAuditStore({ filePath: join(directory, "audit.jsonl") });
    assert.equal(store.durable, true);
    assert.equal(await store.append({ event: "incident-evaluated", incidentId: "incident-001" }), true);
    assert.equal(await store.append({ event: "action-authorized", action: "restart-service" }), true);

    const verified = await store.verify();
    assert.deepEqual(verified, {
      valid: true,
      sequence: 2,
      lastHash: verified.lastHash
    });
    assert.match(verified.lastHash, /^[a-f0-9]{64}$/);
  });
});

test("file audit store detects tampering and refuses subsequent appends", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "audit.jsonl");
    const store = createFileAuditStore({ filePath });
    await store.append({ event: "decision", result: "hold" });

    const original = await readFile(filePath, "utf8");
    await writeFile(filePath, original.replace('"result":"hold"', '"result":"allow"'), "utf8");

    await assert.rejects(store.verify(), /integrity verification failed/);
    await assert.rejects(store.append({ event: "second" }), /integrity verification failed/);
  });
});

test("file audit store rejects accessor and oversized entries", async () => {
  await withTempDirectory(async (directory) => {
    const store = createFileAuditStore({ filePath: join(directory, "audit.jsonl") });
    const hostile = {};
    Object.defineProperty(hostile, "event", {
      enumerable: true,
      get() { throw new Error("must not execute"); }
    });
    await assert.rejects(store.append(hostile), /accessor property/);
    await assert.rejects(store.append({ event: "x".repeat(33 * 1024) }), /32 KiB/);
  });
});
