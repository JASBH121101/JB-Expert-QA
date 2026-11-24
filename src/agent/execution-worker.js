import { randomUUID } from "node:crypto";
import { redactSensitiveText } from "../core/redaction.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;

export class ExecutionWorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionWorkerError";
    this.code = code;
  }
}

function readRecord(value, label, allowedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionWorkerError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ExecutionWorkerError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new ExecutionWorkerError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ExecutionWorkerError("ACCESSOR_NOT_ALLOWED", label + " cannot contain accessors");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function readMethod(target, name, label) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new ExecutionWorkerError("INVALID_DEPENDENCY", label + " is required");
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
    throw new ExecutionWorkerError("INVALID_DEPENDENCY", label + " must expose a trusted " + name + "() method");
  }
  return descriptor.value.bind(target);
}

function readEventJournal(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionWorkerError("INVALID_EVENT_JOURNAL", "eventJournal must expose a synchronous recordEvent() method");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "recordEvent");
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
    throw new ExecutionWorkerError("INVALID_EVENT_JOURNAL", "eventJournal must expose an own recordEvent() method");
  }
  return descriptor.value.bind(value);
}

function normalizeWorkerId(value) {
  const id = value ?? "worker-" + randomUUID();
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new ExecutionWorkerError("INVALID_WORKER_ID", "workerId has an invalid format");
  }
  return id;
}

function readRuntimeStatus(getStatus) {
  const status = getStatus();
  if (!status || typeof status !== "object" || Array.isArray(status) ||
      typeof status.enabled !== "boolean" || typeof status.state !== "string") {
    throw new ExecutionWorkerError("INVALID_RUNTIME_STATUS", "runtime returned an invalid status");
  }
  return status;
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error ?? "Execution failed");
  return redactSensitiveText(message)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk_live_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,})\b/g, "[REDACTED_TOKEN]")
    .slice(0, 1000) || "Execution failed";
}

/**
 * A manually activated, single-concurrency worker. It passes a cooperative
 * AbortSignal into the policy-gated runtime, supports opt-in deadlines and
 * active cancellation, and never auto-retries failed work.
 *
 * Retry decisions belong to an operator through queue.retryFailed(). Timeout
 * and cancellation are cooperative: an adapter that ignores AbortSignal cannot
 * be forcibly stopped by this in-process worker.
 */
