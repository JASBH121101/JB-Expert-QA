import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { createUploadInspector, UploadInspectionError } from "@jb/security-guard";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("JB test image payload")
]);

function createMemoryStore() {
  const quarantine = new Map();
  const approved = new Map();
  const calls = [];

  return {
    quarantine,
    approved,
    calls,
    async createWriteStream({ uploadId }) {
      calls.push(["createWriteStream", uploadId]);
      const chunks = [];
      return new Writable({
        write(chunk, encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          quarantine.set(uploadId, Buffer.concat(chunks));
          callback();
        }
      });
    },
    async createReadStream({ uploadId }) {
      calls.push(["createReadStream", uploadId]);
      const bytes = quarantine.get(uploadId);
      if (!bytes) throw new Error("missing quarantine object");
      return Readable.from([bytes]);
    },
    async promote({ uploadId, metadata, expectedSha256, expectedSize }) {
      calls.push(["promote", uploadId, expectedSha256, expectedSize]);
      const bytes = quarantine.get(uploadId);
      if (!bytes ||
          bytes.length !== expectedSize ||
          createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
        return { promoted: false };
      }
      approved.set(uploadId, { bytes, metadata });
      quarantine.delete(uploadId);
      return { promoted: true };
    },
    async delete({ uploadId }) {
      calls.push(["delete", uploadId]);
      // Delete an uncommitted upload from quarantine or a late private promotion.
      quarantine.delete(uploadId);
      approved.delete(uploadId);
      return { deleted: true };
    }
  };
}

function cleanScanner() {
  return {
    async scan({ stream, signal }) {
      let consumed = 0;
      for await (const chunk of stream) {
        if (signal.aborted) throw new Error("scan aborted");
        consumed += chunk.length;
      }
      assert.ok(consumed > 0, "scanner must consume the complete quarantined object");
      return { verdict: "clean", engine: "MockAV", version: "1.0" };
    }
  };
}

function inspector(store, scanner = cleanScanner(), options = {}) {
  return createUploadInspector({ store, scanner, ...options });
}

test("clean signature-validated uploads are scanned from quarantine before promotion", async () => {
  const store = createMemoryStore();
  const result = await inspector(store).inspect({
    source: Readable.from([PNG]),
    fileName: "product.png",
    declaredMimeType: "image/png"
  });

  assert.equal(result.status, "approved");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.size, PNG.length);
  assert.equal(result.sha256, createHash("sha256").update(PNG).digest("hex"));
  assert.equal(result.scanner.engine, "MockAV");
  assert.equal(result.attestation.schema, "jb.security.upload-inspection.attestation/v1");
  assert.equal(result.attestation.uploadId, result.uploadId);
  assert.equal(result.attestation.verdict, "clean");
  assert.equal(result.attestation.sha256, result.sha256);
  assert.equal(result.attestation.size, result.size);
  assert.equal(result.attestation.mimeType, result.mimeType);
  assert.equal(result.attestation.engine, "MockAV");
  assert.equal(result.attestation.version, "1.0");
  assert.ok(Number.isSafeInteger(result.attestation.scannedAtMs));
  assert.deepEqual(store.approved.get(result.uploadId).metadata.attestation, result.attestation);
  assert.equal(store.approved.get(result.uploadId).bytes.equals(PNG), true);
  assert.equal(store.quarantine.has(result.uploadId), false);
  assert.deepEqual(store.calls.map(([name]) => name), [
    "createWriteStream", "createReadStream", "promote"
  ]);
  const promotionCall = store.calls.find(([name]) => name === "promote");
  assert.equal(promotionCall[2], result.sha256);
  assert.equal(promotionCall[3], result.size);
});

test("unsupported signatures are rejected and never promoted", async () => {
  const store = createMemoryStore();
  await assert.rejects(
    inspector(store).inspect({
      source: Readable.from([Buffer.from("<script>alert(1)</script>")]),
      fileName: "image.png",
      declaredMimeType: "image/png"
    }),
    (error) => error instanceof UploadInspectionError && error.code === "UNSUPPORTED_TYPE"
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 0);
  assert.ok(store.calls.some(([name]) => name === "delete"));
});

test("declared MIME type and filename extension must agree with detected bytes", async () => {
  const store = createMemoryStore();
  await assert.rejects(
    inspector(store).inspect({
      source: Readable.from([PNG]),
      fileName: "image.jpg",
      declaredMimeType: "image/png"
    }),
    (error) => error.code === "EXTENSION_MISMATCH"
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 0);
});

