import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  createSecurityAssessment,
  createSecurityBridgeCoordinator,
  createSecurityBridgeServer
} from "../src/security-bridge/index.js";
import {
  createSecurityBridgeClient,
  SecurityBridgeClientError,
  createUploadInspector,
  UploadInspectionError
} from "@jb/security-guard";

const SECRET = "integration-test-bridge-secret-at-least-32-bytes";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("Bridge integration fixture")
]);

function createMemoryStore() {
  const quarantine = new Map();
  const approved = new Map();
  const calls = [];
  return {
    quarantine, approved, calls,
    async createWriteStream({ uploadId }) {
      const chunks = [];
      return new Writable({
        write(chunk, encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          quarantine.set(uploadId, Buffer.concat(chunks));
          calls.push("quarantined");
          callback();
        }
      });
    },
    async createReadStream({ uploadId }) {
      return Readable.from([quarantine.get(uploadId)]);
    },
    async promote({ uploadId, metadata, expectedSha256, expectedSize }) {
      const bytes = quarantine.get(uploadId);
      if (!bytes || bytes.length !== expectedSize ||
          createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
        return { promoted: false };
      }
      approved.set(uploadId, { bytes, metadata });
      quarantine.delete(uploadId);
      calls.push("promoted");
      return { promoted: true };
    },
    async delete({ uploadId }) {
      quarantine.delete(uploadId);
      calls.push("deleted");
      return { deleted: true };
    }
  };
}

function cleanScanner() {
  return {
    async scan({ stream, signal }) {
      let size = 0;
      for await (const chunk of stream) {
        if (signal.aborted) throw new Error("aborted");
        size += chunk.length;
      }
      assert.equal(size, PNG.length);
      return { verdict: "clean", engine: "MockAV", version: "1.0" };
    }
  };
}

function startBridge({ expertVerdict = "pass", expertSeverity = "low" } = {}) {
  const correlationId = "download-asset-123456";
  const coordinator = createSecurityBridgeCoordinator();
  coordinator.submit(createSecurityAssessment({
    correlationId,
    producer: "jb-expert-qa",
    verdict: expertVerdict,
    severity: expertSeverity,
    reasonCode: expertVerdict === "pass" ? "QA-NAV-001" : "QA-NAV-BLOCK"
  }));
  const server = createSecurityBridgeServer({
    coordinator,
    secrets: { "jb-security-guard": SECRET }
  });
  return {
    correlationId, coordinator, server,
    async start() {
      const address = await server.listen();
      return createSecurityBridgeClient({
        url: "http://127.0.0.1:" + address.port,
        secret: SECRET
      });
    }
  };
}

test("clean upload promotion requires a pass from both independent filters", async () => {
  const bridge = startBridge();
  const client = await bridge.start();
  const store = createMemoryStore();
  try {
    const inspector = createUploadInspector({ store, scanner: cleanScanner(), securityBridge: client });
    const result = await inspector.inspect({
      source: Readable.from([PNG]),
      fileName: "product.png",
      correlationId: bridge.correlationId
    });
    assert.equal(result.status, "approved");
    assert.equal(store.approved.get(result.uploadId).bytes.equals(PNG), true);
    assert.equal(store.quarantine.size, 0);
    assert.deepEqual(store.calls, ["quarantined", "promoted"]);
    assert.equal(bridge.coordinator.getDecision(bridge.correlationId).action, "allow");
  } finally {
    await bridge.server.close();
  }
});

test("missing Expert QA approval keeps a clean upload quarantined", async () => {
  const coordinator = createSecurityBridgeCoordinator();
  const server = createSecurityBridgeServer({ coordinator, secrets: { "jb-security-guard": SECRET } });
  const address = await server.listen();
  const client = createSecurityBridgeClient({
    url: "http://127.0.0.1:" + address.port,
    secret: SECRET
  });
  const store = createMemoryStore();
  try {
    const inspector = createUploadInspector({ store, scanner: cleanScanner(), securityBridge: client });
    await assert.rejects(inspector.inspect({
      source: Readable.from([PNG]),
      fileName: "pending.png",
      correlationId: "pending-asset-123456"
    }), (error) => error instanceof UploadInspectionError &&
      error.code === "BRIDGE_REVIEW_REQUIRED");
    assert.equal(store.approved.size, 0);
    assert.equal(store.quarantine.size, 1);
    assert.equal(store.calls.includes("promoted"), false);
  } finally {
    await server.close();
  }
});

