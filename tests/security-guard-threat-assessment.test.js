import test from "node:test";
import assert from "node:assert/strict";
import { createThreatAssessmentEngine } from "@jb/security-guard/threat-assessment";
import { validateThreatAssessmentV1 } from "@jb/security-guard/core-contract-v1";

const NOW = 1_800_000_000_000;
const uuid = (number) => "00000000-0000-4000-8000-" + String(number).padStart(12, "0");
const digest = "a".repeat(64);

function makePolicy(overrides = {}) {
  return {
    schema: "jb.security.policy.threat-assessment/v1",
    id: "default-threat-policy",
    tenantId: "tenant-demo",
    applicationId: "admin-api",
    version: 1,
    enabled: true,
    windowMs: 300_000,
    maxSignals: 32,
    minimumConfidence: 0.5,
    severityWeights: { info: 5, low: 15, medium: 35, high: 65, critical: 90 },
    typeWeights: {
      brute_force: 100,
      endpoint_scan: 90,
      enumeration: 80,
      sql_injection: 110,
      parameter_tampering: 100,
      api_abuse: 95,
      bot_traffic: 75,
      anomaly: 50,
      upload_risk: 100
    },
    thresholds: { challenge: 35, review: 60, block: 85 },
    blockRequirements: {
      minSignals: 3,
      minDistinctRules: 2,
      minDistinctTypes: 2,
      minimumConfidence: 0.9
    },
    ...overrides
  };
}

function makeSignal(number, overrides = {}) {
  return {
    schema: "jb.security.threat-signal/v1",
    signalId: uuid(number),
    tenantId: "tenant-demo",
    applicationId: "admin-api",
    detectedAtMs: NOW - 10_000 - number,
    source: "security-guard-node",
    type: "brute_force",
    confidence: 0.99,
    severity: "critical",
    ruleId: "JBG-AUTH-BRUTE-" + String(number).padStart(3, "0"),
    subjectKey: digest,
    subjectKeyId: "identity-key-2026",
    evidenceCount: 1,
    ...overrides
  };
}

function createEngine(policy = makePolicy()) {
  let nextId = 1000;
  return createThreatAssessmentEngine({
    policy,
    clock: () => NOW,
    idGenerator: () => uuid(nextId++)
  });
}

test("engine validates and freezes its server-owned policy", () => {
  const engine = createEngine();
  const policy = engine.getPolicy();
  assert.equal(policy.id, "default-threat-policy");
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.severityWeights), true);
  assert.equal(Object.isFrozen(policy.thresholds), true);
  assert.throws(() => { policy.thresholds.block = 1; }, TypeError);
});

test("one high-risk signal cannot produce a block recommendation", () => {
  const assessment = createEngine().assess([makeSignal(1)]);
  assert.equal(assessment.riskScore, 89);
  assert.equal(assessment.decision, "review");
  assert.deepEqual(assessment.signalIds, [uuid(1)]);
  assert.doesNotThrow(() => validateThreatAssessmentV1(assessment));
});

test("multiple strong signals across independent rules and threat types can qualify for block", () => {
  const signals = [
    makeSignal(1, { type: "brute_force", ruleId: "JBG-AUTH-BRUTE-001" }),
    makeSignal(2, { type: "sql_injection", ruleId: "JBG-REQ-SQLI-002", severity: "high" }),
    makeSignal(3, { type: "upload_risk", ruleId: "JBG-UPLOAD-RISK-003", severity: "high" })
  ];
  const assessment = createEngine().assess(signals);
  assert.equal(assessment.riskScore, 100);
  assert.equal(assessment.decision, "block");
  assert.equal(assessment.signalIds.length, 3);
});

test("the same rule contributes only its strongest signal and cannot satisfy independent-rule block gates", () => {
  const signals = [
    makeSignal(1, { type: "brute_force", ruleId: "JBG-SHARED-RULE-001" }),
    makeSignal(2, { type: "sql_injection", ruleId: "JBG-SHARED-RULE-001" }),
    makeSignal(3, { type: "upload_risk", ruleId: "JBG-SHARED-RULE-001" })
  ];
  const assessment = createEngine().assess(signals);
  assert.equal(assessment.riskScore, 89);
  assert.equal(assessment.decision, "review");
});

test("confidence and severity thresholds produce challenge and observe outcomes", () => {
  const challenge = createEngine().assess([
    makeSignal(1, { severity: "high", confidence: 0.6 })
  ]);
  assert.equal(challenge.riskScore, 39);
  assert.equal(challenge.decision, "challenge");

  const observe = createEngine().assess([
    makeSignal(2, { severity: "info", confidence: 0.99 })
  ]);
  assert.equal(observe.riskScore, 5);
  assert.equal(observe.decision, "observe");
});

test("stale, future and below-floor signals are excluded from assessment", () => {
  const engine = createEngine();
  const result = engine.assess([
    makeSignal(1, { detectedAtMs: NOW - 400_000 }),
    makeSignal(2, { detectedAtMs: NOW + 1 }),
    makeSignal(3, { confidence: 0.2 })
  ]);
  assert.equal(result, null);
});

test("signals without an opaque subject key are not aggregated", () => {
  const signal = makeSignal(1);
  delete signal.subjectKey;
  delete signal.subjectKeyId;
  assert.equal(createEngine().assess([signal]), null);
});

test("signals from different pseudonymous subjects cannot be combined", () => {
  assert.throws(() => createEngine().assess([
    makeSignal(1),
    makeSignal(2, { subjectKey: "b".repeat(64) })
  ]), /different pseudonymous subjects/);
});

test("tenant and application isolation are enforced before scoring", () => {
  assert.throws(() => createEngine().assess([
    makeSignal(1, { tenantId: "another-tenant" })
  ]), /configured tenant and application/);
  assert.throws(() => createEngine().assess([
    makeSignal(1, { applicationId: "another-app" })
  ]), /configured tenant and application/);
});

test("duplicate signal IDs, invalid inputs and oversized batches are rejected", () => {
  const duplicate = makeSignal(1);
  assert.throws(() => createEngine().assess([duplicate, { ...duplicate }]), /duplicate threat signal IDs/);
  assert.throws(() => createEngine().assess("not-an-array"), /signals must be an array/);
  assert.throws(() => createEngine().assess(Array.from({ length: 129 }, (_, index) => makeSignal(index + 1))), /at most 128/);
});

test("disabled policies return no assessment and never trigger enforcement", () => {
  const engine = createEngine(makePolicy({ enabled: false }));
  assert.equal(engine.assess([makeSignal(1)]), null);
});

test("the maximum signal count selects the newest eligible signals deterministically", () => {
  const engine = createEngine(makePolicy({ maxSignals: 2 }));
  const assessment = engine.assess([
    makeSignal(1, { detectedAtMs: NOW - 30_000 }),
    makeSignal(2, { detectedAtMs: NOW - 20_000 }),
    makeSignal(3, { detectedAtMs: NOW - 10_000 })
  ]);
  assert.deepEqual(assessment.signalIds, [uuid(2), uuid(3)]);
});

test("invalid clocks and invalid generated assessment IDs fail closed", () => {
  const invalidClock = createThreatAssessmentEngine({
    policy: makePolicy(),
    clock: () => Number.NaN,
    idGenerator: () => uuid(10)
  });
  assert.throws(() => invalidClock.assess([makeSignal(1)]), /clock must return/);

  const invalidId = createThreatAssessmentEngine({
    policy: makePolicy(),
    clock: () => NOW,
    idGenerator: () => "not-a-uuid"
  });
  assert.throws(() => invalidId.assess([makeSignal(1)]), /UUID/);
});
