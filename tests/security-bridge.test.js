import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import {
  createSecurityAssessment,
  createSecurityBridgeCoordinator,
  createSecurityBridgeServer,
  signSecurityAssessment
} from "../src/security-bridge/index.js";

const SECRET = "test-only-bridge-secret-with-at-least-32-bytes";

function assessment(producer, correlationId, overrides = {}) {
  return createSecurityAssessment({
    correlationId,
    producer,
    verdict: "pass",
    severity: "low",
    reasonCode: producer === "jb-expert-qa" ? "QA-NAV-001" : "JBG-UPLOAD-001",
    ...overrides
  });
}

function post(port, envelope) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(envelope);
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/v1/assessments",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

async function withServer(run, options = {}) {
  const coordinator = createSecurityBridgeCoordinator(options);
  const server = createSecurityBridgeServer({
    coordinator,
    secrets: { "jb-security-guard": SECRET }
  });
  const address = await server.listen();
  try {
    await run({ coordinator, server, address });
  } finally {
    await server.close();
  }
}

test("the double filter stays pending until Expert QA and Security Guard both pass", () => {
  const coordinator = createSecurityBridgeCoordinator();
  const correlationId = "asset-12345678";
  const first = coordinator.submit(assessment("jb-expert-qa", correlationId));
  assert.equal(first.action, "review");
  assert.equal(first.status, "pending");
  assert.deepEqual(first.missingProducers, ["jb-security-guard"]);

  const second = coordinator.submit(assessment("jb-security-guard", correlationId));
  assert.equal(second.action, "allow");
  assert.equal(second.status, "complete");
  assert.deepEqual(second.missingProducers, []);
});

test("a block decision cannot be downgraded by a later clean assessment", () => {
  const coordinator = createSecurityBridgeCoordinator();
  const correlationId = "asset-22345678";
  const blocked = coordinator.submit(assessment("jb-security-guard", correlationId, {
    verdict: "block",
    severity: "critical",
    reasonCode: "JBG-MALWARE-001"
  }));
  assert.equal(blocked.action, "block");

  const afterClean = coordinator.submit(assessment("jb-security-guard", correlationId, {
    verdict: "pass",
    severity: "info",
    reasonCode: "JBG-UPLOAD-002"
  }));
  assert.equal(afterClean.action, "block");
});

test("a correlation cannot combine different known file hashes", () => {
  const coordinator = createSecurityBridgeCoordinator();
  const correlationId = "asset-32345678";
  coordinator.submit(assessment("jb-expert-qa", correlationId, {
    evidence: { sha256: "a".repeat(64) }
  }));
  assert.throws(() => coordinator.submit(assessment("jb-security-guard", correlationId, {
    evidence: { sha256: "b".repeat(64) }
  })), (error) => error.code === "RESOURCE_MISMATCH");
});

test("the loopback receiver accepts a signed Security Guard assessment and returns pending", async () => {
  await withServer(async ({ address }) => {
    const item = assessment("jb-security-guard", "asset-42345678");
    const result = await post(address.port, signSecurityAssessment(item, SECRET));
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.decision.action, "review");
    assert.equal(result.body.decision.status, "pending");
  });
});

test("invalid signatures and stale messages are rejected", async () => {
  await withServer(async ({ address }) => {
    const item = assessment("jb-security-guard", "asset-52345678");
    const signed = signSecurityAssessment(item, SECRET);
    const invalid = await post(address.port, { ...signed, signature: "0".repeat(64) });
    assert.equal(invalid.statusCode, 401);
    assert.equal(invalid.body.error, "invalid_signature");

    const stale = signSecurityAssessment(item, SECRET, "2020-01-01T00:00:00.000Z");
    const expired = await post(address.port, stale);
    assert.equal(expired.statusCode, 401);
    assert.equal(expired.body.error, "expired_envelope");
  });
});

test("bridge storage is bounded and refuses capacity overflow rather than evicting live incidents", () => {
  const coordinator = createSecurityBridgeCoordinator({ maxCorrelations: 1, maxEvents: 2 });
  coordinator.submit(assessment("jb-expert-qa", "asset-62345678"));
  assert.throws(() => coordinator.submit(assessment("jb-expert-qa", "asset-72345678")),
    (error) => error.code === "CAPACITY_REACHED");
  assert.equal(coordinator.getStats().correlations, 1);
});

test("invalid producer, identifiers and evidence are rejected", () => {
  assert.throws(() => createSecurityAssessment({
    correlationId: "short",
    producer: "unknown",
    verdict: "pass",
    severity: "low",
    reasonCode: "QA-001"
  }), (error) => error.code === "INVALID_ASSESSMENT");
});
