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
import { hostname } from "node:os";
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
  const seen = new Set();

  function validate(current, depth, arrayElement = false) {
    if (depth > 32) throw new TypeError("snapshot is too deeply nested");
    if (current === undefined && !arrayElement) return;
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("snapshot contains a non-finite number");
      return;
    }
    if (Array.isArray(current)) {
      if (seen.has(current) || current.length > 100000) throw new TypeError("snapshot contains an invalid array");
      seen.add(current);
      for (const key of Reflect.ownKeys(current)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) ||
            !Number.isSafeInteger(Number(key)) || Number(key) >= current.length) {
          throw new TypeError("snapshot array contains unsupported properties");
        }
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
          throw new TypeError("snapshot array contains holes or accessors");
        }
        validate(descriptor.value, depth + 1, true);
      }
      seen.delete(current);
      return;
    }
    if (typeof current !== "object") throw new TypeError("snapshot contains a non-JSON value");
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("snapshot contains a non-plain object");
    if (seen.has(current)) throw new TypeError("snapshot contains a circular reference");
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) {
        throw new TypeError("snapshot contains a forbidden key");
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new TypeError("snapshot contains accessors or non-enumerable properties");
      }
      validate(descriptor.value, depth + 1);
    }
    seen.delete(current);
  }

  let serialized;
  try {
    validate(value, 0);
    serialized = JSON.stringify(value);
  } catch {
    throw new ExecutionJobStoreError("INVALID_SNAPSHOT", "queue snapshot must contain bounded, plain JSON-compatible data");
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
    if (process.platform !== "win32" && (fileInfo.mode & 0o077) !== 0) {
      throw new ExecutionJobStoreError("UNSAFE_STORE_PERMISSIONS", "job store file permissions must be private to its owner");
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

function removeStaleLock(lockPath) {
  let originalInfo;
  let originalContent;
  try {
    originalInfo = lstatSync(lockPath);
    if (originalInfo.isSymbolicLink() || !originalInfo.isFile() || originalInfo.size > 4096) return false;
    originalContent = readFileSync(lockPath, "utf8");
  } catch (error) {
    return error?.code === "ENOENT";
  }

  let metadata;
  try {
    metadata = JSON.parse(originalContent);
  } catch {
    metadata = null;
  }

  let stale = false;
  if (metadata && metadata.host === hostname() &&
      Number.isSafeInteger(metadata.pid) && metadata.pid > 0) {
    try {
      process.kill(metadata.pid, 0);
      stale = false;
    } catch (error) {
      stale = error?.code === "ESRCH";
    }
  } else if (metadata && typeof metadata.host === "string" && metadata.host !== hostname()) {
    return false;
  } else {
    // Recover only old incomplete lock files; allow time for lock creation to finish.
    stale = Date.now() - originalInfo.mtimeMs > 60_000;
  }

  if (!stale) return false;
  try {
    const currentInfo = lstatSync(lockPath);
    if (currentInfo.isSymbolicLink() || currentInfo.dev !== originalInfo.dev ||
        currentInfo.ino !== originalInfo.ino ||
        readFileSync(lockPath, "utf8") !== originalContent) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
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
  const lockContent = JSON.stringify({ pid: process.pid, host: hostname(), token: lockToken, createdAt: new Date().toISOString() });
  let lockDescriptor;
  let closed = false;

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      lockDescriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST" || !removeStaleLock(lockPath)) {
        throw new ExecutionJobStoreError("STORE_LOCKED", "another process already owns this job store");
      }
      try {
        lockDescriptor = openSync(lockPath, "wx", 0o600);
      } catch {
        throw new ExecutionJobStoreError("STORE_LOCKED", "another process acquired this job store lock");
      }
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
        if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
          throw new ExecutionJobStoreError("UNSAFE_STORE_PERMISSIONS", "job store file permissions must be private to its owner");
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
    new Set(["filePath", "maxQueueSize", "maxJobs", "maxAttempts", "now"]),
    "options"
  );
  const store = createJsonFileExecutionJobStore({ filePath: config.filePath });
  try {
    return createExecutionJobQueue({
      ...(config.maxQueueSize === undefined ? {} : { maxQueueSize: config.maxQueueSize }),
      ...(config.maxJobs === undefined ? {} : { maxJobs: config.maxJobs }),
      ...(config.maxAttempts === undefined ? {} : { maxAttempts: config.maxAttempts }),
      ...(config.now === undefined ? {} : { now: config.now }),
      persistence: store
    });
  } catch (error) {
    try { store.close(); } catch {}
    throw error;
  }
}
