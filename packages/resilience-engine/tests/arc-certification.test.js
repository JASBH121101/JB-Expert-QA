import test from "node:test";
import assert from "node:assert/strict";
import {
  createResponseOrchestrator
} from "../src/response-orchestrator.js";
import {
  CONTINUITY_GATE_REQUIREMENTS,
  evaluateA2ContainmentReadiness,
  evaluateA3FailoverReadiness
} from "../src/continuity-gates.js";

const NOW = 1_800_000_000_000;

function completeEvidence(requirements) {
  return Object.fromEntries([
    ...requirements.map((key) => [key, true]),
    ["observedAt", NOW],
    ["expiresAt", NOW + 30_000],
    ["now", NOW + 1_000]
  ]);
}

function createA1RuntimeDescriptor() {
  return createResponseOrchestrator({
    incidentEngine: { evaluateIncident() { throw new Error("not invoked"); } },
    policyEngine: {
      policy: { policyId: "arc-lab", revision: 1, policyHash: "a".repeat(64) },
      evaluate() {}, authorize() {}, assertAuthorization() {}, completeAuthorization() {}
    },
    adapter: {
      platform: "linux-systemd",
      restartService() {},
      verifyService() {}
    },
    applicationHealthCheck: async () => ({ healthy: true }),
    trustedInputVerifier: async () => true,
    targetBindingVerifier: async () => true,
    mutationControl: { assertAllowed: async () => true },
    orchestrationStore: {
      durable: true,
      recordIncidentState: async () => true,
      getServiceState: async () => ({ lastActionAt: null }),
      getCircuitState: async () => ({ open: false, retryAtMs: null }),
      claimAction: async () => ({ claimed: true, actionId: "arc-action" }),
      completeAction: async () => true,
      recordActionOutcome: async () => true
    },
    auditStore: { durable: true, append: async () => true }
  });
}

test("ARC records the actual runtime mode and the exact A1 executable capability", () => {
  const runtime = createA1RuntimeDescriptor();
  assert.equal(runtime.mode, "semi-autonomous");
  assert.equal(runtime.targetMode, "autonomous-advanced");
  assert.deepEqual(runtime.executableActions, ["restart-service"]);
  assert.equal(runtime.executableActions.includes("apply-containment-profile"), false);
  assert.equal(runtime.executableActions.includes("switch-route"), false);
  assert.equal(runtime.executableActions.includes("failover"), false);
});

for (const [capability, requirements, evaluate] of [
  ["A2", CONTINUITY_GATE_REQUIREMENTS.A2, evaluateA2ContainmentReadiness],
  ["A3", CONTINUITY_GATE_REQUIREMENTS.A3, evaluateA3FailoverReadiness]
]) {
  test("ARC " + capability + " requires every evidence gate independently", () => {
    const complete = evaluate(completeEvidence(requirements));
    assert.equal(complete.eligible, true);
    assert.equal(complete.executable, false);
    for (const missing of requirements) {
      const evidence = completeEvidence(requirements);
      evidence[missing] = false;
      const result = evaluate(evidence);
      assert.equal(result.eligible, false, capability + " must deny missing " + missing);
      assert.ok(result.denied.includes(missing));
      assert.equal(result.executable, false);
    }
  });

  test("ARC " + capability + " rejects stale, future, malformed and extra evidence", () => {
    const expired = completeEvidence(requirements);
    expired.now = expired.expiresAt;
    assert.equal(evaluate(expired).eligible, false);

    const future = completeEvidence(requirements);
    future.observedAt = future.now + 1;
    assert.equal(evaluate(future).eligible, false);

    const malformed = completeEvidence(requirements);
    malformed.expiresAt = "later";
    assert.equal(evaluate(malformed).eligible, false);

    const extra = completeEvidence(requirements);
    extra.forceExecution = true;
    const result = evaluate(extra);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "unsupported-evidence-field");
    assert.equal(result.executable, false);
  });
}

test("ARC never converts A2/A3 readiness into executable authorization", () => {
  const a2 = evaluateA2ContainmentReadiness(completeEvidence(CONTINUITY_GATE_REQUIREMENTS.A2));
  const a3 = evaluateA3FailoverReadiness(completeEvidence(CONTINUITY_GATE_REQUIREMENTS.A3));
  assert.equal(a2.eligible, true);
  assert.equal(a3.eligible, true);
  assert.equal(a2.executable, false);
  assert.equal(a3.executable, false);
  assert.equal(Object.isFrozen(a2), true);
  assert.equal(Object.isFrozen(a3), true);
});
