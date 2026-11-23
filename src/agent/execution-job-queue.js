import { randomUUID } from "node:crypto";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const STATES = new Set(["queued", "running", "interrupted", ...TERMINAL]);
const RECOVERY_ERROR = "Process stopped while this job was running; manual recovery is required.";

export class ExecutionJobQueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionJobQueueError";
    this.code = code;
  }
}

function cloneJson(value, label) {
  const seen = new Set();

  function validate(current, depth) {
    if (depth > 24) throw new TypeError("value is too deeply nested");
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("value contains a non-finite number");
      return;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) throw new TypeError("value contains a circular reference");
      if (current.length > 10000) throw new RangeError("array exceeds the item limit");
      seen.add(current);
      for (const key of Reflect.ownKeys(current)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) ||
            !Number.isSafeInteger(Number(key)) || Number(key) >= current.length) {
          throw new TypeError("arrays may contain indexed JSON values only");
        }
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
          throw new TypeError("arrays cannot contain holes, accessors or non-enumerable values");
        }
        validate(descriptor.value, depth + 1);
      }
      seen.delete(current);
      return;
    }
    if (typeof current !== "object") throw new TypeError("value contains a non-JSON data type");
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("objects must be plain JSON records");
    }
    if (seen.has(current)) throw new TypeError("value contains a circular reference");
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) {
        throw new TypeError("object contains an unsupported or forbidden key");
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new TypeError("objects cannot contain accessors or non-enumerable values");
      }
      validate(descriptor.value, depth + 1);
    }
    seen.delete(current);
  }

  try {
    validate(value, 0);
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 1024 * 1024) {
      throw new RangeError("value exceeds the 1 MiB JSON limit");
    }
    return JSON.parse(serialized);
  } catch {
    throw new ExecutionJobQueueError("INVALID_PAYLOAD", label + " must contain bounded, plain JSON-compatible data");
  }
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function copyJob(job) {
  return {
    id: job.id,
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    payload: cloneJson(job.payload, "job payload"),
    result: job.result === undefined ? undefined : cloneJson(job.result, "job result"),
    error: job.error,
    idempotencyKey: job.idempotencyKey,
    attempts: job.attempts
  };
}

function snapshot(job) {
  return freezeDeep(copyJob(job));
}

