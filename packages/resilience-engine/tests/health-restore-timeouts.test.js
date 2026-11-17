import test from "node:test";
import assert from "node:assert/strict";
import { createHealthMonitor } from "../src/health-monitor.js";
import { createResilienceEngine } from "../src/index.js";

const nonCriticalPolicy = {
  schema: "jb.resilience.policy/v1",
  mode: "semi-autonomous",
  failureThreshold: 1,
  maxRestarts: 1,
  cooldownMs: 1000,
  services: [{ id: "catalog-api.service", critical: false }]
};

const criticalPolicy = {
  ...nonCriticalPolicy,
  services: [{ id: "catalog-api.service", critical: true }]
};

test("health monitor can restore attempt count before accepting observations", () => {
  const monitor = createHealthMonitor({
    maxRecoveryAttempts: 1,
    engine: { evaluateRecovery: () => ({ eligible: true }) }
  });
  const restored = monitor.restoreState({
    serviceId: "catalog-api.service",
    restartCount: 1,
    lastRestartAt: 5000,
    consecutiveFailures: 2,
    lastObservedAt: 4900,
    status: "unhealthy"
  });
  assert.equal(restored.restartCount, 1);
  const next = monitor.observe({
    serviceId: "catalog-api.service",
    healthy: false
  });
  assert.equal(next.recovery.reason, "recovery-attempt-limit-reached");
  assert.throws(() => monitor.restoreState({
    serviceId: "catalog-api.service", restartCount: 0
  }), /before the first observation/);
});

test("health monitor rejects malformed restored state and preserves capacity limits", () => {
  const monitor = createHealthMonitor({
    maxServices: 1,
    engine: { evaluateRecovery: () => ({ eligible: false }) }
  });
  assert.throws(() => monitor.restoreState({
    serviceId: "api", restartCount: -1
  }), /restored health state is invalid/);
  monitor.restoreState({ serviceId: "api", restartCount: 0 });
  assert.throws(() => monitor.restoreState({
    serviceId: "worker", restartCount: 0
  }), /service capacity/);
});

test("critical approval verification is bounded and abort signal is raised on timeout", async () => {
  let restarts = 0;
  let observedSignal;
  const engine = createResilienceEngine({
    policy: criticalPolicy,
    approvalTimeoutMs: 100,
    approvalVerifier: ({ signal }) => {
      observedSignal = signal;
      return new Promise(() => {});
    },
    adapter: {
      platform: "linux-systemd",
      async restartService() { restarts += 1; }
    },
    clock: () => 10_000
  });
  const proposal = engine.evaluateRecovery({
    serviceId: "catalog-api.service",
    consecutiveFailures: 1,
    restartCount: 0
  }).proposal;
  const result = await engine.executeRecovery({
    proposal,
    approval: { signature: "test-only" }
  });
  assert.equal(result.executed, false);
  assert.equal(result.reason, "human-approval-required-or-invalid");
  assert.equal(observedSignal.aborted, true);
  assert.equal(restarts, 0);
});

test("application health verification timeout stays unknown and consumes the recovery attempt", async () => {
  let observedSignal;
  const engine = createResilienceEngine({
    policy: nonCriticalPolicy,
    healthCheckTimeoutMs: 100,
    adapter: {
      platform: "windows-scm",
      async restartService() { return { accepted: true }; }
    },
    healthCheck: ({ signal }) => {
      observedSignal = signal;
      return new Promise(() => {});
    },
    clock: () => 10_000
  });
  const proposal = engine.evaluateRecovery({
    serviceId: "catalog-api.service",
    consecutiveFailures: 1,
    restartCount: 0
  }).proposal;
  const result = await engine.executeRecovery({ proposal });
  assert.equal(result.executed, true);
  assert.equal(result.verified, false);
  assert.equal(result.recovered, null);
  assert.equal(result.reason, "post-recovery-health-check-unavailable");
  assert.equal(result.ledgerRecorded, true);
  assert.equal(observedSignal.aborted, true);
  const state = await engine.recoveryStore.getServiceState("catalog-api.service");
  assert.equal(state.attemptCount, 1);
  assert.equal(state.lastStatus, "unverified");
});