export function createExecutionWorker(options = {}) {
  const config = readRecord(
    options,
    "options",
    new Set(["queue", "runtime", "workerId", "timeoutMs", "eventJournal"])
  );
  const claimNext = readMethod(config.queue, "claimNext", "queue");
  const completeJob = readMethod(config.queue, "complete", "queue");
  const failJob = readMethod(config.queue, "fail", "queue");
  const cancelRunningJob = readMethod(config.queue, "cancelRunning", "queue");
  const getQueueStats = readMethod(config.queue, "stats", "queue");
  const getRuntimeStatus = readMethod(config.runtime, "getStatus", "runtime");
  const executeRuntime = readMethod(config.runtime, "execute", "runtime");

  const workerId = normalizeWorkerId(config.workerId);
  const recordEvent = readEventJournal(config.eventJournal);
  let eventEmissionFailures = 0;

  function emitLifecycleEvent(eventType, jobId, attempt, severity = "info", code) {
    if (!recordEvent) return;
    try {
      const result = recordEvent({
        eventType,
        severity,
        workerId,
        ...(jobId ? { jobId } : {}),
        ...(Number.isSafeInteger(attempt) ? { attempt } : {}),
        stage: "worker",
        ...(code ? { code } : {})
      });
      if (result && typeof result.then === "function") eventEmissionFailures += 1;
    } catch {
      eventEmissionFailures += 1;
    }
  }
  const timeoutMs = config.timeoutMs ?? null;
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)) {
    throw new ExecutionWorkerError("INVALID_TIMEOUT", "timeoutMs must be an integer from 1 to 600000");
  }

  let state = "stopped";
  let startedOnce = false;
  let activeJobId = null;
  let activeExecution = null;
  let activeAbortController = null;
  let drainPromise = null;
  let stopPromise = null;
  let completedJobs = 0;
  let failedJobs = 0;
  let cancelledJobs = 0;

  function getStatus() {
    return Object.freeze({
      workerId,
      state,
      enabled: state === "ready" || state === "busy" || state === "stopping",
      activeJobId,
      active: activeExecution !== null,
      abortRequested: activeAbortController?.signal.aborted === true,
      timeoutMs,
      draining: drainPromise !== null,
      completedJobs,
      failedJobs,
      cancelledJobs,
      eventEmissionFailures,
      queue: getQueueStats()
    });
  }

  function assertRuntimeReady() {
    const runtimeStatus = readRuntimeStatus(getRuntimeStatus);
    if (runtimeStatus.enabled !== true || runtimeStatus.state === "disabled") {
      throw new ExecutionWorkerError("RUNTIME_DISABLED", "worker cannot execute while the QA runtime is disabled");
    }
    if (runtimeStatus.state === "running") {
      throw new ExecutionWorkerError("RUNTIME_BUSY", "QA runtime is already executing another job");
    }
    if (runtimeStatus.state === "closing" || runtimeStatus.state === "closed") {
      throw new ExecutionWorkerError("RUNTIME_CLOSED", "QA runtime is closing or closed");
    }
    if (runtimeStatus.state !== "ready") {
      throw new ExecutionWorkerError("RUNTIME_NOT_READY", "QA runtime is not ready to accept a job");
    }
  }

  function assertReady({ allowDrain = false } = {}) {
    if (state === "stopping" || state === "stopped") {
      throw new ExecutionWorkerError("WORKER_NOT_STARTED", "worker must be started before it can consume jobs");
    }
    if (state === "busy" || activeExecution !== null) {
      throw new ExecutionWorkerError("WORKER_BUSY", "worker already has an active job");
    }
    if (state !== "ready") {
      throw new ExecutionWorkerError("WORKER_NOT_READY", "worker is not ready to consume jobs");
    }
    if (drainPromise !== null && !allowDrain) {
      throw new ExecutionWorkerError("WORKER_DRAINING", "worker is already draining the queue");
    }
  }

  async function processOne({ fromDrain = false } = {}) {
    assertReady({ allowDrain: fromDrain });
    assertRuntimeReady();

    const job = claimNext();
    if (job === null) return null;
    if (!job || typeof job !== "object" || typeof job.id !== "string" || job.state !== "running") {
      throw new ExecutionWorkerError("INVALID_CLAIMED_JOB", "queue returned an invalid claimed job");
    }

    activeJobId = job.id;
    state = "busy";
    emitLifecycleEvent("EXECUTION_STARTED", job.id, job.attempts);
    const controller = new AbortController();
    activeAbortController = controller;

    const execution = (async () => {
      let timeoutHandle = null;
      let timedOut = false;
      try {
        if (timeoutMs !== null) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            controller.abort(new ExecutionWorkerError(
              "EXECUTION_TIMEOUT",
              "Execution exceeded the configured " + timeoutMs + " ms deadline"
            ));
          }, timeoutMs);
        }

        const result = await executeRuntime(job.payload, {
          executionId: job.id,
          signal: controller.signal
        });
        if (timedOut) {
          throw new ExecutionWorkerError("EXECUTION_TIMEOUT", "Execution exceeded the configured deadline");
        }
        if (controller.signal.aborted) {
          throw new ExecutionWorkerError("EXECUTION_CANCELLED", "Execution was cancelled by the operator");
        }

        const completed = completeJob(job.id, result);
        emitLifecycleEvent("EXECUTION_SUCCEEDED", job.id, job.attempts);
        completedJobs += 1;
        return completed;
      } catch (error) {
        if (timedOut) {
          const failed = failJob(job.id, "Execution timed out after " + timeoutMs + " ms");
          emitLifecycleEvent("EXECUTION_TIMEOUT", job.id, job.attempts, "error", "EXECUTION_TIMEOUT");
          failedJobs += 1;
          return failed;
        }
        if (controller.signal.aborted) {
          const reason = controller.signal.reason ?? error;
          const cancelled = cancelRunningJob(job.id, safeErrorMessage(reason));
          emitLifecycleEvent("EXECUTION_CANCELLED", job.id, job.attempts, "warning", "EXECUTION_CANCELLED");
          cancelledJobs += 1;
          return cancelled;
        }
        const failed = failJob(job.id, safeErrorMessage(error));
        emitLifecycleEvent("EXECUTION_FAILED", job.id, job.attempts, "error", "EXECUTION_FAILED");
        failedJobs += 1;
        return failed;
      } finally {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        if (activeAbortController === controller) activeAbortController = null;
        activeJobId = null;
        activeExecution = null;
        if (state === "busy") state = "ready";
      }
    })();

    activeExecution = execution;
    return execution;
  }

  function start() {
    if (state === "ready" || state === "busy") return getStatus();
    if (startedOnce || state !== "stopped") {
      throw new ExecutionWorkerError("WORKER_STOPPED", "a stopped worker instance cannot be restarted");
    }
    assertRuntimeReady();
    startedOnce = true;
    state = "ready";
    emitLifecycleEvent("WORKER_STARTED");
    return getStatus();
  }

  async function runNext() {
    return processOne();
  }

  async function drain(options = {}) {
    const config = readRecord(options, "drain options", new Set(["maxJobs"]));
    const maxJobs = config.maxJobs ?? 50;
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 500) {
      throw new ExecutionWorkerError("INVALID_BATCH_LIMIT", "maxJobs must be an integer from 1 to 500");
    }
    assertReady();
    if (drainPromise !== null) {
      throw new ExecutionWorkerError("WORKER_DRAINING", "worker is already draining the queue");
    }

    const operation = (async () => {
      const jobs = [];
      while (jobs.length < maxJobs && state === "ready") {
        const job = await processOne({ fromDrain: true });
        if (job === null) break;
        jobs.push(Object.freeze({ id: job.id, state: job.state }));
      }
      return Object.freeze({
        workerId,
        processed: jobs.length,
        completed: jobs.filter((job) => job.state === "completed").length,
        failed: jobs.filter((job) => job.state === "failed").length,
        cancelled: jobs.filter((job) => job.state === "cancelled").length,
        jobs: Object.freeze(jobs)
      });
    })();

    drainPromise = operation;
    try {
      return await operation;
    } finally {
      drainPromise = null;
    }
  }

  function cancelActive(reason = "Execution cancelled by operator") {
    if (!activeAbortController || activeAbortController.signal.aborted) return false;
    const message = safeErrorMessage(reason);
    activeAbortController.abort(new ExecutionWorkerError("EXECUTION_CANCELLED", message));
    emitLifecycleEvent("EXECUTION_CANCEL_REQUESTED", activeJobId, undefined, "warning", "EXECUTION_CANCELLED");
    return true;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    if (state === "stopped") return Promise.resolve(getStatus());

    state = "stopping";
    emitLifecycleEvent("WORKER_STOPPING");
    stopPromise = (async () => {
      // stop() remains graceful. Use cancelActive() for an explicit cooperative abort.
      const pending = [activeExecution, drainPromise].filter(Boolean);
      await Promise.all(pending.map((promise) => promise.then(() => undefined, () => undefined)));
      activeJobId = null;
      state = "stopped";
      emitLifecycleEvent("WORKER_STOPPED");
      return getStatus();
    })();
    return stopPromise;
  }

  return Object.freeze({
    workerId,
    getStatus,
    start,
    runNext,
    drain,
    cancelActive,
    stop
  });
}
