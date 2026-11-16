import test from "node:test";
import assert from "node:assert/strict";
import { createResilienceEngine } from "../src/index.js";
import { createLinuxSystemdAdapter } from "../src/adapters/linux-systemd.js";
import { createWindowsScmAdapter } from "../src/adapters/windows-scm.js";

const policy = {
  schema: "jb.resilience.policy/v1", mode: "semi-autonomous",
  failureThreshold: 3, maxRestarts: 2, cooldownMs: 5000,
  services: [
    { id: "catalog-api.service", critical: false },
    { id: "postgresql", critical: true }
  ]
};

test("Linux adapter uses a fixed executable, argument list and allowlist", async () => {
  const calls = [];
  const adapter = createLinuxSystemdAdapter({
    allowedServices: ["catalog-api.service"],
    run: async (...args) => { calls.push(args); return { code: 0 }; }
  });
  await adapter.restartService("catalog-api.service");
  assert.equal(calls[0][0], "systemctl");
  assert.deepEqual(calls[0][1], ["restart", "catalog-api.service"]);
  assert.equal(calls[0][2].shell, false);
  await assert.rejects(() => adapter.restartService("attacker; id"), /allowlisted/);
});

test("Windows adapter stops then starts only an allowlisted service", async () => {
  const calls = [];
  const adapter = createWindowsScmAdapter({
    allowedServices: ["JBService"],
    run: async (...args) => { calls.push(args); return { code: 0 }; }
  });
  await adapter.restartService("JBService");
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [
    ["sc.exe", ["stop", "JBService"]], ["sc.exe", ["start", "JBService"]]
  ]);
  assert.ok(calls.every((call) => call[2].shell === false));
});

test("non-critical recovery proposal can run only after threshold and policy checks", async () => {
  let restarts = 0;
  const engine = createResilienceEngine({
    policy, adapter: { platform: "linux-systemd", async restartService() { restarts += 1; } },
    clock: () => 10000
  });
  assert.equal(engine.evaluateRecovery({
    serviceId: "catalog-api.service", consecutiveFailures: 2, restartCount: 0
  }).reason, "failure-threshold-not-reached");
  const result = engine.evaluateRecovery({
    serviceId: "catalog-api.service", consecutiveFailures: 3, restartCount: 0
  });
  assert.equal(result.eligible, true);
  assert.equal((await engine.executeRecovery({ proposal: result.proposal })).executed, true);
  assert.equal(restarts, 1);
});

test("critical recovery requires a verified human approval", async () => {
  let restarts = 0;
  const engine = createResilienceEngine({
    policy, adapter: { platform: "windows-scm", async restartService() { restarts += 1; } },
    approvalVerifier: async ({ approval }) => approval?.signed === true,
    clock: () => 20000
  });
  const result = engine.evaluateRecovery({
    serviceId: "postgresql", consecutiveFailures: 3, restartCount: 0
  });
  assert.equal(result.proposal.approvalRequired, true);
  assert.equal((await engine.executeRecovery({ proposal: result.proposal })).reason,
    "human-approval-required-or-invalid");
  assert.equal((await engine.executeRecovery({
    proposal: result.proposal, approval: { signed: true }
  })).executed, true);
  assert.equal(restarts, 1);
});

test("forged proposals, unknown services, restart loops and invalid policy are rejected", async () => {
  const engine = createResilienceEngine({
    policy, adapter: { platform: "linux-systemd", async restartService() {} },
    clock: () => 10000
  });
  assert.equal((await engine.executeRecovery({
    proposal: { serviceId: "catalog-api.service", expiresAt: 99999 }
  })).reason, "untrusted-or-unknown-proposal");
  assert.equal(engine.evaluateRecovery({
    serviceId: "unknown", consecutiveFailures: 10, restartCount: 0
  }).reason, "service-not-allowlisted");
  assert.equal(engine.evaluateRecovery({
    serviceId: "catalog-api.service", consecutiveFailures: 3, restartCount: 2
  }).reason, "restart-limit-reached");
  assert.throws(() => createResilienceEngine({
    policy: { ...policy, mode: "autonomous" },
    adapter: { platform: "linux-systemd", async restartService() {} }
  }), /policy is invalid/);
});

test("recovery proposals expire", async () => {
  let now = 10000;
  let restarts = 0;
  const engine = createResilienceEngine({
    policy, adapter: { platform: "linux-systemd", async restartService() { restarts += 1; } },
    clock: () => now
  });
  const proposal = engine.evaluateRecovery({
    serviceId: "catalog-api.service", consecutiveFailures: 3, restartCount: 0
  }).proposal;
  now = proposal.expiresAt + 1;
  assert.equal((await engine.executeRecovery({ proposal })).reason, "proposal-expired");
  assert.equal(restarts, 0);
});
