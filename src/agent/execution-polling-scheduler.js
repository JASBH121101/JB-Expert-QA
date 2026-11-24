import { randomUUID } from "node:crypto";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;

export class AutonomousExecutionPollingSchedulerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AutonomousExecutionPollingSchedulerError";
    this.code = code;
  }
}

function readRecord(value, label, allowedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AutonomousExecutionPollingSchedulerError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AutonomousExecutionPollingSchedulerError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new AutonomousExecutionPollingSchedulerError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new AutonomousExecutionPollingSchedulerError("ACCESSOR_NOT_ALLOWED", label + " cannot contain accessors");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function readMethod(target, name, label) {
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    throw new AutonomousExecutionPollingSchedulerError("INVALID_DEPENDENCY", label + " is required");
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
    throw new AutonomousExecutionPollingSchedulerError(
      "INVALID_DEPENDENCY",
      label + " must expose a trusted " + name + "() method"
    );
  }
  return descriptor.value.bind(target);
}

function readDrainResult(value, maxJobs) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AutonomousExecutionPollingSchedulerError("INVALID_DRAIN_RESULT", "supervisor returned an invalid drain result");
  }
  const result = Object.create(null);
  for (const field of ["processed", "completed", "failed", "cancelled"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, "value") ||
        !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) {
      throw new AutonomousExecutionPollingSchedulerError("INVALID_DRAIN_RESULT", "supervisor returned invalid drain counters");
    }
    result[field] = descriptor.value;
  }
  if (result.processed > maxJobs ||
      result.completed + result.failed + result.cancelled !== result.processed) {
    throw new AutonomousExecutionPollingSchedulerError("INVALID_DRAIN_RESULT", "supervisor returned inconsistent drain counters");
  }
  return Object.freeze(result);
}

function errorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(error.code)
    ? error.code
    : "SCHEDULER_TICK_FAILED";
}

/**
 * Opt-in local polling loop for an existing policy-gated execution supervisor.
 * Construction is inert. start() is explicit, every drain is bounded, ticks do
 * not overlap, and failed jobs are never retried by the scheduler.
 */
export function createAutonomousExecutionPollingScheduler(options = {}) {
  const config = readRecord(
    options,
    "options",
    new Set(["supervisor", "schedulerId", "intervalMs", "maxJobsPerTick"])
  );

  const getSupervisorStatus = readMethod(config.supervisor, "getStatus", "supervisor");
  const startSupervisor = readMethod(config.supervisor, "start", "supervisor");
  const drainSupervisor = readMethod(config.supervisor, "drain", "supervisor");
  const closeSupervisor = readMethod(config.supervisor, "close", "supervisor");

  const schedulerId = config.schedulerId ?? "scheduler-" + randomUUID();
  if (typeof schedulerId !== "string" || !ID_PATTERN.test(schedulerId)) {
    throw new AutonomousExecutionPollingSchedulerError("INVALID_SCHEDULER_ID", "schedulerId has an invalid format");
  }

  const intervalMs = config.intervalMs ?? 1000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60000) {
    throw new AutonomousExecutionPollingSchedulerError("INVALID_INTERVAL", "intervalMs must be an integer from 10 to 60000");
  }

  const maxJobsPerTick = config.maxJobsPerTick ?? 5;
  if (!Number.isSafeInteger(maxJobsPerTick) || maxJobsPerTick < 1 || maxJobsPerTick > 50) {
    throw new AutonomousExecutionPollingSchedulerError("INVALID_BATCH_LIMIT", "maxJobsPerTick must be an integer from 1 to 50");
  }

  let state = "idle";
  let startedOnce = false;
  let timer = null;
  let activeTick = null;
  let stopPromise = null;
  let closePromise = null;
  let ticks = 0;
  let tickFailures = 0;
  let processedJobs = 0;
  let completedJobs = 0;
  let failedJobs = 0;
  let cancelledJobs = 0;
  let lastTickAt = null;
  let lastErrorCode = null;

  function getStatus() {
    return Object.freeze({
      schedulerId,
      state,
      running: state === "running",
      intervalMs,
      maxJobsPerTick,
      ticks,
      tickFailures,
      processedJobs,
      completedJobs,
      failedJobs,
      cancelledJobs,
      active: activeTick !== null,
      lastTickAt,
      lastErrorCode,
      supervisor: getSupervisorStatus()
    });
  }

  function scheduleNext() {
    if (state !== "running" || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      beginTick().catch(() => {});
    }, intervalMs);
  }

  function finishTick(operation) {
    if (activeTick === operation) activeTick = null;
    scheduleNext();
  }

  function beginTick() {
    if (state !== "running") {
      return Promise.reject(new AutonomousExecutionPollingSchedulerError(
        "SCHEDULER_NOT_RUNNING",
        "scheduler must be running before it can drain the queue"
      ));
    }
    if (activeTick !== null) {
      return Promise.reject(new AutonomousExecutionPollingSchedulerError(
        "SCHEDULER_BUSY",
        "scheduler already has an active queue drain"
      ));
    }

    lastTickAt = new Date().toISOString();
    ticks += 1;
    const operation = (async () => {
      try {
        const result = readDrainResult(await drainSupervisor({ maxJobs: maxJobsPerTick }), maxJobsPerTick);
        processedJobs += result.processed;
        completedJobs += result.completed;
        failedJobs += result.failed;
        cancelledJobs += result.cancelled;
        lastErrorCode = null;
        return result;
      } catch (error) {
        tickFailures += 1;
        lastErrorCode = errorCode(error);
        throw error;
      }
    })();

    activeTick = operation;
    operation.then(
      () => finishTick(operation),
      () => finishTick(operation)
    );
    return operation;
  }

  function start() {
    if (state === "running") return getStatus();
    if (state !== "idle" || startedOnce) {
      throw new AutonomousExecutionPollingSchedulerError("SCHEDULER_STOPPED", "a stopped scheduler cannot be restarted");
    }
    // Supervisor.start() retains the runtime's explicit enabled/ready gate.
    startSupervisor();
    startedOnce = true;
    state = "running";
    beginTick().catch(() => {});
    return getStatus();
  }

  function runOnce() {
    if (state !== "running") {
      throw new AutonomousExecutionPollingSchedulerError("SCHEDULER_NOT_RUNNING", "scheduler must be started before runOnce()");
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return beginTick();
  }

  function stop() {
    if (stopPromise) return stopPromise;
    if (state === "closed" || state === "stopped") return Promise.resolve(getStatus());
    if (state === "idle") {
      state = "stopped";
      return Promise.resolve(getStatus());
    }

    state = "stopping";
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    stopPromise = (async () => {
      if (activeTick !== null) await activeTick.catch(() => {});
      state = "stopped";
      return getStatus();
    })();
    return stopPromise;
  }

  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      await stop();
      try {
        await closeSupervisor();
      } finally {
        state = "closed";
      }
      return getStatus();
    })();
    return closePromise;
  }

  return Object.freeze({
    schedulerId,
    getStatus,
    start,
    runOnce,
    stop,
    close
  });
}
