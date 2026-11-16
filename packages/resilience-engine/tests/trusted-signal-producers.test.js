import test from "node:test";
import assert from "node:assert/strict";
import {
  createSecurityGuardSignalProducer
} from "../src/producers/security-guard.js";
import {
  createMalwareEngineSignalProducer
} from "../src/producers/malware-engine.js";
import {
  validateTrustedSignalEnvelope
} from "../src/trusted-signal-gateway.js";

const KEY = "host-owned-test-key-material-at-least-32-bytes";
const CONFIG = {
  sourceId: "engine-primary",
  environment: "test",
  assetId: "host-test-01",
  signingKey: KEY,
  ttlMs: 60_000
};
const UUID = "00000000-0000-4000-8000-000000000010";
const SHA = "a".repeat(64);
const NOW = 1_800_000_000_000;

function assessment(decision = "block") {
  return {
    schema: "jb.security.threat-assessment/v1",
    assessmentId: UUID,
    tenantId: "tenant-01",
    applicationId: "app-01",
    assessedAtMs: NOW,
    riskScore: 82,
    decision,
    signalIds: [UUID],
    policyId: "policy-01"
  };
}

function securityEvent(action = "blocked") {
  return {
    schema: "jb.security.event/v1",
    eventId: UUID,
    occurredAtMs: NOW,
    tenantId: "tenant-01",
    applicationId: "app-01",
    producer: "security-guard-node",
    category: "threat",
    ruleId: "JBG-THREAT-001",
    severity: "high",
    action,
    outcome: action === "blocked" ? "denied" : "observed"
  };
}

function scanReport(status = "malicious") {
  return {
    status,
    reason: null,
    path: "/private/test/sample.bin",
    sha256: SHA,
    bytes: 128,
    heuristicScore: status === "suspicious" ? 78 : 0,
    scannedAt: new Date(NOW).toISOString()
  };
}

test("Security Guard block assessments become suspected, never confirmed", () => {
  const producer = createSecurityGuardSignalProducer(CONFIG);
  const signal = producer.fromThreatAssessment(assessment("block"));

  assert.equal(signal.sourceEngine, "security-guard");
  assert.equal(signal.state, "suspected");
  assert.equal(signal.severity, "high");
  assert.equal(signal.reasonCode, "SECURITY_GUARD_BLOCK");
  assert.deepEqual(signal.evidenceRefs, []);
  assert.equal(validateTrustedSignalEnvelope(signal).signature, signal.signature);
});

test("Security Guard observe assessments remain unknown rather than clean", () => {
  const producer = createSecurityGuardSignalProducer(CONFIG);
  const signal = producer.fromThreatAssessment(assessment("observe"));

  assert.equal(signal.state, "unknown");
  assert.equal(signal.reasonCode, "SECURITY_GUARD_OBSERVE");
});

test("Security Guard Core v1 threat events preserve event identity and remain conservative", () => {
  const producer = createSecurityGuardSignalProducer(CONFIG);
  const blocked = producer.fromSecurityEvent(securityEvent("blocked"));
  const observed = producer.fromSecurityEvent(securityEvent("observed"));

  assert.equal(blocked.eventId, UUID);
  assert.equal(blocked.state, "suspected");
  assert.equal(observed.state, "unknown");
  assert.equal(blocked.reasonCode, "SECURITY_GUARD_THREAT_EVENT");
});

test("Security Guard adapter rejects unsupported or malformed assessments/events", () => {
  const producer = createSecurityGuardSignalProducer(CONFIG);
  assert.throws(() => producer.fromThreatAssessment({ ...assessment(), decision: "clean" }), /valid Security Guard/);
  assert.throws(() => producer.fromSecurityEvent({
    ...securityEvent(),
    category: "request"
  }), /supported Security Guard/);
  assert.throws(() => createSecurityGuardSignalProducer({
    ...CONFIG,
    signingKey: "short"
  }), /32 UTF-8 bytes/);
});