test("generic client MIME types are tolerated but active content is not allowlisted", async () => {
  const store = createMemoryStore();
  const result = await inspector(store).inspect({
    source: Readable.from([PNG]),
    fileName: "image.png",
    declaredMimeType: "application/octet-stream"
  });
  assert.equal(result.status, "approved");

  const secondStore = createMemoryStore();
  await assert.rejects(
    inspector(secondStore).inspect({
      source: Readable.from([Buffer.from("<svg onload=alert(1)>")]),
      fileName: "image.svg",
      declaredMimeType: "image/svg+xml"
    }),
    (error) => error.code === "UNSUPPORTED_TYPE"
  );
  assert.equal(secondStore.approved.size, 0);
});

test("uploads exceeding the streaming byte cap are stopped and removed from quarantine", async () => {
  const store = createMemoryStore();
  await assert.rejects(
    inspector(store, cleanScanner(), { maxBytes: 12 }).inspect({
      source: Readable.from([PNG]),
      fileName: "large.png"
    }),
    (error) => error.code === "UPLOAD_TOO_LARGE"
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 0);
});

test("scanner stream digest must match even when tampered content has the same size", async () => {
  const store = createMemoryStore();
  store.createReadStream = async ({ uploadId }) => {
    const tampered = Buffer.from(store.quarantine.get(uploadId));
    tampered[tampered.length - 1] ^= 0x01;
    return Readable.from([tampered]);
  };

  await assert.rejects(
    inspector(store).inspect({
      source: Readable.from([PNG]),
      fileName: "tampered-in-quarantine.png"
    }),
    (error) => error.code === "INVALID_SCAN_RESULT"
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
  assert.equal(store.calls.some(([name]) => name === "promote"), false);
});

test("scanner stream cannot contain more bytes than the original upload", async () => {
  const store = createMemoryStore();
  store.createReadStream = async ({ uploadId }) => {
    const original = store.quarantine.get(uploadId);
    return Readable.from([Buffer.concat([original, Buffer.from("extra")])]);
  };

  await assert.rejects(
    inspector(store).inspect({
      source: Readable.from([PNG]),
      fileName: "extended-in-quarantine.png"
    }),
    (error) => error.code === "INVALID_SCAN_RESULT"
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
  assert.equal(store.calls.some(([name]) => name === "promote"), false);
});

test("promotion adapter must verify the exact scanned object before approval", async () => {
  const store = createMemoryStore();
  const scanner = {
    async scan({ stream }) {
      for await (const chunk of stream) void chunk;
      store.quarantine.set([...store.quarantine.keys()][0], Buffer.from("changed after scan"));
      return { verdict: "clean", engine: "MockAV", version: "1.0" };
    }
  };

  await assert.rejects(
    inspector(store, scanner).inspect({
      source: Readable.from([PNG]),
      fileName: "changed-after-scan.png"
    }),
    (error) => error.code === "APPROVAL_FAILED"
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
  const promotionCall = store.calls.find(([name]) => name === "promote");
  assert.equal(promotionCall[2], createHash("sha256").update(PNG).digest("hex"));
  assert.equal(promotionCall[3], PNG.length);
});

test("malware verdicts are rejected and the quarantined object is retained privately", async () => {
  const store = createMemoryStore();
  const events = [];
  const scanner = {
    async scan({ stream }) {
      for await (const chunk of stream) void chunk;
      return { verdict: "malicious", engine: "MockAV", version: "1.0" };
    }
  };
  await assert.rejects(
    inspector(store, scanner, { onEvent: (event) => events.push(event) }).inspect({ source: Readable.from([PNG]), fileName: "bad.png" }),
    (error) => {
      assert.equal(error.code, "MALWARE_DETECTED");
      assert.equal(error.attestation.schema, "jb.security.upload-inspection.attestation/v1");
      assert.equal(error.attestation.verdict, "malicious");
      assert.equal(error.attestation.sha256, createHash("sha256").update(PNG).digest("hex"));
      assert.equal(error.attestation.size, PNG.length);
      return true;
    }
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
  assert.equal([...store.quarantine.values()][0].equals(PNG), true);
  assert.equal(store.calls.some(([name]) => name === "promote"), false);
  assert.equal(store.calls.some(([name]) => name === "delete"), false);
  assert.equal(events.at(-1)?.action, "quarantined");
});

test("unknown scan verdicts remain quarantined and cannot be promoted", async () => {
  const store = createMemoryStore();
  const scanner = {
    async scan({ stream }) {
      for await (const chunk of stream) void chunk;
      return { verdict: "unknown", engine: "MockAV", version: "1.0" };
    }
  };
  await assert.rejects(
    inspector(store, scanner).inspect({ source: Readable.from([PNG]), fileName: "unknown.png" }),
    (error) => {
      assert.equal(error.code, "SCAN_NOT_CLEAN");
      assert.equal(error.attestation.schema, "jb.security.upload-inspection.attestation/v1");
      assert.equal(error.attestation.verdict, "unknown");
      assert.equal(error.attestation.sha256, createHash("sha256").update(PNG).digest("hex"));
      assert.equal(error.attestation.size, PNG.length);
      return true;
    }
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
  assert.equal(store.calls.some(([name]) => name === "promote"), false);
});

test("stalled upload streams time out and are removed from quarantine", async () => {
  const store = createMemoryStore();
  const source = new Readable({ read() {} });
  await assert.rejects(
    inspector(store, cleanScanner(), { ingestTimeoutMs: 20 }).inspect({
      source,
      fileName: "stalled.png"
    }),
    (error) => error.code === "INGEST_TIMEOUT"
  );
  assert.equal(source.destroyed, true);
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 0);
  assert.ok(store.calls.some(([name]) => name === "delete"));
});

test("scanner outages fail closed and leave the object quarantined", async () => {
  const store = createMemoryStore();
  const scanner = { async scan() { throw new Error("private scanner details"); } };
  await assert.rejects(
    inspector(store, scanner).inspect({ source: Readable.from([PNG]), fileName: "offline.png" }),
    (error) => error.code === "SCANNER_UNAVAILABLE" && !error.message.includes("private")
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
});

test("scanner timeouts abort the scan and leave the object quarantined", async () => {
  const store = createMemoryStore();
  let aborted = false;
  const scanner = {
    scan({ signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    }
  };
  await assert.rejects(
    inspector(store, scanner, { scannerTimeoutMs: 20 }).inspect({
      source: Readable.from([PNG]),
      fileName: "timeout.png"
    }),
    (error) => error.code === "SCANNER_TIMEOUT"
  );
  assert.equal(aborted, true);
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
});

test("scanner cannot approve a file without consuming the complete quarantined stream", async () => {
  const store = createMemoryStore();
  const scanner = {
    async scan() {
      return { verdict: "clean", engine: "MockAV", version: "1.0" };
    }
  };

  await assert.rejects(
    inspector(store, scanner).inspect({
      source: Readable.from([PNG]),
      fileName: "not-fully-scanned.png"
    }),
    (error) => {
      assert.equal(error.code, "SCAN_INCOMPLETE");
      assert.equal(Object.hasOwn(error, "attestation"), false);
      return true;
    }
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
  assert.equal(store.calls.some(([name]) => name === "promote"), false);
});

test("malformed clean verdicts and missing scanner identity fail closed", async () => {
  const store = createMemoryStore();
  const scanner = {
    async scan({ stream }) {
      for await (const chunk of stream) void chunk;
      return { verdict: "clean", engine: "", version: "1.0" };
    }
  };
  await assert.rejects(
    inspector(store, scanner).inspect({ source: Readable.from([PNG]), fileName: "bad-result.png" }),
    (error) => error.code === "INVALID_SCAN_RESULT"
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
});

test("promotion failures never return an approved object", async () => {
  const store = createMemoryStore();
  store.promote = async () => { throw new Error("private storage detail"); };
  await assert.rejects(
    inspector(store).inspect({ source: Readable.from([PNG]), fileName: "promotion.png" }),
    (error) => error.code === "APPROVAL_FAILED" && !error.message.includes("private")
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
});

test("input streams are required and invalid configuration is rejected", async () => {
  const store = createMemoryStore();
  assert.throws(() => inspector(store, cleanScanner(), { allowedMimeTypes: ["image/svg+xml"] }),
    /supported built-in MIME types/);
  assert.throws(() => createUploadInspector({ store, scanner: {} }), /scanner must implement/);

  await assert.rejects(
    inspector(store).inspect({ source: {}, fileName: "image.png" }),
    (error) => error.code === "INVALID_INPUT"
  );
});

test("upload events never include original filenames or storage/scanner errors", async () => {
  const events = [];
  const store = createMemoryStore();
  const scanner = { async scan() { throw new Error("secret scanner endpoint"); } };
  await assert.rejects(
    inspector(store, scanner, { onEvent: (event) => events.push(event) }).inspect({
      source: Readable.from([PNG]),
      fileName: "private-customer-document.png"
    })
  );
  assert.equal(events.some((event) => JSON.stringify(event).includes("private-customer")), false);
  assert.equal(events.some((event) => JSON.stringify(event).includes("secret scanner endpoint")), false);
  assert.equal(events.at(-1).action, "quarantined");
});


test("storage writer initialization is bounded and fails closed when the adapter never responds", async () => {
  const store = createMemoryStore();
  store.createWriteStream = () => new Promise(() => {});
  const source = Readable.from([PNG]);

  await assert.rejects(
    inspector(store, cleanScanner(), { ingestTimeoutMs: 50 }).inspect({
      source,
      fileName: "storage-timeout.png"
    }),
    (error) => error.code === "STORAGE_TIMEOUT"
  );

  assert.equal(source.destroyed, true);
  assert.equal(store.approved.size, 0);
  assert.equal(store.calls.some(([name]) => name === "delete"), true);
});

test("quarantine read-stream initialization is bounded and the upload remains quarantined", async () => {
  const store = createMemoryStore();
  store.createReadStream = () => new Promise(() => {});

  await assert.rejects(
    inspector(store, cleanScanner(), { ingestTimeoutMs: 50 }).inspect({
      source: Readable.from([PNG]),
      fileName: "read-timeout.png"
    }),
    (error) => error.code === "STORAGE_TIMEOUT"
  );

  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
  assert.equal(store.calls.some(([name]) => name === "promote"), false);
});


test("a quarantine writer that resolves after timeout is destroyed and cleaned up", async () => {
  const store = createMemoryStore();
  const createWriter = store.createWriteStream.bind(store);
  let uploadId;
  let resolveLateWriter;
  const lateWriterPromise = new Promise((resolve) => { resolveLateWriter = resolve; });
  store.createWriteStream = async (input) => {
    uploadId = input.uploadId;
    return lateWriterPromise;
  };

  await assert.rejects(
    inspector(store, cleanScanner(), { ingestTimeoutMs: 50 }).inspect({
      source: Readable.from([PNG]),
      fileName: "late-writer.png"
    }),
    (error) => error.code === "STORAGE_TIMEOUT"
  );

  const lateWriter = await createWriter({ uploadId });
  resolveLateWriter(lateWriter);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(lateWriter.destroyed, true);
  assert.equal(store.approved.size, 0);
  assert.ok(store.calls.filter(([name]) => name === "delete").length >= 2);
});


test("a quarantine read stream that resolves after timeout is destroyed", async () => {
  const store = createMemoryStore();
  let uploadId;
  let resolveLateStream;
  const lateStreamPromise = new Promise((resolve) => { resolveLateStream = resolve; });
  store.createReadStream = async (input) => {
    uploadId = input.uploadId;
    return lateStreamPromise;
  };

  await assert.rejects(
    inspector(store, cleanScanner(), { ingestTimeoutMs: 50 }).inspect({
      source: Readable.from([PNG]),
      fileName: "late-read-stream.png"
    }),
    (error) => error.code === "STORAGE_TIMEOUT"
  );

  const lateStream = Readable.from([store.quarantine.get(uploadId)]);
  resolveLateStream(lateStream);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(lateStream.destroyed, true);
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.has(uploadId), true);
  assert.equal(store.calls.some(([name]) => name === "promote"), false);
});


test("upload Core v1 reports promotion only after clean scanning and omits file metadata", async () => {
  const store = createMemoryStore();
  const events = [];
  const fileName = "private-catalog-image.png";
  const result = await inspector(store, cleanScanner(), {
    coreContract: { tenantId: "tenant-upload", applicationId: "catalog-api" },
    onCoreEvent: (event) => events.push(event)
  }).inspect({
    source: Readable.from([PNG]),
    fileName,
    declaredMimeType: "image/png"
  });

  assert.equal(result.status, "approved");
  assert.equal(events.length, 1);
  assert.equal(events[0].schema, "jb.security.event/v1");
  assert.equal(events[0].category, "upload");
  assert.equal(events[0].ruleId, "JBG-UPLOAD-SCAN-001");
  assert.equal(events[0].action, "promoted");
  assert.equal(events[0].outcome, "success");
  assert.equal(events[0].scope, "clean_scan");
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(fileName), false);
  assert.equal(serialized.includes(result.sha256), false);
  assert.equal(events[0].correlationId, result.uploadId, "the generated upload UUID is the event correlation ID");
});

test("upload Core v1 distinguishes malware rejection from a quarantined unknown verdict", async () => {
  const maliciousStore = createMemoryStore();
  const maliciousEvents = [];
  const maliciousScanner = {
    async scan({ stream }) {
      for await (const chunk of stream) void chunk;
      return { verdict: "malicious", engine: "MockAV", version: "1.0" };
    }
  };
  await assert.rejects(
    inspector(maliciousStore, maliciousScanner, {
      coreContract: { tenantId: "tenant-upload", applicationId: "catalog-api" },
      onCoreEvent: (event) => maliciousEvents.push(event)
    }).inspect({
      source: Readable.from([PNG]),
      fileName: "private-malware-sample.png"
    }),
    (error) => error.code === "MALWARE_DETECTED"
  );
  assert.equal(maliciousEvents.length, 1);
  assert.equal(maliciousEvents[0].ruleId, "JBG-MALWARE-001");
  assert.equal(maliciousEvents[0].severity, "critical");
  assert.equal(maliciousEvents[0].action, "rejected");
  assert.equal(maliciousEvents[0].outcome, "denied");

  const unknownStore = createMemoryStore();
  const unknownEvents = [];
  const unknownScanner = {
    async scan({ stream }) {
      for await (const chunk of stream) void chunk;
      return { verdict: "unknown", engine: "MockAV", version: "1.0" };
    }
  };
  await assert.rejects(
    inspector(unknownStore, unknownScanner, {
      coreContract: { tenantId: "tenant-upload", applicationId: "catalog-api" },
      onCoreEvent: (event) => unknownEvents.push(event)
    }).inspect({
      source: Readable.from([PNG]),
      fileName: "private-unknown-sample.png"
    }),
    (error) => error.code === "SCAN_NOT_CLEAN"
  );
  assert.equal(unknownEvents.length, 1);
  assert.equal(unknownEvents[0].ruleId, "JBG-UPLOAD-QUARANTINE-001");
  assert.equal(unknownEvents[0].action, "quarantined");
  assert.equal(unknownEvents[0].outcome, "observed");
  const serialized = JSON.stringify([...maliciousEvents, ...unknownEvents]);
  assert.equal(serialized.includes("private-malware-sample.png"), false);
  assert.equal(serialized.includes("private-unknown-sample.png"), false);
  assert.equal(serialized.includes(createHash("sha256").update(PNG).digest("hex")), false);
});

test("upload Core v1 telemetry failures never alter the upload decision", async () => {
  const store = createMemoryStore();
  const result = await inspector(store, cleanScanner(), {
    coreContract: { tenantId: "tenant-upload", applicationId: "catalog-api" },
    onCoreEvent() { throw new Error("telemetry unavailable"); }
  }).inspect({ source: Readable.from([PNG]), fileName: "product.png" });
  assert.equal(result.status, "approved");
  assert.equal(store.approved.size, 1);
});


test("a stalled security bridge fails clean uploads closed and retains quarantine", async () => {
  const store = createMemoryStore();
  const securityBridge = {
    submitAssessment() { return new Promise(() => {}); }
  };

  await assert.rejects(
    inspector(store, cleanScanner(), { securityBridge, bridgeTimeoutMs: 20 }).inspect({
      source: Readable.from([PNG]),
      fileName: "bridge-timeout.png",
      correlationId: "bridge-timeout-001"
    }),
    (error) => error.code === "BRIDGE_UNAVAILABLE"
  );

  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
  assert.equal(store.calls.some(([name]) => name === "promote"), false);
});

test("a stalled security bridge cannot delay local rejection of a malicious upload indefinitely", async () => {
  const store = createMemoryStore();
  const maliciousScanner = {
    async scan({ stream }) {
      for await (const chunk of stream) void chunk;
      return { verdict: "malicious", engine: "MockAV", version: "1.0" };
    }
  };
  const securityBridge = {
    submitAssessment() { return new Promise(() => {}); }
  };

  await assert.rejects(
    inspector(store, maliciousScanner, { securityBridge, bridgeTimeoutMs: 20 }).inspect({
      source: Readable.from([PNG]),
      fileName: "malicious-bridge-timeout.png",
      correlationId: "bridge-timeout-002"
    }),
    (error) => error.code === "MALWARE_DETECTED"
  );

  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 0);
  assert.ok(store.calls.some(([name]) => name === "delete"));
});


test("a stalled storage promotion is aborted and remains quarantined", async () => {
  const store = createMemoryStore();
  let abortObserved = false;
  store.promote = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      abortObserved = true;
      reject(new Error("promotion aborted"));
    }, { once: true });
  });

  await assert.rejects(
    inspector(store, cleanScanner(), { promotionTimeoutMs: 20 }).inspect({
      source: Readable.from([PNG]),
      fileName: "promotion-timeout.png"
    }),
    (error) => error.code === "APPROVAL_TIMEOUT"
  );

  assert.equal(abortObserved, true);
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
});

test("a late promotion is cleaned by opaque upload ID and never left in approved storage", async () => {
  const store = createMemoryStore();
  let uploadId;
  store.promote = async ({ uploadId: id, metadata, expectedSha256, expectedSize }) => {
    uploadId = id;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const bytes = store.quarantine.get(id);
    if (!bytes ||
        bytes.length !== expectedSize ||
        createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      return { promoted: false };
    }
    // Model a non-cooperative adapter completing late into a private approved namespace.
    store.approved.set(id, { bytes, metadata });
    store.quarantine.delete(id);
    return { promoted: true };
  };

  await assert.rejects(
    inspector(store, cleanScanner(), { promotionTimeoutMs: 20 }).inspect({
      source: Readable.from([PNG]),
      fileName: "late-promotion.png"
    }),
    (error) => error.code === "APPROVAL_TIMEOUT"
  );

  assert.ok(uploadId);
  assert.equal(store.approved.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(store.approved.has(uploadId), false);
  assert.equal(store.quarantine.has(uploadId), false);
  assert.ok(store.calls.some(([name, id]) => name === "delete" && id === uploadId));
});

const sharedUploadVectors = JSON.parse(await readFile(
  new URL("../packages/security-guard-core/tests/fixtures/upload-inspection/conformance-vectors.v1.json", import.meta.url),
  "utf8"
));

for (const vector of sharedUploadVectors.fileCases) {
  test("shared upload contract file vector: " + vector.id, async () => {
    const store = createMemoryStore();
    const bytes = Buffer.from(vector.bytesHex, "hex");
    const scanner = {
      async scan({ stream }) {
        for await (const chunk of stream) void chunk;
        return { verdict: vector.scannerVerdict, engine: "MockAV", version: "1.0" };
      }
    };

    let result = null;
    let error = null;
    try {
      result = await inspector(store, scanner).inspect({
        source: Readable.from([bytes]),
        fileName: vector.fileName,
        declaredMimeType: vector.declaredMimeType
      });
    } catch (caught) {
      error = caught;
    }

    if (vector.expected.disposition === "approved") {
      assert.equal(error, null, vector.id);
      assert.equal(result.mimeType, vector.expected.mimeType);
      assert.equal(store.approved.get(result.uploadId).bytes.equals(bytes), true);
      assert.equal(store.quarantine.size, 0);
    } else {
      assert.equal(error?.code, vector.expected.errorReason, vector.id);
      assert.equal(store.approved.size, 0);
      assert.equal(store.quarantine.size, 0);
    }
  });
}

for (const vector of sharedUploadVectors.scannerCases) {
  test("shared upload contract scanner vector: " + vector.id, async () => {
    const store = createMemoryStore();
    const bytes = PNG;
    const scanner = {
      async scan({ stream }) {
        if (vector.consume === "all") {
          for await (const chunk of stream) void chunk;
        }
        return { verdict: vector.verdict, engine: "MockAV", version: "1.0" };
      }
    };

    let result = null;
    let error = null;
    try {
      result = await inspector(store, scanner).inspect({
        source: Readable.from([bytes]),
        fileName: "shared-vector.png",
        declaredMimeType: "image/png"
      });
    } catch (caught) {
      error = caught;
    }

    if (vector.expected.disposition === "approved") {
      assert.equal(error, null, vector.id);
      assert.equal(result.status, "approved");
      assert.equal(store.approved.get(result.uploadId).bytes.equals(bytes), true);
      assert.equal(store.quarantine.size, 0);
    } else {
      assert.equal(error?.code, vector.expected.errorReason, vector.id);
      assert.equal(store.approved.size, 0);
      assert.equal(
        store.quarantine.size,
        vector.expected.disposition === "quarantined" ? 1 : 0,
        vector.id
      );
    }
  });
}

