import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileRecoveryStore,
  createMemoryRecoveryStore,
  createResilienceEngine
} from "../src/index.js";

const policy = {
  schema: "jb.resilience.policy/v1",
  mode: "semi-autonomous",
  failureThreshold: 2,
  maxRestarts: 1,
  cooldownMs: 1000,
  services: [{ id: "catalog-api.service", critical: false }]
};

function newProposal(engine, now = 10_000) {
  const result = engine.evaluateRecovery({
    serviceId: "catalog-api.service",
    consecutiveFailures: 2,
    restartCount: 0
  });
  assert.equal(result.eligible, true);
  assert.equal(result.proposal.expiresAt, now + 60_000);
  return result.proposal;
}

test("durable ledger blocks further restarts after engine re-instantiation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jb-resilience-engine-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "recovery.json");
  const firstStore = createFileRecoveryStore({ filePath });
  let restarts = 0;
  const firstEngine = createResilienceEngine({
    policy,
    recoveryStore: firstStore,
    requireDurableStore: true,
    requireHealthVerification: true,
    adapter: {
      platform: "linux-systemd",
      async restartService() { restarts += 1; return { requested: true }; },
      async verifyService() { return { healthy: true, state: "active" }; }
    },
    clock: () => 10_000
  });
  assert.equal(firstEngine.durableStore, true);
  const first = newProposal(firstEngine);
  const firstResult = await firstEngine.executeRecovery({ proposal: first });
  assert.equal(firstResult.executed, true);
  assert.equal(firstResult.recovered, true);
  assert.equal(firstResult.ledgerRecorded, true);

  const secondEngine = createResilienceEngine({
    policy,
    recoveryStore: createFileRecoveryStore({ filePath }),
    requireDurableStore: true,
    adapter: {
      platform: "linux-systemd",
      async restartService() { restarts += 1; }
    },
    clock: () => 20_000
  });
  const second = newProposal(secondEngine, 20_000);
  const denied = await secondEngine.executeRecovery({ proposal: second });
  assert.equal(denied.executed, false);
  assert.equal(denied.reason, "recovery-attempt-limit-reached");
  assert.equal(restarts, 1);
});

test("engine distinguishes command execution from failed post-recovery health verification", async () => {
  let restarts = 0;
  const engine = createResilienceEngine({
    policy,
    adapter: {
      platform: "windows-scm",
      async restartService() { restarts += 1; return { accepted: true }; },
      async verifyService() { return { healthy: false, state: "STOPPED" }; }
    },
    clock: () => 10_000
  });
  const result = await engine.executeRecovery({ proposal: newProposal(engine) });
  assert.equal(result.executed, true);
  assert.equal(result.verified, true);
  assert.equal(result.recovered, false);
  assert.equal(result.reason, "post-recovery-health-check-failed");
  assert.equal(result.ledgerRecorded, true);
  assert.equal(restarts, 1);
  assert.equal(
    (await engine.recoveryStore.getServiceState("catalog-api.service")).lastStatus,
    "verification-failed"
  );
});

test("a timed-out service restart is finalized as unverified and the proposal cannot be retried", async () => {
  let restartSignal;
  const engine = createResilienceEngine({
    policy,
    adapterTimeoutMs: 100,
    adapter: {
      platform: "linux-systemd",
      async restartService(_serviceId, { signal } = {}) {
        restartSignal = signal;
        return new Promise(() => {});
      }
    },
    clock: () => 10_000
  });
  const proposal = newProposal(engine);
  const result = await engine.executeRecovery({ proposal });

  assert.equal(result.executed, false);
  assert.equal(result.executionOutcome, "unknown");
  assert.equal(result.recovered, null);
  assert.equal(result.verified, false);
  assert.equal(result.reason, "recovery-adapter-outcome-unknown");
  assert.equal(result.ledgerRecorded, true);
  assert.equal(restartSignal.aborted, true);

  const state = await engine.recoveryStore.getServiceState("catalog-api.service");
  assert.equal(state.attemptCount, 1);
  assert.equal(state.lastStatus, "unverified");
  const retried = await engine.executeRecovery({ proposal });
  assert.equal(retried.reason, "proposal-already-consumed");
});