test("Malware exact detections become confirmed only with matching retained evidence", () => {
  const producer = createMalwareEngineSignalProducer(CONFIG);
  const signal = producer.fromScanReport(scanReport("malicious"), {
    evidenceRefs: [{ refId: "evidence:sample-01", sha256: SHA }]
  });

  assert.equal(signal.sourceEngine, "malware-engine");
  assert.equal(signal.state, "confirmed");
  assert.equal(signal.severity, "critical");
  assert.deepEqual(signal.evidenceRefs, [{
    refId: "evidence:sample-01",
    sha256: SHA
  }]);
  assert.match(validateTrustedSignalEnvelope(signal).eventId, /^[0-9a-f-]{36}$/i);
  assert.equal(signal.eventId, producer.fromScanReport(scanReport("malicious"), {
    evidenceRefs: [{ refId: "evidence:sample-01", sha256: SHA }]
  }).eventId);
});

test("Malware malicious reports without retained evidence are downgraded to suspected", () => {
  const producer = createMalwareEngineSignalProducer(CONFIG);
  const signal = producer.fromScanReport(scanReport("malicious"));

  assert.equal(signal.state, "suspected");
  assert.equal(signal.severity, "high");
  assert.deepEqual(signal.evidenceRefs, []);
});

test("Malware suspicious reports are suspected and no_match/unknown remain unknown", () => {
  const producer = createMalwareEngineSignalProducer(CONFIG);
  const suspicious = producer.fromScanReport(scanReport("suspicious"));
  const noMatch = producer.fromScanReport(scanReport("no_match"));
  const unknown = producer.fromScanReport({
    status: "unknown",
    scannedAt: new Date(NOW).toISOString()
  });

  assert.equal(suspicious.state, "suspected");
  assert.equal(suspicious.severity, "high");
  assert.equal(noMatch.state, "unknown");
  assert.equal(unknown.state, "unknown");
});

test("Malware adapter rejects evidence with a mismatching digest and malformed reports", () => {
  const producer = createMalwareEngineSignalProducer({
    ...CONFIG,
  });
  assert.throws(() => producer.fromScanReport(scanReport("malicious"), {
    evidenceRefs: [{ refId: "evidence:bad", sha256: "b".repeat(64) }]
  }), /must match the scanned report/);
  assert.throws(() => producer.fromScanReport({
    ...scanReport("malicious"),
    sha256: "bad"
  }), /report.sha256 is invalid/);
  assert.throws(() => producer.fromScanReport({
    ...scanReport("unknown"),
    scannedAt: "not-a-date"
  }), /supported JB Malware Engine/);
});

test("producer adapters do not issue clear or tampered verdicts", () => {
  const guard = createSecurityGuardSignalProducer(CONFIG);
  const malware = createMalwareEngineSignalProducer(CONFIG);
  const states = [
    guard.fromThreatAssessment(assessment("observe")).state,
    guard.fromThreatAssessment(assessment("block")).state,
    malware.fromScanReport(scanReport("no_match")).state,
    malware.fromScanReport(scanReport("malicious")).state
  ];
  assert.equal(states.includes("clear"), false);
  assert.equal(states.includes("tampered"), false);
});

test("producer envelopes flow through the gateway without granting recovery authorization", async () => {
  const {
    createMemoryTrustedSignalStore,
    createTrustedSignalGateway
  } = await import("../src/trusted-signal-gateway.js");
  const gateway = createTrustedSignalGateway({
    sources: [
      {
        sourceId: "guard-primary",
        engine: "security-guard",
        environment: "test",
        assetIds: ["host-test-01"],
        key: KEY
      },
      {
        sourceId: "malware-primary",
        engine: "malware-engine",
        environment: "test",
        assetIds: ["host-test-01"],
        key: KEY
      }
    ],
    replayStore: createMemoryTrustedSignalStore(),
    requireDurableStore: false,
    allowInMemoryStore: true,
    clock: () => NOW
  });
  const guard = createSecurityGuardSignalProducer({
    ...CONFIG,
    sourceId: "guard-primary"
  });
  const malware = createMalwareEngineSignalProducer({
    ...CONFIG,
    sourceId: "malware-primary"
  });
  const guardResult = await gateway.ingest(guard.fromThreatAssessment(assessment("block")));
  const malwareResult = await gateway.ingest(malware.fromScanReport(scanReport("malicious"), {
    evidenceRefs: [{ refId: "evidence:sample-01", sha256: SHA }]
  }));
  const state = await gateway.getSecurityState({
    assetId: "host-test-01",
    environment: "test"
  });

  assert.equal(guardResult.accepted, true);
  assert.equal(malwareResult.accepted, true);
  assert.notEqual(state.state, "clear");
  assert.equal(state.authorizationGranted, false);
  assert.equal(state.preserveEvidence, true);
});
