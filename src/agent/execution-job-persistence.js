import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { createExecutionJobQueue } from "./execution-job-queue.js";

const STORE_FORMAT = "jb-expert-qa.execution-job-store";
const STORE_VERSION = 1;
const MAX_STORE_BYTES = 32 * 1024 * 1024;

export class ExecutionJobStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionJobStoreError";
    this.code = code;
  }
}

function readOptions(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionJobStoreError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ExecutionJobStoreError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new ExecutionJobStoreError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ExecutionJobStoreError("ACCESSOR_NOT_ALLOWED", label + " cannot contain accessors");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeJson(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ExecutionJobStoreError("INVALID_SNAPSHOT", "queue snapshot is not JSON serializable");
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) {
    throw new ExecutionJobStoreError("STORE_SIZE_LIMIT", "queue snapshot exceeds the 32 MiB store limit");
  }
  return serialized;
}

function readRegularFile(path) {
  let descriptor;
  try {
    const fileInfo = lstatSync(path);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
      throw new ExecutionJobStoreError("UNSAFE_STORE_FILE", "job store path must be a regular, non-symlink file");
    }
    if (fileInfo.size > MAX_STORE_BYTES) {
      throw new ExecutionJobStoreError("STORE_SIZE_LIMIT", "job store file exceeds the 32 MiB limit");
    }
    const noFollow = constants.O_NOFOLLOW ?? 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const openedInfo = fstatSync(descriptor);
    if (!openedInfo.isFile() || openedInfo.size > MAX_STORE_BYTES) {
      throw new ExecutionJobStoreError("UNSAFE_STORE_FILE", "opened job store is not a bounded regular file");
    }
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error instanceof ExecutionJobStoreError) throw error;
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") {
      throw new ExecutionJobStoreError("UNSAFE_STORE_FILE", "symbolic links are not permitted for the job store");
    }
    throw new ExecutionJobStoreError("STORE_READ_FAILED", "durable job store could not be read");
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

/**
 * Creates a single-process, local JSON store with an exclusive lock,
 * SHA-256 integrity envelope, atomic same-directory replacement and fsync.
 * The caller must close the store to release its lock.
 */