test("Expert QA block overrides a clean file scan", async () => {
  const bridge = startBridge({ expertVerdict: "block", expertSeverity: "critical" });
  const client = await bridge.start();
  const store = createMemoryStore();
  try {
    const inspector = createUploadInspector({ store, scanner: cleanScanner(), securityBridge: client });
    await assert.rejects(inspector.inspect({
      source: Readable.from([PNG]),
      fileName: "blocked.png",
      correlationId: bridge.correlationId
    }), (error) => error.code === "BRIDGE_BLOCKED");
    assert.equal(store.approved.size, 0);
    assert.equal(store.quarantine.size, 1);
    assert.equal(bridge.coordinator.getDecision(bridge.correlationId).action, "block");
  } finally {
    await bridge.server.close();
  }
});

test("bridge outage fails closed and retains a clean file in quarantine", async () => {
  const store = createMemoryStore();
  const inspector = createUploadInspector({
    store,
    scanner: cleanScanner(),
    securityBridge: { async submitAssessment() { throw new Error("private endpoint detail"); } }
  });
  await assert.rejects(inspector.inspect({
    source: Readable.from([PNG]),
    fileName: "offline.png",
    correlationId: "offline-asset-12345"
  }), (error) => error.code === "BRIDGE_UNAVAILABLE" &&
    !error.message.includes("private endpoint detail"));
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
  assert.equal(store.calls.includes("promoted"), false);
});

test("inconclusive malware scan is reported as quarantine and never promoted", async () => {
  const bridge = startBridge();
  const client = await bridge.start();
  const store = createMemoryStore();
  const scanner = {
    async scan({ stream }) {
      for await (const chunk of stream) void chunk;
      return { verdict: "unknown", engine: "MockAV", version: "1.0" };
    }
  };
  try {
    const inspector = createUploadInspector({ store, scanner, securityBridge: client });
    await assert.rejects(inspector.inspect({
      source: Readable.from([PNG]),
      fileName: "unknown.png",
      correlationId: bridge.correlationId
    }), (error) => error.code === "SCAN_NOT_CLEAN");
    assert.equal(bridge.coordinator.getDecision(bridge.correlationId).action, "quarantine");
    assert.equal(store.approved.size, 0);
    assert.equal(store.quarantine.size, 1);
  } finally {
    await bridge.server.close();
  }
});

test("malware findings are sent to the coordinator as critical blocks", async () => {
  const bridge = startBridge();
  const client = await bridge.start();
  const store = createMemoryStore();
  const scanner = {
    async scan({ stream }) {
      for await (const chunk of stream) void chunk;
      return { verdict: "malicious", engine: "MockAV", version: "1.0" };
    }
  };
  try {
    const inspector = createUploadInspector({ store, scanner, securityBridge: client });
    await assert.rejects(inspector.inspect({
      source: Readable.from([PNG]),
      fileName: "malware.png",
      correlationId: bridge.correlationId
    }), (error) => error.code === "MALWARE_DETECTED");
    assert.equal(bridge.coordinator.getDecision(bridge.correlationId).action, "block");
    assert.equal(store.approved.size, 0);
    assert.equal(store.quarantine.size, 0);
  } finally {
    await bridge.server.close();
  }
});

