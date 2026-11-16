import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateA2ContainmentReadiness,
  evaluateA3FailoverReadiness,
  CONTINUITY_GATE_REQUIREMENTS
} from "../src/continuity-gates.js";

function evidenceFor(keys) {
  return Object.fromEntries([
    ...keys.map((key) => [key, true]),
    ["observedAt", 1_800_000_000_000],
    ["expiresAt", 1_800_000_030_000],
    ["now", 1_800_000_010_000]
  ]);
}

test("A2 remains denied when any trusted containment prerequisite is absent", () => {
  const evidence = evidenceFor(CONTINUITY_GATE_REQUIREMENTS.A2);
  evidence.rollbackPlan = false;
  const result = evaluateA2ContainmentReadiness(evidence);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.denied, ["rollbackPlan"]);
  assert.equal(result.executable, false);
});

test("A2 readiness passes only when every explicit gate and freshness check passes", () => {
  const result = evaluateA2ContainmentReadiness(evidenceFor(CONTINUITY_GATE_REQUIREMENTS.A2));
  assert.equal(result.eligible, true);
  assert.deepEqual(result.denied, []);
  assert.equal(result.executable, false);
});

test("A3 denies promotion when the external monitor or quorum is unknown", () => {
  const evidence = evidenceFor(CONTINUITY_GATE_REQUIREMENTS.A3);
  evidence.independentExternalMonitor = false;
  evidence.monitorQuorum = false;
  const result = evaluateA3FailoverReadiness(evidence);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.denied, ["independentExternalMonitor", "monitorQuorum"]);
});

test("A3 readiness requires fencing enforced by the actual target and source fencing", () => {
  const evidence = evidenceFor(CONTINUITY_GATE_REQUIREMENTS.A3);
  evidence.targetEnforcesFencing = false;
  evidence.sourceFenced = false;
  const result = evaluateA3FailoverReadiness(evidence);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.denied, ["targetEnforcesFencing", "sourceFenced"]);
});

test("A3 readiness requires healthy replication within the declared RPO gate", () => {
  const evidence = evidenceFor(CONTINUITY_GATE_REQUIREMENTS.A3);
  evidence.replicationHealthy = false;
  evidence.replicationWithinRpo = false;
  const result = evaluateA3FailoverReadiness(evidence);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.denied, ["replicationHealthy", "replicationWithinRpo"]);
});

test("expired, future-dated and malformed freshness windows fail closed", () => {
  const expired = evidenceFor(CONTINUITY_GATE_REQUIREMENTS.A3);
  expired.now = expired.expiresAt;
  assert.equal(evaluateA3FailoverReadiness(expired).eligible, false);
  assert.ok(evaluateA3FailoverReadiness(expired).denied.includes("freshnessWindow"));

  const future = evidenceFor(CONTINUITY_GATE_REQUIREMENTS.A2);
  future.observedAt = future.now + 1;
  assert.equal(evaluateA2ContainmentReadiness(future).eligible, false);

  const malformed = evidenceFor(CONTINUITY_GATE_REQUIREMENTS.A2);
  malformed.expiresAt = "never";
  assert.equal(evaluateA2ContainmentReadiness(malformed).eligible, false);
});

test("unknown fields and non-record inputs are rejected", () => {
  const extra = evidenceFor(CONTINUITY_GATE_REQUIREMENTS.A2);
  extra.forcePromotion = true;
  assert.equal(evaluateA2ContainmentReadiness(extra).reason, "unsupported-evidence-field");
  assert.equal(evaluateA3FailoverReadiness(null).reason, "invalid-evidence");
  assert.equal(evaluateA3FailoverReadiness([]).reason, "invalid-evidence");
});

test("readiness output is immutable and never claims executable authority", () => {
  const result = evaluateA3FailoverReadiness(evidenceFor(CONTINUITY_GATE_REQUIREMENTS.A3));
  assert.equal(result.eligible, true);
  assert.equal(result.executable, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.denied), true);
});
