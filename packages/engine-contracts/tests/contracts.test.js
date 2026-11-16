import test from "node:test";
import assert from "node:assert/strict";
import {
  assertEngineManifest,
  assertMessageEnvelope,
  evaluateEngineCompatibility,
  parseStableVersion,
  validateEngineManifest,
  validateMessageEnvelope
} from "../src/index.js";

function manifest(engineId, version, overrides = {}) {
  return {
    schema: "jb.engine.manifest/v1",
    engineId,
    version,
    contractsProvided: [],
    contractsConsumed: [],
    dependencies: [],
    capabilities: [],
    ...overrides
  };
}

function envelope(overrides = {}) {
  return {
    schema: "jb.engine.message/v1",
    messageId: "message-0001",
    correlationId: "correlation-01",
    producer: { engineId: "jb.security-guard", version: "1.2.0" },
    contract: { id: "jb.security.signal", version: "1.0.0" },
    kind: "threat.observed",
    occurredAt: "2026-11-16T21:00:00.000Z",
    classification: "internal",
    semantics: "advisory",
    payload: { signal: "suspicious", score: 0.7 },
    ...overrides
  };
}

test("stable version parser accepts MAJOR.MINOR.PATCH only", () => {
  assert.deepEqual(parseStableVersion("2.10.3"), { major: 2, minor: 10, patch: 3 });
  for (const value of ["v1.2.3", "1.2", "01.2.3", "1.2.3-beta.1", 1]) {
    assert.equal(parseStableVersion(value), null);
  }
});

