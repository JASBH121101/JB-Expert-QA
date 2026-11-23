import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const GENESIS_HASH = "GENESIS";

function stableValue(value, seen = new Set(), depth = 0) {
  if (depth > 32) throw new RangeError("Execution ledger value is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Execution ledger numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Execution ledger values cannot be circular");
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen, depth + 1));
    seen.delete(value);
    return result;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Execution ledger values must be JSON-compatible data");
  }
  if (seen.has(value)) throw new TypeError("Execution ledger values cannot be circular");
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new TypeError("Execution ledger contains a forbidden object key");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("Execution ledger values cannot contain accessors");
    }
    result[key] = stableValue(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}

export function stableExecutionJson(value) {
  return JSON.stringify(stableValue(value));
}

export function digestExecutionValue(value) {
  return createHash("sha256").update(stableExecutionJson(value), "utf8").digest("hex");
}

function freezeRecord(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRecord(child);
    Object.freeze(value);
  }
  return value;
}

function copyRecord(value) {
  return JSON.parse(stableExecutionJson(value));
}

export function verifyExecutionLedger(records) {
  if (!Array.isArray(records)) throw new TypeError("Execution ledger records must be an array");
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return Object.freeze({ valid: false, entries: index, reason: "invalid-record" });
    }
    if (record.sequence !== index + 1 || record.previousHash !== previousHash ||
        typeof record.hash !== "string" || !/^[a-f0-9]{64}$/u.test(record.hash)) {
      return Object.freeze({ valid: false, entries: index, reason: "broken-chain" });
    }
    const unsigned = { ...record };
    delete unsigned.hash;
    let expectedHash;
    try {
      expectedHash = digestExecutionValue(unsigned);
    } catch {
      return Object.freeze({ valid: false, entries: index, reason: "invalid-record-data" });
    }
    if (expectedHash !== record.hash) {
      return Object.freeze({ valid: false, entries: index, reason: "hash-mismatch" });
    }
    previousHash = record.hash;
  }
  return Object.freeze({
    valid: true,
    entries: records.length,
    lastHash: previousHash
  });
}

function createLedger({ initialRecords = [], persist = async () => {}, now = () => new Date(), closeResource = async () => {} } = {}) {
  const records = initialRecords.map((record) => freezeRecord(copyRecord(record)));
  const initialVerification = verifyExecutionLedger(records);
  if (!initialVerification.valid) throw new Error("Execution ledger integrity verification failed");
  let queue = Promise.resolve();
  let closed = false;

  function append(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.event !== "string" || !entry.event.trim()) {
      return Promise.reject(new TypeError("Execution ledger entries require an event name"));
    }
    for (const reserved of ["sequence", "previousHash", "hash"]) {
      if (Object.hasOwn(entry, reserved)) {
        return Promise.reject(new TypeError("Execution ledger field is reserved: " + reserved));
      }
    }
    const operation = queue.then(async () => {
      if (closed) throw new Error("Execution ledger is closed");
      const timestamp = entry.timestamp ?? now().toISOString();
      if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
        throw new TypeError("Execution ledger timestamp must be a valid ISO date string");
      }
      const data = copyRecord({ ...entry, timestamp });
      const previousHash = records.length ? records[records.length - 1].hash : GENESIS_HASH;
      const unsigned = {
        ...data,
        sequence: records.length + 1,
        previousHash
      };
      const record = freezeRecord({
        ...unsigned,
        hash: digestExecutionValue(unsigned)
      });
      await persist(record);
      records.push(record);
      return record;
    });
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  return Object.freeze({
    append,
    snapshot: () => Object.freeze(records.map((record) => freezeRecord(copyRecord(record)))),
    verify: () => verifyExecutionLedger(records),
    close: async () => {
      await queue;
      if (closed) return;
      closed = true;
      await closeResource();
    }
  });
}

export function createInMemoryExecutionLedger(options = {}) {
  return createLedger(options);
}

/**
 * Creates a single-writer JSONL ledger. File permissions are restricted where
 * the host OS supports POSIX modes. The hash chain detects accidental edits,
 * truncation and reordering; it is not a substitute for OS-level file access
 * controls or a remote immutable audit store.
 */
export async function createJsonlExecutionLedger(filePath, { now = () => new Date() } = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new TypeError("A ledger file path is required");
  }
  const absolutePath = resolve(filePath);
  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
  try {
    const current = await lstat(absolutePath);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new Error("Execution ledger path must be a regular file, not a symlink");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const flags = constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | (constants.O_NOFOLLOW || 0);
  const handle = await open(absolutePath, flags, 0o600);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("Execution ledger path is not a regular file");
    await handle.chmod(0o600).catch(() => {});
    const text = await handle.readFile({ encoding: "utf8" });
    const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    let initialRecords;
    try {
      initialRecords = lines.map((line) => JSON.parse(line));
    } catch {
      throw new Error("Execution ledger contains an invalid JSONL record");
    }
    const verification = verifyExecutionLedger(initialRecords);
    if (!verification.valid) throw new Error("Execution ledger integrity verification failed");
    return createLedger({
      initialRecords,
      now,
      persist: async (record) => {
        await handle.appendFile(JSON.stringify(record) + "\n", "utf8");
        await handle.sync();
      },
      closeResource: () => handle.close()
    });
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
