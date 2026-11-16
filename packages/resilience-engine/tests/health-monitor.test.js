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

test("health monitor rejects malformed observations and recovery outcomes", () => {
  const monitor = createHealthMonitor({
    engine: { evaluateRecovery: () => ({ eligible: false }) }
  });
  assert.throws(() => monitor.observe({ serviceId: "api", healthy: "yes" }), /observation/);
  assert.throws(() => monitor.recordRecoveryAttempt({ serviceId: "api", executed: 1 }), /result/);
});
