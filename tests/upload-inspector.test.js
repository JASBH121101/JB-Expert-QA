import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    async promote({ uploadId, metadata }) {
      calls.push(["promote", uploadId]);
      if (!quarantine.has(uploadId)) return { promoted: false };
      approved.set(uploadId, { bytes: quarantine.get(uploadId), metadata });
      quarantine.delete(uploadId);
      return { promoted: true };
    },
    async delete({ uploadId }) {
      calls.push(["delete", uploadId]);
      quarantine.delete(uploadId);
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
  assert.equal(store.approved.get(result.uploadId).bytes.equals(PNG), true);
  assert.equal(store.quarantine.has(result.uploadId), false);
  assert.deepEqual(store.calls.map(([name]) => name), [
    "createWriteStream", "createReadStream", "promote"
  ]);
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

test("malware verdicts are rejected and the quarantined object is deleted", async () => {
  const store = createMemoryStore();
  const scanner = {
    async scan({ stream }) {
      for await (const chunk of stream) void chunk;
      return { verdict: "malicious", engine: "MockAV", version: "1.0" };
    }
  };
  await assert.rejects(
    inspector(store, scanner).inspect({ source: Readable.from([PNG]), fileName: "bad.png" }),
    (error) => error.code === "MALWARE_DETECTED"
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 0);
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
    (error) => error.code === "SCAN_NOT_CLEAN"
  );
  assert.equal(store.approved.size, 0);
  assert.equal(store.quarantine.size, 1);
  assert.equal(store.calls.some(([name]) => name === "promote"), false);
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
