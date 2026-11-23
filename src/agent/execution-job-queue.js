import { randomUUID } from "node:crypto";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

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
      const keys = Reflect.ownKeys(current);
      for (const key of keys) {
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

function snapshot(job) {
  return freezeDeep({
    id: job.id,
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    payload: cloneJson(job.payload, "job payload"),
    result: job.result === undefined ? undefined : cloneJson(job.result, "job result"),
    error: job.error,
    idempotencyKey: job.idempotencyKey
  });
}

/**
 * Bounded, in-memory FIFO job lifecycle store.
 * This block does not execute jobs or persist them across process restarts.
 */
export function createExecutionJobQueue(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new ExecutionJobQueueError("INVALID_OPTIONS", "options must be an object");
  }
  const allowed = new Set(["maxQueueSize", "maxJobs", "now"]);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new ExecutionJobQueueError("UNSUPPORTED_OPTION", "unsupported queue option");
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ExecutionJobQueueError("ACCESSOR_NOT_ALLOWED", "queue options cannot contain accessors");
    }
  }
  const maxQueueSize = options.maxQueueSize ?? 50;
  const maxJobs = options.maxJobs ?? 500;
  const now = options.now ?? (() => new Date().toISOString());
  if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 1 || maxQueueSize > 1000) {
    throw new ExecutionJobQueueError("INVALID_QUEUE_LIMIT", "maxQueueSize must be an integer from 1 to 1000");
  }
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 10000) {
    throw new ExecutionJobQueueError("INVALID_JOB_LIMIT", "maxJobs must be an integer from 1 to 10000");
  }
  if (typeof now !== "function") {
    throw new ExecutionJobQueueError("INVALID_CLOCK", "now must be a function");
  }

  const jobs = new Map();
  const fifo = [];
  const idempotency = new Map();

  function getJob(id) {
    const job = jobs.get(id);
    return job ? snapshot(job) : null;
  }

  function listJobs({ state } = {}) {
    if (state !== undefined && !["queued", "running", ...TERMINAL].includes(state)) {
      throw new ExecutionJobQueueError("INVALID_STATE_FILTER", "unknown state filter");
    }
    const values = [...jobs.values()].filter((job) => state === undefined || job.state === state);
    values.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return Object.freeze(values.map(snapshot));
  }

  function enqueue(payload, { id, idempotencyKey } = {}) {
    if (jobs.size >= maxJobs) {
      throw new ExecutionJobQueueError("JOB_CAPACITY_REACHED", "job retention capacity reached; clear terminal jobs first");
    }
    const queuedCount = fifo.reduce((count, jobId) => count + (jobs.get(jobId)?.state === "queued" ? 1 : 0), 0);
    if (queuedCount >= maxQueueSize) {
      throw new ExecutionJobQueueError("QUEUE_FULL", "execution queue is at capacity");
    }
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
    const jobId = id ?? "job-" + randomUUID();
    if (jobs.has(jobId)) {
      throw new ExecutionJobQueueError("DUPLICATE_JOB_ID", "job id already exists");
    }
    const clonedPayload = cloneJson(payload, "job payload");
    const createdAt = now();
    if (typeof createdAt !== "string" || !createdAt.trim()) {
      throw new ExecutionJobQueueError("INVALID_CLOCK_VALUE", "clock must return a non-empty string");
    }
    const job = {
      id: jobId,
      state: "queued",
      createdAt,
      startedAt: null,
      finishedAt: null,
      payload: clonedPayload,
      result: undefined,
      error: null,
      idempotencyKey: idempotencyKey ?? null
    };
    jobs.set(jobId, job);
    fifo.push(jobId);
    if (idempotencyKey) idempotency.set(idempotencyKey, jobId);
    return snapshot(job);
  }

  function claimNext() {
    while (fifo.length) {
      const id = fifo.shift();
      const job = jobs.get(id);
      if (!job || job.state !== "queued") continue;
      job.state = "running";
      job.startedAt = now();
      return snapshot(job);
    }
    return null;
  }

  function complete(id, result) {
    const job = jobs.get(id);
    if (!job) throw new ExecutionJobQueueError("JOB_NOT_FOUND", "job does not exist");
    if (job.state !== "running") throw new ExecutionJobQueueError("INVALID_TRANSITION", "only running jobs can complete");
    job.result = cloneJson(result, "job result");
    job.state = "completed";
    job.finishedAt = now();
    return snapshot(job);
  }

  function fail(id, error) {
    const job = jobs.get(id);
    if (!job) throw new ExecutionJobQueueError("JOB_NOT_FOUND", "job does not exist");
    if (job.state !== "running") throw new ExecutionJobQueueError("INVALID_TRANSITION", "only running jobs can fail");
    const message = error instanceof Error ? error.message : String(error);
    job.error = message.slice(0, 1000);
    job.state = "failed";
    job.finishedAt = now();
    return snapshot(job);
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) throw new ExecutionJobQueueError("JOB_NOT_FOUND", "job does not exist");
    if (job.state !== "queued") throw new ExecutionJobQueueError("INVALID_TRANSITION", "only queued jobs can be cancelled");
    job.state = "cancelled";
    job.finishedAt = now();
    return snapshot(job);
  }

  function removeTerminal(id) {
    const job = jobs.get(id);
    if (!job) return false;
    if (!TERMINAL.has(job.state)) {
      throw new ExecutionJobQueueError("INVALID_TRANSITION", "only terminal jobs may be removed");
    }
    jobs.delete(id);
    if (job.idempotencyKey) idempotency.delete(job.idempotencyKey);
    return true;
  }

  function stats() {
    const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, total: jobs.size };
    for (const job of jobs.values()) counts[job.state] += 1;
    return Object.freeze({ ...counts, maxQueueSize, maxJobs });
  }

  return Object.freeze({ enqueue, claimNext, complete, fail, cancel, getJob, listJobs, removeTerminal, stats });
}
