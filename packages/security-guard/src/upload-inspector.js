import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_SCANNER_TIMEOUT_MS = 15_000;
const DEFAULT_INGEST_TIMEOUT_MS = 30_000;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_SCANNER_TIMEOUT_MS = 120_000;
const MAX_INGEST_TIMEOUT_MS = 300_000;
const MAX_SIGNATURE_BYTES = 8_192;

const TYPE_DEFINITIONS = Object.freeze({
  "image/jpeg": Object.freeze({
    extensions: Object.freeze(["jpg", "jpeg"]),
    detect: (bytes) => bytes.length >= 3 &&
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }),
  "image/png": Object.freeze({
    extensions: Object.freeze(["png"]),
    detect: (bytes) => bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }),
  "image/gif": Object.freeze({
    extensions: Object.freeze(["gif"]),
    detect: (bytes) => bytes.length >= 6 &&
      (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
       bytes.subarray(0, 6).toString("ascii") === "GIF89a")
  }),
  "image/webp": Object.freeze({
    extensions: Object.freeze(["webp"]),
    detect: (bytes) => bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
  }),
  "application/pdf": Object.freeze({
    extensions: Object.freeze(["pdf"]),
    detect: (bytes) => bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-"
  })
});

const GENERIC_MIME_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream"
]);

const ERROR_MESSAGES = Object.freeze({
  INVALID_INPUT: "Upload input is invalid",
  UNSUPPORTED_TYPE: "File type is not allowed",
  MIME_MISMATCH: "Declared file type does not match its content",
  EXTENSION_MISMATCH: "File extension does not match its content",
  UPLOAD_TOO_LARGE: "Upload exceeds the configured size limit",
  STORAGE_UNAVAILABLE: "Quarantine storage is unavailable",
  STORAGE_TIMEOUT: "Quarantine storage adapter did not respond in time",
  INGEST_FAILED: "Upload could not be safely quarantined",
  INGEST_TIMEOUT: "Upload stream exceeded its ingestion time limit",
  SCANNER_UNAVAILABLE: "Malware scanner is unavailable",
  SCANNER_TIMEOUT: "Malware scan exceeded its time limit",
  SCAN_NOT_CLEAN: "File did not receive an explicit clean verdict",
  INVALID_SCAN_RESULT: "Malware scanner returned an invalid result",
  MALWARE_DETECTED: "File was rejected by malware scanning",
  APPROVAL_FAILED: "File could not be promoted to approved storage",
  PROCESSING_FAILED: "Upload could not be approved"
});

export class UploadInspectionError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.PROCESSING_FAILED);
    this.name = "UploadInspectionError";
    this.code = ERROR_MESSAGES[code] ? code : "PROCESSING_FAILED";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(name + " must be a positive integer no greater than " + maximum);
  }
  return value;
}

function safeNotify(onEvent, action, reason) {
  try {
    const result = onEvent(Object.freeze({
      timestamp: new Date().toISOString(),
      component: "jb-security-guard-upload",
      action,
      reason
    }));
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Telemetry must never change the upload decision.
  }
}

function detectMimeType(prefix, allowedMimeTypes) {
  for (const mimeType of allowedMimeTypes) {
    if (TYPE_DEFINITIONS[mimeType].detect(prefix)) return mimeType;
  }
  return null;
}

function getFileExtension(fileName) {
  if (fileName === undefined || fileName === null || fileName === "") return null;
  if (typeof fileName !== "string" || fileName.length > 255 || /[\u0000-\u001f\u007f]/.test(fileName)) {
    throw new UploadInspectionError("INVALID_INPUT");
  }

  const basename = fileName.split(/[\\/]/).pop() ?? "";
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return null;
  return basename.slice(dot + 1).toLowerCase();
}

function normalizeDeclaredMimeType(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 128) {
    throw new UploadInspectionError("INVALID_INPUT");
  }
  const normalized = value.split(";", 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)) {
    throw new UploadInspectionError("INVALID_INPUT");
  }
  return normalized;
}

