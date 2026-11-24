import { randomUUID } from "node:crypto";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;

export class ExecutionLifecycleSupervisorError extends Error {
  constructor(code, message, failures = []) {
    super(message);
    this.name = "ExecutionLifecycleSupervisorError";
    this.code = code;
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
  }
}

function readRecord(value, label, allowedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionLifecycleSupervisorError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ExecutionLifecycleSupervisorError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new ExecutionLifecycleSupervisorError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ExecutionLifecycleSupervisorError("ACCESSOR_NOT_ALLOWED", label + " cannot contain accessors");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function readMethod(target, name, label) {
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    throw new ExecutionLifecycleSupervisorError("INVALID_DEPENDENCY", label + " is required");
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
    throw new ExecutionLifecycleSupervisorError(
      "INVALID_DEPENDENCY",
      label + " must expose a trusted " + name + "() method"
    );
  }
  return descriptor.value.bind(target);
}

function readStatus(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionLifecycleSupervisorError("INVALID_STATUS", label + " returned an invalid status snapshot");
  }
  return value;
}

function readOptionalMethod(target, name, label) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor) return null;
  if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
    throw new ExecutionLifecycleSupervisorError(
      "INVALID_DEPENDENCY",
      label + " must expose a trusted " + name + "() method when provided"
    );
  }
  return descriptor.value.bind(target);
}

function normalizeSupervisorId(value) {
  const id = value ?? "supervisor-" + randomUUID();
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new ExecutionLifecycleSupervisorError("INVALID_SUPERVISOR_ID", "supervisorId has an invalid format");
  }
  return id;
}

function failureRecord(stage, error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(error.code)
    ? error.code
    : "UNEXPECTED_ERROR";
  return { stage, code };
}

/**
 * Coordinates lifecycle ownership for an already constructed runtime, queue
 * and worker. Construction is inert. Hosts explicitly start and drive work.
 *
 * Shutdown ordering is intentional: stop worker admission and await active
 * work, close the runtime, then release queue persistence resources. An
 * optional abortActive request is cooperative and never force-kills a promise.
 */