test("manifest accepts exact known contract fields", () => {
  const result = validateEngineManifest(manifest("jb.security-guard", "1.2.0"));
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("manifest rejects missing and unknown root fields", () => {
  const invalid = { ...manifest("jb.security-guard", "1.2.0"), runShell: true };
  const result = validateEngineManifest(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("manifest has missing or unknown fields"));
});

test("manifest rejects malformed identifiers and prerelease versions", () => {
  assert.equal(validateEngineManifest(manifest("security", "1.0.0")).valid, false);
  assert.equal(validateEngineManifest(manifest("jb.security-guard", "1.0.0-beta")).valid, false);
});

test("manifest rejects duplicate contracts, dependencies and capabilities", () => {
  const invalid = manifest("jb.resilience-engine", "0.6.0", {
    contractsProvided: [
      { id: "jb.engine.incident", version: "1.0.0" },
      { id: "jb.engine.incident", version: "1.1.0" }
    ],
    dependencies: [
      { engineId: "jb.security-guard", minVersion: "1.0.0", maxMajor: 1, optional: false },
      { engineId: "jb.security-guard", minVersion: "1.0.0", maxMajor: 1, optional: true }
    ],
    capabilities: ["monitor.health", "monitor.health"]
  });
  const result = validateEngineManifest(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("duplicate contract IDs")));
  assert.ok(result.errors.some((error) => error.includes("duplicate engine IDs")));
  assert.ok(result.errors.some((error) => error.includes("capabilities contains duplicates")));
});

test("manifest rejects self dependencies", () => {
  const result = validateEngineManifest(manifest("jb.security-guard", "1.0.0", {
    dependencies: [{ engineId: "jb.security-guard", minVersion: "1.0.0", maxMajor: 1, optional: false }]
  }));
  assert.ok(result.errors.includes("engine cannot depend on itself"));
});

test("assert manifest throws on invalid input", () => {
  assert.throws(() => assertEngineManifest({}), /Invalid JB Engine manifest/);
});

test("message accepts advisory evidence envelope", () => {
  assert.equal(validateMessageEnvelope(envelope()).valid, true);
});

test("message rejects authority semantics", () => {
  for (const semantics of ["authorize", "execute", "trusted", true]) {
    assert.equal(validateMessageEnvelope(envelope({ semantics })).valid, false);
  }
});

test("message rejects unknown fields and malformed timestamps", () => {
  assert.equal(validateMessageEnvelope(envelope({ shell: "rm -rf /" })).valid, false);
  assert.equal(validateMessageEnvelope(envelope({ occurredAt: "yesterday" })).valid, false);
});

test("message rejects unsafe nested keys and non-JSON values", () => {
  const unsafe = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal(validateMessageEnvelope(envelope({ payload: unsafe })).valid, false);
  assert.equal(validateMessageEnvelope(envelope({ payload: { value: Number.NaN } })).valid, false);
  assert.equal(validateMessageEnvelope(envelope({ payload: { value: undefined } })).valid, false);
});

test("message rejects cyclic payloads and excessive depth", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(validateMessageEnvelope(envelope({ payload: cyclic })).valid, false);
  let deep = {};
  let cursor = deep;
  for (let index = 0; index < 14; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  assert.equal(validateMessageEnvelope(envelope({ payload: deep })).valid, false);
});

test("message enforces payload size and collection bounds", () => {
  assert.equal(validateMessageEnvelope(envelope({ payload: { value: "x".repeat(65_537) } })).valid, false);
  assert.equal(validateMessageEnvelope(envelope({ payload: { values: Array(257).fill("x") } })).valid, false);
});

test("message assertion rejects malformed envelopes", () => {
  assert.throws(() => assertMessageEnvelope(envelope({ semantics: "authorization" })), /Invalid JB Engine message/);
});

test("compatibility passes a correctly satisfied dependency and message contract", () => {
  const provider = manifest("jb.security-guard", "1.3.0", {
    contractsProvided: [{ id: "jb.security.signal", version: "1.2.0" }]
  });
  const consumer = manifest("jb.resilience-engine", "0.6.0", {
    contractsConsumed: [{ id: "jb.security.signal", minVersion: "1.0.0", maxMajor: 1 }],
    dependencies: [{ engineId: "jb.security-guard", minVersion: "1.0.0", maxMajor: 1, optional: false }]
  });
  const result = evaluateEngineCompatibility({ engines: [provider, consumer] });
  assert.equal(result.compatible, true);
  assert.deepEqual(result.errors, []);
});

test("compatibility rejects absent mandatory engines and contracts", () => {
  const consumer = manifest("jb.resilience-engine", "0.6.0", {
    contractsConsumed: [{ id: "jb.security.signal", minVersion: "1.0.0", maxMajor: 1 }],
    dependencies: [{ engineId: "jb.security-guard", minVersion: "1.0.0", maxMajor: 1, optional: false }]
  });
  const result = evaluateEngineCompatibility({ engines: [consumer] });
  assert.equal(result.compatible, false);
  assert.ok(result.errors.some((error) => error.includes("required dependency missing")));
  assert.ok(result.errors.some((error) => error.includes("no compatible provider")));
});

test("compatibility warns on an absent optional engine", () => {
  const consumer = manifest("jb.resilience-engine", "0.6.0", {
    dependencies: [{ engineId: "jb.security-guard", minVersion: "1.0.0", maxMajor: 1, optional: true }]
  });
  const result = evaluateEngineCompatibility({ engines: [consumer] });
  assert.equal(result.compatible, true);
  assert.equal(result.warnings.length, 1);
});

test("compatibility rejects unsupported major versions", () => {
  const provider = manifest("jb.security-guard", "2.0.0", {
    contractsProvided: [{ id: "jb.security.signal", version: "2.0.0" }]
  });
  const consumer = manifest("jb.resilience-engine", "0.6.0", {
    contractsConsumed: [{ id: "jb.security.signal", minVersion: "1.0.0", maxMajor: 1 }],
    dependencies: [{ engineId: "jb.security-guard", minVersion: "1.0.0", maxMajor: 1, optional: false }]
  });
  const result = evaluateEngineCompatibility({ engines: [provider, consumer] });
  assert.equal(result.compatible, false);
});

test("compatibility detects dependency cycles", () => {
  const first = manifest("jb.security-guard", "1.0.0", {
    dependencies: [{ engineId: "jb.resilience-engine", minVersion: "0.6.0", maxMajor: 0, optional: false }]
  });
  const second = manifest("jb.resilience-engine", "0.6.0", {
    dependencies: [{ engineId: "jb.security-guard", minVersion: "1.0.0", maxMajor: 1, optional: false }]
  });
  const result = evaluateEngineCompatibility({ engines: [first, second] });
  assert.equal(result.compatible, false);
  assert.ok(result.errors.some((error) => error.includes("dependency cycle detected")));
});