function makeInspector(maxBytes, hash) {
  let size = 0;
  let prefix = Buffer.alloc(0);

  const transform = new Transform({
    transform(chunk, encoding, callback) {
      let bytes;
      if (Buffer.isBuffer(chunk)) bytes = chunk;
      else if (typeof chunk === "string") bytes = Buffer.from(chunk, encoding);
      else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk);
      else {
        callback(new UploadInspectionError("INGEST_FAILED"));
        return;
      }

      if (size + bytes.length > maxBytes) {
        callback(new UploadInspectionError("UPLOAD_TOO_LARGE"));
        return;
      }

      size += bytes.length;
      hash.update(bytes);
      if (prefix.length < MAX_SIGNATURE_BYTES) {
        const remaining = MAX_SIGNATURE_BYTES - prefix.length;
        prefix = Buffer.concat([prefix, bytes.subarray(0, remaining)]);
      }
      callback(null, bytes);
    }
  });

  return {
    transform,
    get size() { return size; },
    get prefix() { return prefix; }
  };
}

function makeScanVerificationStream(expectedSize, expectedSha256) {
  const hash = createHash("sha256");
  let size = 0;

  return new Transform({
    transform(chunk, encoding, callback) {
      let bytes;
      if (Buffer.isBuffer(chunk)) bytes = chunk;
      else if (typeof chunk === "string") bytes = Buffer.from(chunk, encoding);
      else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk);
      else {
        callback(new UploadInspectionError("INVALID_SCAN_RESULT"));
        return;
      }

      if (size + bytes.length > expectedSize) {
        callback(new UploadInspectionError("INVALID_SCAN_RESULT"));
        return;
      }

      size += bytes.length;
      hash.update(bytes);
      callback(null, bytes);
    },
    flush(callback) {
      const actualSha256 = hash.digest("hex");
      if (size !== expectedSize || actualSha256 !== expectedSha256) {
        callback(new UploadInspectionError("INVALID_SCAN_RESULT"));
        return;
      }
      callback();
    }
  });
}

function validScannerLabel(value) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 80 &&
    /^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/.test(value);
}

function validateStore(store) {
  if (!isRecord(store) ||
      typeof store.createWriteStream !== "function" ||
      typeof store.createReadStream !== "function" ||
      typeof store.promote !== "function" ||
      typeof store.delete !== "function") {
    throw new TypeError(
      "store must implement createWriteStream, createReadStream, promote, and delete"
    );
  }
}

function validateScanner(scanner) {
  if (!isRecord(scanner) || typeof scanner.scan !== "function") {
    throw new TypeError("scanner must implement scan(input)");
  }
}