export function createExecutionLifecycleSupervisor(options = {}) {
  const config = readRecord(
    options,
    "options",
    new Set(["worker", "runtime", "queue", "supervisorId", "eventJournal"])
  );

  const getWorkerStatus = readMethod(config.worker, "getStatus", "worker");
  const startWorker = readMethod(config.worker, "start", "worker");
  const runWorkerNext = readMethod(config.worker, "runNext", "worker");
  const drainWorker = readMethod(config.worker, "drain", "worker");
  const stopWorker = readMethod(config.worker, "stop", "worker");
  const cancelWorkerActive = readMethod(config.worker, "cancelActive", "worker");
  const getRuntimeStatus = readMethod(config.runtime, "getStatus", "runtime");
  const closeRuntime = readMethod(config.runtime, "close", "runtime");
  const enqueueJob = readMethod(config.queue, "enqueue", "queue");
  const getQueueStats = readMethod(config.queue, "stats", "queue");
  const closeQueue = readMethod(config.queue, "close", "queue");
  const getQueueJob = readOptionalMethod(config.queue, "getJob", "queue");
  const listQueueJobs = readOptionalMethod(config.queue, "listJobs", "queue");
  const requeueInterruptedJob = readOptionalMethod(config.queue, "requeueInterrupted", "queue");
  const failInterruptedJob = readOptionalMethod(config.queue, "failInterrupted", "queue");
  const retryFailedJob = readOptionalMethod(config.queue, "retryFailed", "queue");

  const supervisorId = normalizeSupervisorId(config.supervisorId);
  const recordEvent = config.eventJournal === undefined
    ? null
    : readMethod(config.eventJournal, "recordEvent", "eventJournal");
  let eventEmissionFailures = 0;
  function emitLifecycleEvent(eventType, jobId, attempt, severity = "info", stage = "supervisor", code) {
    if (!recordEvent) return;
    try {
      const result = recordEvent({
        eventType,
        severity,
        supervisorId,
        ...(jobId ? { jobId } : {}),
        ...(Number.isSafeInteger(attempt) ? { attempt } : {}),
        stage,
        ...(code ? { code } : {})
      });
      if (result && typeof result.then === "function") eventEmissionFailures += 1;
    } catch {
      eventEmissionFailures += 1;
    }
  }
  let state = "idle";
  let closePromise = null;

  function assertAccepting() {
    if (state === "closing" || state === "closed") {
      throw new ExecutionLifecycleSupervisorError(
        "SUPERVISOR_CLOSED",
        "execution supervisor is closing or closed"
      );
    }
  }

  function getStatus() {
    return Object.freeze({
      supervisorId,
      state,
      started: state === "running",
      accepting: state === "idle" || state === "running",
      worker: readStatus(getWorkerStatus(), "worker"),
      runtime: readStatus(getRuntimeStatus(), "runtime"),
      queue: readStatus(getQueueStats(), "queue"),
      eventEmissionFailures
    });
  }

  function start() {
    assertAccepting();
    if (state === "running") return getStatus();

    const runtimeStatus = readStatus(getRuntimeStatus(), "runtime");
    if (runtimeStatus.enabled !== true || runtimeStatus.state !== "ready") {
      throw new ExecutionLifecycleSupervisorError(
        runtimeStatus.state === "disabled" || runtimeStatus.enabled !== true
          ? "RUNTIME_DISABLED"
          : "RUNTIME_NOT_READY",
        "execution supervisor requires an explicitly enabled, ready QA runtime"
      );
    }

    startWorker();
    state = "running";
    emitLifecycleEvent("RUNTIME_READY", undefined, undefined, "info", "runtime");
    emitLifecycleEvent("SUPERVISOR_STARTED");
    return getStatus();
  }

  function enqueue(payload, jobOptions = {}) {
    assertAccepting();
    return enqueueJob(payload, jobOptions);
  }

  function callQueueCapability(method, name, ...args) {
    if (method === null) {
      throw new ExecutionLifecycleSupervisorError(
        "QUEUE_CAPABILITY_UNAVAILABLE",
        "queue does not support the optional " + name + "() operation"
      );
    }
    return method(...args);
  }

  // Operator recovery remains explicit and never consumes a queued job.
  function getJob(id) {
    assertAccepting();
    return callQueueCapability(getQueueJob, "getJob", id);
  }

  function listJobs(listOptions = {}) {
    assertAccepting();
    return callQueueCapability(listQueueJobs, "listJobs", listOptions);
  }

  function recoverInterrupted(id) {
    assertAccepting();
    const recovered = callQueueCapability(requeueInterruptedJob, "requeueInterrupted", id);
    emitLifecycleEvent("RECOVERY_COMPLETED", recovered?.id ?? id, recovered?.attempts, "warning", "operator");
    return recovered;
  }

  function failInterrupted(id, reason) {
    assertAccepting();
    if (reason !== undefined &&
        (typeof reason !== "string" || !reason.trim() || reason.length > 500)) {
      throw new ExecutionLifecycleSupervisorError(
        "INVALID_RECOVERY_REASON",
        "recovery reason must be a non-empty string of at most 500 characters"
      );
    }
    return reason === undefined
      ? callQueueCapability(failInterruptedJob, "failInterrupted", id)
      : callQueueCapability(failInterruptedJob, "failInterrupted", id, reason);
  }

  function retryFailed(id, retryOptions = {}) {
    assertAccepting();
    const retried = callQueueCapability(retryFailedJob, "retryFailed", id, retryOptions);
    emitLifecycleEvent("RETRY_REQUESTED", retried?.id ?? id, retried?.attempts, "warning", "operator");
    return retried;
  }

  function runNext() {
    if (state !== "running") {
      throw new ExecutionLifecycleSupervisorError(
        "SUPERVISOR_NOT_STARTED",
        "execution supervisor must be started before consuming jobs"
      );
    }
    return runWorkerNext();
  }

  function drain(drainOptions = {}) {
    if (state !== "running") {
      throw new ExecutionLifecycleSupervisorError(
        "SUPERVISOR_NOT_STARTED",
        "execution supervisor must be started before draining jobs"
      );
    }
    return drainWorker(drainOptions);
  }

  function cancelActive(reason = "Execution cancelled by operator") {
    if (state !== "running") return false;
    if (typeof reason !== "string" || !reason.trim() || reason.length > 500) {
      throw new ExecutionLifecycleSupervisorError(
        "INVALID_CANCELLATION_REASON",
        "cancellation reason must be a non-empty string of at most 500 characters"
      );
    }
    return cancelWorkerActive(reason);
  }

  function close(closeOptions = {}) {
    const closeConfig = readRecord(
      closeOptions,
      "close options",
      new Set(["abortActive", "reason"])
    );
    const abortActive = closeConfig.abortActive ?? false;
    const reason = closeConfig.reason ?? "Execution supervisor is shutting down";
    if (typeof abortActive !== "boolean") {
      throw new ExecutionLifecycleSupervisorError("INVALID_ABORT_FLAG", "abortActive must be a boolean");
    }
    if (typeof reason !== "string" || !reason.trim() || reason.length > 500) {
      throw new ExecutionLifecycleSupervisorError(
        "INVALID_SHUTDOWN_REASON",
        "reason must be a non-empty string of at most 500 characters"
      );
    }

    if (closePromise) return closePromise;
    if (state === "closed") return Promise.resolve(getStatus());

    state = "closing";
    emitLifecycleEvent("SUPERVISOR_SHUTDOWN_STARTED");
    let resolveClose;
    let rejectClose;
    closePromise = new Promise((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });

    (async () => {
      const failures = [];

      if (abortActive) {
        try {
          cancelWorkerActive(reason);
        } catch (error) {
          failures.push(failureRecord("worker.cancelActive", error));
        }
      }

      try {
        await stopWorker();
      } catch (error) {
        failures.push(failureRecord("worker.stop", error));
      }

      try {
        await closeRuntime();
      } catch (error) {
        failures.push(failureRecord("runtime.close", error));
      }

      try {
        await closeQueue();
      } catch (error) {
        failures.push(failureRecord("queue.close", error));
      }

      state = "closed";
      if (failures.length > 0) {
        emitLifecycleEvent("SHUTDOWN_FAILURE", undefined, undefined, "error", "supervisor", "SHUTDOWN_FAILED");
        rejectClose(new ExecutionLifecycleSupervisorError(
          "SHUTDOWN_FAILED",
          "one or more execution resources failed to close cleanly",
          failures
        ));
        return;
      }
      emitLifecycleEvent("SUPERVISOR_SHUTDOWN_COMPLETED");
      resolveClose(getStatus());
    })().catch((error) => {
      state = "closed";
      emitLifecycleEvent("SHUTDOWN_FAILURE", undefined, undefined, "error", "supervisor", "SHUTDOWN_FAILED");
      rejectClose(new ExecutionLifecycleSupervisorError(
        "SHUTDOWN_FAILED",
        "execution supervisor shutdown failed unexpectedly",
        [failureRecord("supervisor.close", error)]
      ));
    });

    return closePromise;
  }

  return Object.freeze({
    supervisorId,
    getStatus,
    start,
    enqueue,
    getJob,
    listJobs,
    recoverInterrupted,
    failInterrupted,
    retryFailed,
    runNext,
    drain,
    cancelActive,
    close
  });
}