function readQueueOptions(value, label, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionJobQueueError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ExecutionJobQueueError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new ExecutionJobQueueError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ExecutionJobQueueError("ACCESSOR_NOT_ALLOWED", label + " cannot contain accessors");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function readPersistence(persistence) {
  if (persistence === undefined) return null;
  if (!persistence || typeof persistence !== "object" || Array.isArray(persistence)) {
    throw new ExecutionJobQueueError("INVALID_PERSISTENCE", "persistence must expose synchronous load, save and close methods");
  }
  const methods = {};
  for (const name of ["load", "save", "close"]) {
    const descriptor = Object.getOwnPropertyDescriptor(persistence, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new ExecutionJobQueueError("INVALID_PERSISTENCE", "persistence must expose own " + name + "() methods");
    }
    methods[name] = descriptor.value.bind(persistence);
  }
  return methods;
}

/**
 * Bounded FIFO job lifecycle store. An optional synchronous persistence adapter
 * durably saves every state transition. Jobs found running after restart become
 * interrupted and require an explicit recovery decision; they are never replayed
 * automatically.
 */
export function createExecutionJobQueue(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new ExecutionJobQueueError("INVALID_OPTIONS", "options must be an object");
  }
  const allowed = new Set(["maxQueueSize", "maxJobs", "now", "persistence"]);
  const config = Object.create(null);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new ExecutionJobQueueError("UNSUPPORTED_OPTION", "unsupported queue option");
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ExecutionJobQueueError("ACCESSOR_NOT_ALLOWED", "queue options cannot contain accessors");
    }
    config[key] = descriptor.value;
  }

  const maxQueueSize = config.maxQueueSize ?? 50;
  const maxJobs = config.maxJobs ?? 500;
  const now = config.now ?? (() => new Date().toISOString());
  const persistence = readPersistence(config.persistence);

  if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 1 || maxQueueSize > 1000) {
    throw new ExecutionJobQueueError("INVALID_QUEUE_LIMIT", "maxQueueSize must be an integer from 1 to 1000");
  }
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 10000) {
    throw new ExecutionJobQueueError("INVALID_JOB_LIMIT", "maxJobs must be an integer from 1 to 10000");
  }
  if (typeof now !== "function") {
    throw new ExecutionJobQueueError("INVALID_CLOCK", "now must be a function");
  }
  function timestamp() {
    const value = now();
    if (typeof value !== "string" || !value.trim()) {
      throw new ExecutionJobQueueError("INVALID_CLOCK_VALUE", "clock must return a non-empty string");
    }
    return value;
  }

  const jobs = new Map();
  const fifo = [];
  const idempotency = new Map();
  let closed = false;

  function assertOpen() {
    if (closed) throw new ExecutionJobQueueError("QUEUE_CLOSED", "job queue is closed");
  }

  function getQueueSnapshot() {
    return {
      schemaVersion: 1,
      jobs: [...jobs.values()].map(copyJob)
    };
  }

  function persist() {
    if (!persistence) return;
    const result = persistence.save(getQueueSnapshot());
    if (result && typeof result.then === "function") {
      throw new ExecutionJobQueueError("ASYNC_PERSISTENCE_UNSUPPORTED", "persistence methods must be synchronous");
    }
  }

  function captureState() {
    return [...jobs.values()].map(copyJob);
  }

  function restoreState(records) {
    jobs.clear();
    fifo.length = 0;
    idempotency.clear();
    for (const record of records) {
      const job = copyJob(record);
      jobs.set(job.id, job);
      if (job.state === "queued") fifo.push(job.id);
      if (job.idempotencyKey) idempotency.set(job.idempotencyKey, job.id);
    }
  }

  function transact(operation) {
    assertOpen();
    const before = captureState();
    try {
      const result = operation();
      persist();
      return result;
    } catch (error) {
      restoreState(before);
      if (error instanceof ExecutionJobQueueError) throw error;
      throw new ExecutionJobQueueError("PERSISTENCE_FAILED", "job state was not changed because durable storage failed");
    }
  }

  function restorePersistedState(value) {
    if (value === null || value === undefined) return false;
    let data;
    try {
      data = cloneJson(value, "persisted queue state");
    } catch {
      throw new ExecutionJobQueueError("PERSISTENCE_CORRUPT", "persisted queue state is invalid");
    }
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.jobs) || data.jobs.length > maxJobs) {
      throw new ExecutionJobQueueError("PERSISTENCE_SCHEMA_UNSUPPORTED", "persisted queue schema or job count is invalid");
    }

    const restored = [];
    const seenIds = new Set();
    const seenKeys = new Set();
    let queuedCount = 0;
    let recoveredRunning = false;

    for (const record of data.jobs) {
      if (!record || typeof record !== "object" || Array.isArray(record) ||
          typeof record.id !== "string" || !ID_PATTERN.test(record.id) ||
          !STATES.has(record.state) ||
          typeof record.createdAt !== "string" || !record.createdAt.trim() ||
          !(record.startedAt === null || typeof record.startedAt === "string") ||
          !(record.finishedAt === null || typeof record.finishedAt === "string") ||
          !(record.error === null || typeof record.error === "string") ||
          !(record.idempotencyKey === null || (typeof record.idempotencyKey === "string" && ID_PATTERN.test(record.idempotencyKey))) ||
          !Number.isSafeInteger(record.attempts) || record.attempts < 0 ||
          !Object.hasOwn(record, "payload")) {
        throw new ExecutionJobQueueError("PERSISTENCE_CORRUPT", "persisted job record is invalid");
      }
      if (seenIds.has(record.id) || (record.idempotencyKey && seenKeys.has(record.idempotencyKey))) {
        throw new ExecutionJobQueueError("PERSISTENCE_CORRUPT", "persisted queue contains duplicate identities");
      }
      seenIds.add(record.id);
      if (record.idempotencyKey) seenKeys.add(record.idempotencyKey);
      const job = {
        id: record.id,
        state: record.state,
        createdAt: record.createdAt,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        payload: cloneJson(record.payload, "persisted job payload"),
        result: record.result === undefined ? undefined : cloneJson(record.result, "persisted job result"),
        error: record.error,
        idempotencyKey: record.idempotencyKey,
        attempts: record.attempts
      };
      if (job.state === "running") {
        job.state = "interrupted";
        job.error = RECOVERY_ERROR;
        job.finishedAt = timestamp();
        recoveredRunning = true;
      }
      if (job.state === "queued") queuedCount += 1;
      restored.push(job);
    }

    if (queuedCount > maxQueueSize) {
      throw new ExecutionJobQueueError("PERSISTENCE_QUEUE_LIMIT", "persisted queued jobs exceed the configured queue limit");
    }
    restoreState(restored);
    if (recoveredRunning) persist();
    return recoveredRunning;
  }

  if (persistence) {
    let loaded;
    try {
      loaded = persistence.load();
      if (loaded && typeof loaded.then === "function") {
        throw new ExecutionJobQueueError("ASYNC_PERSISTENCE_UNSUPPORTED", "persistence methods must be synchronous");
      }
      restorePersistedState(loaded);
    } catch (error) {
      try { persistence.close(); } catch {}
      throw error;
    }
  }

  function getJob(id) {
    const job = jobs.get(id);
    return job ? snapshot(job) : null;
  }

  function listJobs(options = {}) {
    const { state } = readQueueOptions(options, "list options", new Set(["state"]));
    if (state !== undefined && !STATES.has(state)) {
      throw new ExecutionJobQueueError("INVALID_STATE_FILTER", "unknown state filter");
    }
    const values = [...jobs.values()].filter((job) => state === undefined || job.state === state);
    values.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return Object.freeze(values.map(snapshot));
  }

  function enqueue(payload, options = {}) {
    const { id, idempotencyKey } = readQueueOptions(options, "enqueue options", new Set(["id", "idempotencyKey"]));
    return transact(() => {
      if (id !== undefined && (typeof id !== "string" || !ID_PATTERN.test(id))) {
        throw new ExecutionJobQueueError("INVALID_JOB_ID", "job id has an invalid format");
      }
      if (idempotencyKey !== undefined &&
          (typeof idempotencyKey !== "string" || !ID_PATTERN.test(idempotencyKey))) {
        throw new ExecutionJobQueueError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey has an invalid format");
      }
      if (idempotencyKey && idempotency.has(idempotencyKey)) {
        return getJob(idempotency.get(idempotencyKey));
      }
      if (jobs.size >= maxJobs) {
        throw new ExecutionJobQueueError("JOB_CAPACITY_REACHED", "job retention capacity reached; clear terminal jobs first");
      }
      const queuedCount = fifo.reduce((count, jobId) => count + (jobs.get(jobId)?.state === "queued" ? 1 : 0), 0);
      if (queuedCount >= maxQueueSize) {
        throw new ExecutionJobQueueError("QUEUE_FULL", "execution queue is at capacity");
      }
      const jobId = id ?? "job-" + randomUUID();
      if (jobs.has(jobId)) {
        throw new ExecutionJobQueueError("DUPLICATE_JOB_ID", "job id already exists");
      }
      const clonedPayload = cloneJson(payload, "job payload");
      const createdAt = timestamp();
      const job = {
        id: jobId,
        state: "queued",
        createdAt,
        startedAt: null,
        finishedAt: null,
        payload: clonedPayload,
        result: undefined,
        error: null,
        idempotencyKey: idempotencyKey ?? null,
        attempts: 0
      };
      jobs.set(jobId, job);
      fifo.push(jobId);
      if (idempotencyKey) idempotency.set(idempotencyKey, jobId);
      return snapshot(job);
    });
  }

  function claimNext() {
    return transact(() => {
      while (fifo.length) {
        const id = fifo.shift();
        const job = jobs.get(id);
        if (!job || job.state !== "queued") continue;
        job.state = "running";
        job.startedAt = timestamp();
        job.finishedAt = null;
        job.error = null;
        job.attempts += 1;
        return snapshot(job);
      }
      return null;
    });
  }

  function complete(id, result) {
    return transact(() => {
      const job = jobs.get(id);
      if (!job) throw new ExecutionJobQueueError("JOB_NOT_FOUND", "job does not exist");
      if (job.state !== "running") throw new ExecutionJobQueueError("INVALID_TRANSITION", "only running jobs can complete");
      job.result = cloneJson(result, "job result");
      job.state = "completed";
      job.finishedAt = timestamp();
      return snapshot(job);
    });
  }

  function fail(id, error) {
    return transact(() => {
      const job = jobs.get(id);
      if (!job) throw new ExecutionJobQueueError("JOB_NOT_FOUND", "job does not exist");
      if (job.state !== "running") throw new ExecutionJobQueueError("INVALID_TRANSITION", "only running jobs can fail");
      const message = error instanceof Error ? error.message : String(error);
      job.error = message.slice(0, 1000);
      job.state = "failed";
      job.finishedAt = timestamp();
      return snapshot(job);
    });
  }

  function cancel(id) {
    return transact(() => {
      const job = jobs.get(id);
      if (!job) throw new ExecutionJobQueueError("JOB_NOT_FOUND", "job does not exist");
      if (job.state !== "queued") throw new ExecutionJobQueueError("INVALID_TRANSITION", "only queued jobs can be cancelled");
      job.state = "cancelled";
      job.finishedAt = timestamp();
      return snapshot(job);
    });
  }

  function requeueInterrupted(id) {
    return transact(() => {
      const job = jobs.get(id);
      if (!job) throw new ExecutionJobQueueError("JOB_NOT_FOUND", "job does not exist");
      if (job.state !== "interrupted") throw new ExecutionJobQueueError("INVALID_TRANSITION", "only interrupted jobs can be recovered");
      const queuedCount = fifo.reduce((count, jobId) => count + (jobs.get(jobId)?.state === "queued" ? 1 : 0), 0);
      if (queuedCount >= maxQueueSize) throw new ExecutionJobQueueError("QUEUE_FULL", "execution queue is at capacity");
      job.state = "queued";
      job.error = null;
      job.finishedAt = null;
      // Move the recovered job to the tail so FIFO order reflects the retry decision.
      jobs.delete(job.id);
      jobs.set(job.id, job);
      fifo.push(job.id);
      return snapshot(job);
    });
  }

  function failInterrupted(id, reason = "Interrupted job was not automatically replayed.") {
    return transact(() => {
      const job = jobs.get(id);
      if (!job) throw new ExecutionJobQueueError("JOB_NOT_FOUND", "job does not exist");
      if (job.state !== "interrupted") throw new ExecutionJobQueueError("INVALID_TRANSITION", "only interrupted jobs can be finalized as failed");
      const message = reason instanceof Error ? reason.message : String(reason);
      job.state = "failed";
      job.error = message.slice(0, 1000);
      job.finishedAt = timestamp();
      return snapshot(job);
    });
  }

  function removeTerminal(id) {
    return transact(() => {
      const job = jobs.get(id);
      if (!job) return false;
      if (!TERMINAL.has(job.state)) {
        throw new ExecutionJobQueueError("INVALID_TRANSITION", "only terminal jobs may be removed");
      }
      jobs.delete(id);
      if (job.idempotencyKey) idempotency.delete(job.idempotencyKey);
      return true;
    });
  }

  function stats() {
    const counts = { queued: 0, running: 0, interrupted: 0, completed: 0, failed: 0, cancelled: 0, total: jobs.size };
    for (const job of jobs.values()) counts[job.state] += 1;
    return Object.freeze({ ...counts, maxQueueSize, maxJobs, persistent: persistence !== null });
  }

  function close() {
    if (closed) return;
    if (persistence) {
      try {
        persistence.close();
      } catch {
        throw new ExecutionJobQueueError("PERSISTENCE_CLOSE_FAILED", "durable storage lock could not be released");
      }
    }
    closed = true;
  }

  return Object.freeze({
    enqueue,
    claimNext,
    complete,
    fail,
    cancel,
    requeueInterrupted,
    failInterrupted,
    getJob,
    listJobs,
    removeTerminal,
    stats,
    close
  });
}