async function deleteQuarantine(store, uploadId, onEvent) {
  let timeoutHandle;
  const deletePromise = Promise.resolve().then(() => store.delete({ uploadId }));
  deletePromise.catch(() => {});
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("cleanup timeout")), 5_000);
  });
  try {
    await Promise.race([deletePromise, timeoutPromise]);
  } catch {
    safeNotify(onEvent, "cleanup_failed", "quarantine_delete_failed");
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function runAdapterOperation(operation, timeoutMs, onLateValue) {
  let timeoutHandle;
  let timedOut = false;
  const operationPromise = Promise.resolve().then(operation);
  operationPromise.then((value) => {
    if (!timedOut || typeof onLateValue !== "function") return;
    try {
      const cleanup = onLateValue(value);
      if (cleanup && typeof cleanup.then === "function") cleanup.catch(() => {});
    } catch {
      // Late adapter cleanup must not create an unhandled rejection.
    }
  }, () => {});

  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(new UploadInspectionError("STORAGE_TIMEOUT"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function runIngest(source, transform, writer, timeoutMs) {
  let timeoutHandle;
  let timedOut = false;
  const ingestPromise = pipeline(source, transform, writer);
  // A timeout can win the race; keep later pipeline rejection observed.
  ingestPromise.catch(() => {});

  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      source.destroy?.();
      transform.destroy?.();
      writer.destroy?.();
      reject(new UploadInspectionError("INGEST_TIMEOUT"));
    }, timeoutMs);
  });

  try {
    await Promise.race([ingestPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) throw new UploadInspectionError("INGEST_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function runScanner(scanner, input, timeoutMs) {
  const controller = new AbortController();
  let timeoutHandle;
  let timedOut = false;

  const scanPromise = Promise.resolve().then(() => scanner.scan({
    ...input,
    signal: controller.signal
  }));
  // Attach a rejection handler even when the timeout wins the race.
  scanPromise.catch(() => {});

  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new UploadInspectionError("SCANNER_TIMEOUT"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([scanPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
    if (timedOut) input.stream.destroy?.();
  }
}

/**
 * Create a fail-closed upload inspection pipeline.
 *
 * Storage adapter contract:
 * - createWriteStream({ uploadId }) returns a writable private-quarantine stream.
 * - createReadStream({ uploadId }) returns a readable stream for that quarantined object.
 * - promote({ uploadId, metadata }) atomically moves it to the approved namespace
 *   and resolves with { promoted: true } only after the promotion is committed.
 * - delete({ uploadId }) deletes the quarantine object.
 *
 * Scanner contract:
 * - scan({ stream, uploadId, size, sha256, detectedMimeType, signal })
 *   consumes the complete verified stream and resolves with
 *   { verdict: "clean" | "malicious" | "unknown", engine, version }.
 */
export function createUploadInspector(options = {}) {
  if (!isRecord(options)) throw new TypeError("upload inspector options must be an object");

  const allowedOptions = new Set([
    "store", "scanner", "maxBytes", "scannerTimeoutMs", "ingestTimeoutMs", "allowedMimeTypes", "onEvent"
  ]);
  for (const key of Object.keys(options)) {
    if (!allowedOptions.has(key)) throw new TypeError("Unknown upload inspector option: " + key);
  }

  validateStore(options.store);
  validateScanner(options.scanner);

  const store = options.store;
  const scanner = options.scanner;
  const maxBytes = positiveInteger(
    options.maxBytes ?? DEFAULT_MAX_BYTES,
    "maxBytes",
    MAX_UPLOAD_BYTES
  );
  const scannerTimeoutMs = positiveInteger(
    options.scannerTimeoutMs ?? DEFAULT_SCANNER_TIMEOUT_MS,
    "scannerTimeoutMs",
    MAX_SCANNER_TIMEOUT_MS
  );
  const ingestTimeoutMs = positiveInteger(
    options.ingestTimeoutMs ?? DEFAULT_INGEST_TIMEOUT_MS,
    "ingestTimeoutMs",
    MAX_INGEST_TIMEOUT_MS
  );

  const allowedMimeTypes = Object.freeze([...(options.allowedMimeTypes ?? Object.keys(TYPE_DEFINITIONS))]);
  if (!Array.isArray(allowedMimeTypes) ||
      allowedMimeTypes.length === 0 ||
      allowedMimeTypes.some((type) => typeof type !== "string" || !Object.hasOwn(TYPE_DEFINITIONS, type)) ||
      new Set(allowedMimeTypes).size !== allowedMimeTypes.length) {
    throw new TypeError("allowedMimeTypes must be a non-empty list of supported built-in MIME types");
  }

  const onEvent = options.onEvent ?? (() => {});
  if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");

  async function inspect({ source, fileName, declaredMimeType } = {}) {
    if (!source || typeof source.pipe !== "function" || typeof source.on !== "function" ||
        source.readable === false || source.readableFlowing === true) {
      throw new UploadInspectionError("INVALID_INPUT");
    }

    const extension = getFileExtension(fileName);
    const declaredType = normalizeDeclaredMimeType(declaredMimeType);
    const uploadId = randomUUID();
    let quarantineAttempted = false;
    let retainQuarantine = false;

    try {
      quarantineAttempted = true;
      let quarantineWriter;
      try {
        quarantineWriter = await runAdapterOperation(
          () => store.createWriteStream({ uploadId }),
          ingestTimeoutMs,
          (lateWriter) => {
            lateWriter?.destroy?.();
            return deleteQuarantine(store, uploadId, onEvent);
          }
        );
      } catch (error) {
        if (error instanceof UploadInspectionError) {
          source.destroy?.();
          throw error;
        }
        throw new UploadInspectionError("STORAGE_UNAVAILABLE");
      }
      if (!quarantineWriter || typeof quarantineWriter.write !== "function" ||
          typeof quarantineWriter.on !== "function") {
        throw new UploadInspectionError("STORAGE_UNAVAILABLE");
      }

      const hash = createHash("sha256");
      const inspector = makeInspector(maxBytes, hash);
      try {
        await runIngest(source, inspector.transform, quarantineWriter, ingestTimeoutMs);
      } catch (error) {
        if (error instanceof UploadInspectionError) throw error;
        throw new UploadInspectionError("INGEST_FAILED");
      }

      if (inspector.size === 0) throw new UploadInspectionError("UNSUPPORTED_TYPE");

      const detectedMimeType = detectMimeType(inspector.prefix, allowedMimeTypes);
      if (!detectedMimeType) throw new UploadInspectionError("UNSUPPORTED_TYPE");

      if (extension && !TYPE_DEFINITIONS[detectedMimeType].extensions.includes(extension)) {
        throw new UploadInspectionError("EXTENSION_MISMATCH");
      }
      if (declaredType && !GENERIC_MIME_TYPES.has(declaredType) && declaredType !== detectedMimeType) {
        throw new UploadInspectionError("MIME_MISMATCH");
      }

      const sha256 = hash.digest("hex");
      let scanStream;
      try {
        scanStream = await runAdapterOperation(
          () => store.createReadStream({ uploadId }),
          ingestTimeoutMs,
          (lateStream) => lateStream?.destroy?.()
        );
      } catch (error) {
        retainQuarantine = true;
        if (error instanceof UploadInspectionError) throw error;
        throw new UploadInspectionError("SCANNER_UNAVAILABLE");
      }
      if (!scanStream || typeof scanStream.pipe !== "function" || typeof scanStream.on !== "function") {
        retainQuarantine = true;
        throw new UploadInspectionError("SCANNER_UNAVAILABLE");
      }

      let scanResult;
      let verifiedScanStream;
      let scanPipeline;
      try {
        verifiedScanStream = makeScanVerificationStream(inspector.size, sha256);
        scanPipeline = pipeline(scanStream, verifiedScanStream);
        // A scanner can fail or return early; keep pipeline rejection handled
        // while the scanner is consuming the verified readable side.
        scanPipeline.catch(() => {});

        scanResult = await runScanner(scanner, {
          stream: verifiedScanStream,
          uploadId,
          size: inspector.size,
          sha256,
          detectedMimeType
        }, scannerTimeoutMs);

        if (verifiedScanStream.readableEnded !== true) {
          throw new UploadInspectionError("INVALID_SCAN_RESULT");
        }
        await scanPipeline;
      } catch (error) {
        retainQuarantine = true;
        if (error instanceof UploadInspectionError) throw error;
        throw new UploadInspectionError("SCANNER_UNAVAILABLE");
      } finally {
        verifiedScanStream?.destroy?.();
        scanStream.destroy?.();
      }

      if (!isRecord(scanResult) || !["clean", "malicious", "unknown"].includes(scanResult.verdict)) {
        retainQuarantine = true;
        throw new UploadInspectionError("INVALID_SCAN_RESULT");
      }
      if (scanResult.verdict === "malicious") {
        throw new UploadInspectionError("MALWARE_DETECTED");
      }
      if (scanResult.verdict !== "clean") {
        retainQuarantine = true;
        throw new UploadInspectionError("SCAN_NOT_CLEAN");
      }
      if (!validScannerLabel(scanResult.engine) || !validScannerLabel(scanResult.version)) {
        retainQuarantine = true;
        throw new UploadInspectionError("INVALID_SCAN_RESULT");
      }

      const metadata = Object.freeze({
        size: inspector.size,
        sha256,
        mimeType: detectedMimeType,
        scanner: Object.freeze({
          engine: scanResult.engine,
          version: scanResult.version
        }),
        scannedAt: new Date().toISOString()
      });

      let promotion;
      try {
        promotion = await store.promote({
          uploadId,
          metadata,
          expectedSha256: sha256,
          expectedSize: inspector.size
        });
      } catch {
        retainQuarantine = true;
        throw new UploadInspectionError("APPROVAL_FAILED");
      }
      if (!isRecord(promotion) || promotion.promoted !== true) {
        retainQuarantine = true;
        throw new UploadInspectionError("APPROVAL_FAILED");
      }

      safeNotify(onEvent, "approved", "clean_scan");
      return Object.freeze({
        status: "approved",
        uploadId,
        ...metadata
      });
    } catch (error) {
      if (quarantineAttempted && !retainQuarantine) {
        await deleteQuarantine(store, uploadId, onEvent);
      }
      const code = error instanceof UploadInspectionError ? error.code : "PROCESSING_FAILED";
      safeNotify(onEvent, retainQuarantine ? "quarantined" : "rejected", code.toLowerCase());
      throw new UploadInspectionError(code);
    }
  }

  return Object.freeze({ inspect });
}