test("a timed-out adapter health verification remains unknown instead of marking recovery failed", async () => {
  let verificationSignal;
  const engine = createResilienceEngine({
    policy,
    adapterTimeoutMs: 100,
    requireHealthVerification: true,
    adapter: {
      platform: "windows-scm",
      async restartService() { return { accepted: true }; },
      async verifyService(_serviceId, { signal } = {}) {
        verificationSignal = signal;
        return new Promise(() => {});
      }
    },
    clock: () => 10_000
  });
  const result = await engine.executeRecovery({ proposal: newProposal(engine) });
  assert.equal(result.executed, true);
  assert.equal(result.verified, false);
  assert.equal(result.recovered, null);
  assert.equal(result.reason, "post-recovery-health-check-unavailable");
  assert.equal(result.ledgerRecorded, true);
  assert.equal(verificationSignal.aborted, true);
  assert.equal(
    (await engine.recoveryStore.getServiceState("catalog-api.service")).lastStatus,
    "unverified"
  );
});

test("a host health-check timeout is unknown even when the service adapter reports healthy", async () => {
  const engine = createResilienceEngine({
    policy,
    healthCheckTimeoutMs: 100,
    requireHealthVerification: true,
    adapter: {
      platform: "linux-systemd",
      async restartService() { return { accepted: true }; },
      async verifyService() { return { healthy: true }; }
    },
    healthCheck: async () => new Promise(() => {}),
    clock: () => 10_000
  });
  const result = await engine.executeRecovery({ proposal: newProposal(engine) });
  assert.equal(result.executed, true);
  assert.equal(result.verified, false);
  assert.equal(result.recovered, null);
  assert.equal(result.reason, "post-recovery-health-check-unavailable");
  assert.equal(
    (await engine.recoveryStore.getServiceState("catalog-api.service")).lastStatus,
    "unverified"
  );
});

test("unknown adapter health responses are not interpreted as a confirmed unhealthy service", async () => {
  const engine = createResilienceEngine({
    policy,
    requireHealthVerification: true,
    adapter: {
      platform: "linux-systemd",
      async restartService() { return { accepted: true }; },
      async verifyService() { return { state: "active" }; }
    },
    clock: () => 10_000
  });
  const result = await engine.executeRecovery({ proposal: newProposal(engine) });
  assert.equal(result.executed, true);
  assert.equal(result.verified, false);
  assert.equal(result.recovered, null);
  assert.equal(result.reason, "post-recovery-health-check-unavailable");
  assert.equal(
    (await engine.recoveryStore.getServiceState("catalog-api.service")).lastStatus,
    "unverified"
  );
});

test("host health check is combined with adapter verification", async () => {
  const engine = createResilienceEngine({
    policy,
    adapter: {
      platform: "linux-systemd",
      async restartService() { return { accepted: true }; },
      async verifyService() { return true; }
    },
    healthCheck: async ({ proposal, adapterResult }) =>
      proposal.serviceId === "catalog-api.service" && adapterResult.accepted,
    clock: () => 10_000
  });
  const result = await engine.executeRecovery({ proposal: newProposal(engine) });
  assert.equal(result.executed, true);
  assert.equal(result.recovered, true);
  assert.equal(result.verified, true);
});

test("production safety requirements reject memory-only stores and missing health checks", () => {
  assert.throws(() => createResilienceEngine({
    policy,
    adapter: { platform: "linux-systemd", async restartService() {} },
    requireDurableStore: true
  }), /durable recoveryStore is required/);

  assert.throws(() => createResilienceEngine({
    policy,
    recoveryStore: createMemoryRecoveryStore(),
    adapter: { platform: "linux-systemd", async restartService() {} },
    requireHealthVerification: true
  }), /service verifier or host healthCheck is required/);
});

test("recovery fails closed when the durable ledger cannot claim an operation", async () => {
  let restarts = 0;
  const unavailableStore = {
    durable: true,
    async claimRecovery() { throw new Error("disk unavailable"); },
    async completeRecovery() {},
    async getServiceState() {},
    async listRecoveryHistory() { return []; }
  };
  const engine = createResilienceEngine({
    policy,
    recoveryStore: unavailableStore,
    requireDurableStore: true,
    adapter: {
      platform: "linux-systemd",
      async restartService() { restarts += 1; }
    },
    clock: () => 10_000
  });
  const result = await engine.executeRecovery({ proposal: newProposal(engine) });
  assert.equal(result.executed, false);
  assert.equal(result.reason, "recovery-ledger-unavailable");
  assert.equal(restarts, 0);
});
