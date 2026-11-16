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

test("Linux adapter fails closed on permission errors and command timeouts", async () => {
  const permissionDenied = createLinuxSystemdAdapter({
    allowedServices: ["catalog-api.service"],
    run: async () => ({ code: 5, stderr: "permission denied" })
  });
  await assert.rejects(() => permissionDenied.restartService("catalog-api.service"), /restart failed/);

  const timedOut = createLinuxSystemdAdapter({
    allowedServices: ["catalog-api.service"],
    run: async () => { throw new Error("command timed out"); }
  });
  await assert.rejects(() => timedOut.restartService("catalog-api.service"), /timed out/);
});

test("Windows adapter waits for STOPPED and confirms RUNNING before completion", async () => {
  const calls = [];
  const states = ["STOP_PENDING", "STOPPED", "START_PENDING", "RUNNING"];
  const adapter = createWindowsScmAdapter({
    allowedServices: ["JBService"],
    pollIntervalMs: 10,
    sleep: async () => {},
    run: async (...args) => {
      calls.push(args);
      if (args[1][0] === "query") {
        const state = states.shift();
        const code = state === "STOPPED" ? 1 : state === "RUNNING" ? 4 : 3;
        return { code: 0, stdout: "SERVICE_NAME: JBService\n        STATE              : " + code + "  " + state };
      }
      return { code: 0 };
    }
  });
  const result = await adapter.restartService("JBService");
  assert.equal(result.running, true);
  assert.deepEqual(calls.map((call) => call[1][0]), ["stop", "query", "query", "start", "query", "query"]);
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
  assert.equal((await engine.executeRecovery({ proposal: result.proposal })).reason, "proposal-already-consumed");
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
  assert.equal((await engine.executeRecovery({ proposal: result.proposal, approval: { signed: true } })).reason, "proposal-already-consumed");
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

test("critical proposal expiry is rechecked after asynchronous approval verification", async () => {
  let now = 20_000;
  let restarts = 0;
  const engine = createResilienceEngine({
    policy,
    adapter: { platform: "windows-scm", async restartService() { restarts += 1; } },
    clock: () => now,
    approvalVerifier: async ({ proposal, approval }) => {
      assert.equal(approval.proposalId, proposal.proposalId);
      assert.equal(approval.nonce, proposal.nonce);
      assert.ok(proposal.issuedAt < proposal.expiresAt);
      now = proposal.expiresAt;
      return true;
    }
  });
  const proposal = engine.evaluateRecovery({
    serviceId: "postgresql", consecutiveFailures: 3, restartCount: 0
  }).proposal;
  assert.ok(proposal.proposalId && proposal.nonce);
  const result = await engine.executeRecovery({
    proposal,
    approval: {
      proposalId: proposal.proposalId,
      nonce: proposal.nonce,
      subjectId: "operations-user",
      signature: "test-only-signature"
    }
  });
  assert.equal(result.executed, false);
  assert.equal(result.reason, "proposal-expired");
  assert.equal(restarts, 0);
});

test("active security threat or tamper signal suspends recovery", () => {
  const engine = createResilienceEngine({
    policy,
    adapter: { platform: "linux-systemd", async restartService() {} },
    clock: () => 10_000
  });
  const result = engine.evaluateRecovery({
    serviceId: "catalog-api.service",
    consecutiveFailures: 3,
    restartCount: 0,
    securityThreatActive: true
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "security-threat-active");
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

test("Windows adapter never starts while service remains active after stop request", async () => {
  const calls = [];
  let now = 0;
  const adapter = createWindowsScmAdapter({
    allowedServices: ["JBService"],
    timeoutMs: 100,
    pollIntervalMs: 25,
    clock: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    run: async (...args) => {
      calls.push(args);
      if (args[1][0] === "query") {
        return { code: 0, stdout: "STATE : 4 RUNNING" };
      }
      return { code: 0 };
    }
  });
  await assert.rejects(() => adapter.restartService("JBService"), /did not reach STOPPED/);
  assert.equal(calls.some((call) => call[1][0] === "start"), false);
  assert.ok(calls.filter((call) => call[1][0] === "query").length >= 4);
});

test("Windows adapter fails when start is accepted but the service never reaches RUNNING", async () => {
  const calls = [];
  let now = 0;
  const adapter = createWindowsScmAdapter({
    allowedServices: ["JBService"],
    timeoutMs: 100,
    pollIntervalMs: 25,
    clock: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    run: async (...args) => {
      calls.push(args);
      if (args[1][0] === "query") {
        return { code: 0, stdout: calls.some((call) => call[1][0] === "start")
          ? "STATE : 2 START_PENDING" : "STATE : 1 STOPPED" };
      }
      return { code: 0 };
    }
  });
  await assert.rejects(() => adapter.restartService("JBService"), /did not reach RUNNING/);
  assert.equal(calls.some((call) => call[1][0] === "start"), true);
});

test("Windows adapter never starts a service when stop fails", async () => {
  const calls = [];
  const adapter = createWindowsScmAdapter({
    allowedServices: ["JBService"],
    run: async (...args) => {
      calls.push(args);
      return { code: args[1][0] === "stop" ? 5 : 0 };
    }
  });
  await assert.rejects(() => adapter.restartService("JBService"), /stop failed/);
  assert.equal(calls.length, 1);
});
