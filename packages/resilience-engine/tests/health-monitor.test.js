import test from "node:test";
import assert from "node:assert/strict";
import { createHealthMonitor } from "../src/health-monitor.js";

test("health monitor counts failures, proposes recovery at threshold and resets on recovery", () => {
  let now = 1000;
  const calls = [];
  const monitor = createHealthMonitor({
    clock: () => now,
    engine: {
      evaluateRecovery(input) {
        calls.push(input);
        return input.consecutiveFailures >= 2
          ? { eligible: true, proposal: { serviceId: input.serviceId } }
          : { eligible: false, reason: "failure-threshold-not-reached" };
      }
    }
  });
  assert.equal(monitor.observe({ serviceId: "api", healthy: false }).consecutiveFailures, 1);
  now += 1000;
  const second = monitor.observe({ serviceId: "api", healthy: false });
  assert.equal(second.recovery.eligible, true);
  assert.equal(calls.at(-1).restartCount, 0);
  now += 1000;
  monitor.recordRecoveryAttempt({ serviceId: "api", executed: true });
  assert.equal(monitor.getSnapshot("api").restartCount, 1);
  now += 1000;
  assert.equal(monitor.observe({ serviceId: "api", healthy: true }).consecutiveFailures, 0);
});

test("healthy observations continue after recovery-attempt capacity is exhausted", () => {
  let now = 1000;
  const monitor = createHealthMonitor({
    clock: () => now,
    maxServices: 1,
    maxRecoveryAttempts: 1,
    engine: { evaluateRecovery: () => ({ eligible: false }) }
  });
  monitor.recordRecoveryAttempt({ serviceId: "api", executed: true });
  now += 1000;
  const healthy = monitor.observe({ serviceId: "api", healthy: true });
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.consecutiveFailures, 0);
  assert.equal(healthy.restartCount, 1);
  assert.throws(
    () => monitor.recordRecoveryAttempt({ serviceId: "api", executed: false }),
    /recovery-attempt limit/
  );
  assert.throws(
    () => monitor.recordRecoveryAttempt({ serviceId: "another-api", executed: true }),
    /service capacity/
  );
});

test("unhealthy observations do not propose recovery after the attempt cap", () => {
  let evaluations = 0;
  const monitor = createHealthMonitor({
    maxRecoveryAttempts: 1,
    engine: {
      evaluateRecovery() {
        evaluations += 1;
        return { eligible: true, proposal: { serviceId: "api" } };
      }
    }
  });
  monitor.recordRecoveryAttempt({ serviceId: "api", executed: false });

  const capped = monitor.observe({ serviceId: "api", healthy: false });
  assert.equal(capped.status, "unhealthy");
  assert.equal(capped.recovery.eligible, false);
  assert.equal(capped.recovery.reason, "recovery-attempt-limit-reached");
  assert.equal(evaluations, 0);

  const threat = monitor.observe({
    serviceId: "api", healthy: false, securityThreatActive: true
  });
  assert.equal(threat.recovery.reason, "security-threat-active");
  assert.equal(evaluations, 0);

  const healthy = monitor.observe({ serviceId: "api", healthy: true });
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.restartCount, 1);
});

test("security threat observations suspend recovery before policy evaluation", () => {
  let evaluations = 0;
  const monitor = createHealthMonitor({
    engine: {
      evaluateRecovery() {
        evaluations += 1;
        return { eligible: true, proposal: { serviceId: "api" } };
      }
    }
  });
  const result = monitor.observe({
    serviceId: "api", healthy: false, securityThreatActive: true
  });
  assert.equal(result.recovery.eligible, false);
  assert.equal(result.recovery.reason, "security-threat-active");
  assert.equal(evaluations, 0);
});

test("health monitor rejects malformed observations and recovery outcomes", () => {
  const monitor = createHealthMonitor({
    engine: { evaluateRecovery: () => ({ eligible: false }) }
  });
  assert.throws(() => monitor.observe({ serviceId: "api", healthy: "yes" }), /observation/);
  assert.throws(() => monitor.recordRecoveryAttempt({ serviceId: "api", executed: 1 }), /result/);
});