export function createJsonFileExecutionJobStore(options = {}) {
  const config = readOptions(options, new Set(["filePath"]), "options");
  if (typeof config.filePath !== "string" || !config.filePath.trim() ||
      config.filePath.length > 4096 || config.filePath.includes("\0")) {
    throw new ExecutionJobStoreError("INVALID_FILE_PATH", "filePath must be a valid non-empty path");
  }

  const filePath = resolve(config.filePath);
  const directory = dirname(filePath);
  const lockPath = filePath + ".lock";
  const lockToken = randomUUID();
  const lockContent = JSON.stringify({ pid: process.pid, token: lockToken, createdAt: new Date().toISOString() });
  let lockDescriptor;
  let closed = false;

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      lockDescriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new ExecutionJobStoreError("STORE_LOCKED", "another process already owns this job store");
      }
      throw error;
    }
    writeFileSync(lockDescriptor, lockContent, "utf8");
    fsyncSync(lockDescriptor);
  } catch (error) {
    if (lockDescriptor !== undefined) {
      try { closeSync(lockDescriptor); } catch {}
    }
    if (error instanceof ExecutionJobStoreError) throw error;
    throw new ExecutionJobStoreError("STORE_LOCK_FAILED", "exclusive durable job store lock could not be acquired");
  }

  function assertOpen() {
    if (closed) throw new ExecutionJobStoreError("STORE_CLOSED", "job store is closed");
  }

  function load() {
    assertOpen();
    const text = readRegularFile(filePath);
    if (text === null) return null;

    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new ExecutionJobStoreError("STORE_CORRUPT", "job store contains invalid JSON");
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
        envelope.format !== STORE_FORMAT || envelope.version !== STORE_VERSION ||
        typeof envelope.checksum !== "string" || !/^[a-f0-9]{64}$/u.test(envelope.checksum) ||
        !Object.hasOwn(envelope, "data")) {
      throw new ExecutionJobStoreError("STORE_SCHEMA_UNSUPPORTED", "job store envelope is invalid or unsupported");
    }

    const dataText = safeJson(envelope.data);
    const expected = Buffer.from(digest(dataText), "hex");
    const actual = Buffer.from(envelope.checksum, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ExecutionJobStoreError("STORE_CHECKSUM_MISMATCH", "job store integrity check failed");
    }
    return envelope.data;
  }

  function save(snapshot) {
    assertOpen();
    const dataText = safeJson(snapshot);
    const envelope = {
      format: STORE_FORMAT,
      version: STORE_VERSION,
      checksum: digest(dataText),
      data: JSON.parse(dataText)
    };
    const contents = JSON.stringify(envelope);
    if (Buffer.byteLength(contents, "utf8") > MAX_STORE_BYTES) {
      throw new ExecutionJobStoreError("STORE_SIZE_LIMIT", "serialized job store exceeds the 32 MiB limit");
    }

    if (existsSync(filePath)) {
      try {
        const info = lstatSync(filePath);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new ExecutionJobStoreError("UNSAFE_STORE_FILE", "job store path must be a regular, non-symlink file");
        }
      } catch (error) {
        if (error instanceof ExecutionJobStoreError) throw error;
        throw new ExecutionJobStoreError("STORE_WRITE_FAILED", "existing job store could not be inspected");
      }
    }

    const temporaryPath = resolve(directory, "." + basename(filePath) + "." + process.pid + "." + randomUUID() + ".tmp");
    let tempDescriptor;
    try {
      tempDescriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(tempDescriptor, contents, "utf8");
      fsyncSync(tempDescriptor);
      closeSync(tempDescriptor);
      tempDescriptor = undefined;
      renameSync(temporaryPath, filePath);
      if (process.platform !== "win32") {
        let directoryDescriptor;
        try {
          directoryDescriptor = openSync(directory, constants.O_RDONLY);
          fsyncSync(directoryDescriptor);
        } finally {
          if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
        }
      }
    } catch {
      if (tempDescriptor !== undefined) {
        try { closeSync(tempDescriptor); } catch {}
      }
      try { unlinkSync(temporaryPath); } catch {}
      throw new ExecutionJobStoreError("STORE_WRITE_FAILED", "atomic durable job store write failed");
    }
  }

  function close() {
    if (closed) return;
    try { closeSync(lockDescriptor); } catch {}
    lockDescriptor = undefined;
    try {
      const content = readFileSync(lockPath, "utf8");
      if (content === lockContent) unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new ExecutionJobStoreError("STORE_LOCK_RELEASE_FAILED", "job store lock could not be released");
      }
    }
    closed = true;
  }

  return Object.freeze({ filePath, load, save, close });
}

/**
 * Creates the standard queue backed by a local durable JSON file.
 * The lock is single-process; close() must be called before another instance
 * opens the same path. Interrupted jobs remain quarantined until explicit
 * requeueInterrupted(id) or failInterrupted(id).
 */
export function createPersistentExecutionJobQueue(options = {}) {
  const config = readOptions(
    options,
    new Set(["filePath", "maxQueueSize", "maxJobs", "now"]),
    "options"
  );
  const store = createJsonFileExecutionJobStore({ filePath: config.filePath });
  try {
    return createExecutionJobQueue({
      ...(config.maxQueueSize === undefined ? {} : { maxQueueSize: config.maxQueueSize }),
      ...(config.maxJobs === undefined ? {} : { maxJobs: config.maxJobs }),
      ...(config.now === undefined ? {} : { now: config.now }),
      persistence: store
    });
  } catch (error) {
    try { store.close(); } catch {}
    throw error;
  }
}