test("client rejects public endpoints and unsigned decisions", async () => {
  assert.throws(() => createSecurityBridgeClient({
    url: "http://example.com:3100", secret: SECRET
  }), /only permits an explicit 127.0.0.1/);
  assert.throws(() => createSecurityBridgeClient({
    url: "https://127.0.0.1:3100", secret: SECRET
  }), /only permits an explicit 127.0.0.1/);

  const fakeFetch = async () => ({
    ok: true,
    async json() {
      return {
        decision: {
          schema: "jb.security.decision/v1",
          correlationId: "forged-asset-12345",
          action: "allow",
          status: "complete",
          requiredProducers: ["jb-expert-qa", "jb-security-guard"],
          missingProducers: [],
          assessments: [
            { producer: "jb-expert-qa", verdict: "pass", severity: "low" },
            { producer: "jb-security-guard", verdict: "pass", severity: "low" }
          ],
          evaluatedAt: new Date().toISOString()
        },
        sentAt: new Date().toISOString(),
        signature: "0".repeat(64)
      };
    }
  });
  const client = createSecurityBridgeClient({
    url: "http://127.0.0.1:3100",
    secret: SECRET,
    fetchImpl: fakeFetch
  });
  await assert.rejects(client.submitAssessment({
    correlationId: "forged-asset-12345",
    verdict: "pass",
    severity: "low",
    reasonCode: "JBG-TEST-001"
  }), (error) => error instanceof SecurityBridgeClientError &&
    error.code === "INVALID_DECISION_SIGNATURE");
});

test("the client rejects a signed allow decision for a different correlation ID", async () => {
  const sentAt = new Date().toISOString();
  const decision = {
    schema: "jb.security.decision/v1",
    correlationId: "other-resource-123456",
    action: "allow",
    status: "complete",
    requiredProducers: ["jb-expert-qa", "jb-security-guard"],
    missingProducers: [],
    assessments: [
      { producer: "jb-expert-qa", verdict: "pass", severity: "low", evidence: {} },
      { producer: "jb-security-guard", verdict: "pass", severity: "low", evidence: { sha256: "a".repeat(64) } }
    ],
    evaluatedAt: sentAt
  };
  const signature = createHmac("sha256", SECRET)
    .update(Buffer.from(JSON.stringify({ decision, sentAt }), "utf8"))
    .digest("hex");
  const client = createSecurityBridgeClient({
    url: "http://127.0.0.1:3100",
    secret: SECRET,
    fetchImpl: async () => ({
      ok: true,
      async json() { return { decision, sentAt, signature }; }
    })
  });

  await assert.rejects(client.submitAssessment({
    correlationId: "this-resource-123456",
    verdict: "pass",
    severity: "low",
    reasonCode: "JBG-TEST-002",
    evidence: { sha256: "a".repeat(64) }
  }), (error) => error.code === "CORRELATION_MISMATCH");
});

test("the client rejects an allow decision whose Guard hash differs from the submitted file", async () => {
  const sentAt = new Date().toISOString();
  const decision = {
    schema: "jb.security.decision/v1",
    correlationId: "same-resource-123456",
    action: "allow",
    status: "complete",
    requiredProducers: ["jb-expert-qa", "jb-security-guard"],
    missingProducers: [],
    assessments: [
      { producer: "jb-expert-qa", verdict: "pass", severity: "low", evidence: {} },
      { producer: "jb-security-guard", verdict: "pass", severity: "low", evidence: { sha256: "b".repeat(64) } }
    ],
    evaluatedAt: sentAt
  };
  const signature = createHmac("sha256", SECRET)
    .update(Buffer.from(JSON.stringify({ decision, sentAt }), "utf8"))
    .digest("hex");
  const client = createSecurityBridgeClient({
    url: "http://127.0.0.1:3100",
    secret: SECRET,
    fetchImpl: async () => ({
      ok: true,
      async json() { return { decision, sentAt, signature }; }
    })
  });

  await assert.rejects(client.submitAssessment({
    correlationId: "same-resource-123456",
    verdict: "pass",
    severity: "low",
    reasonCode: "JBG-TEST-003",
    evidence: { sha256: "a".repeat(64) }
  }), (error) => error.code === "RESOURCE_MISMATCH");
});

test("bridge-enabled upload requires a valid shared correlation ID", async () => {
  const store = createMemoryStore();
  const inspector = createUploadInspector({
    store,
    scanner: cleanScanner(),
    securityBridge: { async submitAssessment() { return { action: "allow", status: "complete" }; } }
  });
  await assert.rejects(inspector.inspect({
    source: Readable.from([PNG]), fileName: "missing-id.png"
  }), (error) => error.code === "INVALID_INPUT");
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 0);
});
