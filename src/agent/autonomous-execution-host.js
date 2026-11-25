import { isAbsolute, join, parse, resolve } from "node:path";
import { createAutonomousExecutionRuntime } from "./execution-runtime.js";
import { createPersistentExecutionJobQueue } from "./execution-job-persistence.js";
import { createPersistentExecutionEventJournal } from "./execution-event-journal-persistence.js";
import { createExecutionWorker } from "./execution-worker.js";
import { createExecutionLifecycleSupervisor } from "./execution-supervisor.js";
import { createAutonomousExecutionRunner } from "./autonomous-execution-runner.js";

export class AutonomousExecutionHostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AutonomousExecutionHostError";
    this.code = code;
  }
}

function readOptions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AutonomousExecutionHostError("INVALID_OPTIONS", "options must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AutonomousExecutionHostError("INVALID_OPTIONS", "options must be a plain object");
  }
  const allowed = new Set([
    "orchestrator", "storageDirectory", "enabled",
    "runnerId", "supervisorId", "workerId",
    "pollIntervalMs", "maxJobsPerTick", "maxConsecutiveErrors",
    "workerTimeoutMs", "maxQueueSize", "maxJobs", "maxAttempts",
    "maxEvents", "processRunners"
  ]);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new AutonomousExecutionHostError("UNSUPPORTED_OPTION", "options contain an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new AutonomousExecutionHostError("ACCESSOR_NOT_ALLOWED", "options cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function readMethod(target, name) {
  const descriptor = target && Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
    throw new AutonomousExecutionHostError("INVALID_RUNTIME", "runtime must expose a trusted " + name + "()");
  }
  return descriptor.value.bind(target);
}

function closeQuietly(resource, method) {
  if (!resource) return;
  try {
    const result = resource[method]();
    if (result && typeof result.then === "function") result.catch(() => {});
  } catch {}
}

/**
 * Composes the existing policy-gated runtime, durable queue, worker, lifecycle
 * supervisor, durable event journal and host runner into one local host.
 *
 * Construction is inert and the runtime is disabled by default. The host
 * explicitly starts execution only when start() is called. It owns the
 * persistent queue and journal and closes them in supervisor dependency order.
 */
export function createAutonomousExecutionHost(options = {}) {
  const config = readOptions(options);
  const orchestrator = config.orchestrator;
  if (!orchestrator || typeof orchestrator !== "object" || Array.isArray(orchestrator)) {
    throw new AutonomousExecutionHostError("INVALID_ORCHESTRATOR", "a trusted QA engine orchestrator is required");
  }
  if (typeof config.enabled !== "undefined" && typeof config.enabled !== "boolean") {
    throw new AutonomousExecutionHostError("INVALID_ENABLED_FLAG", "enabled must be a boolean");
  }
  const enabled = config.enabled === true;
  const storageDirectory = config.storageDirectory;
  if (typeof storageDirectory !== "string" || !storageDirectory.trim() ||
      storageDirectory.length > 4096 || storageDirectory.includes("\0") || !isAbsolute(storageDirectory)) {
    throw new AutonomousExecutionHostError(
      "INVALID_STORAGE_DIRECTORY",
      "storageDirectory must be an absolute, non-empty host-controlled path"
    );
  }
  const resolvedDirectory = resolve(storageDirectory);
  if (resolvedDirectory === parse(resolvedDirectory).root) {
    throw new AutonomousExecutionHostError(
      "UNSAFE_STORAGE_DIRECTORY",
      "storageDirectory cannot be a filesystem root"
    );
  }

  const jobFilePath = join(resolvedDirectory, "execution-jobs.json");
  const eventFilePath = join(resolvedDirectory, "execution-events.json");
  let eventJournal = null;
  let queue = null;
  let runtime = null;
  let supervisor = null;

  try {
    // Acquire durable resources first. A second host pointed at the same
    // directory fails on the journal lock before it can create another runner.
    eventJournal = createPersistentExecutionEventJournal({
      filePath: eventFilePath,
      ...(config.maxEvents === undefined ? {} : { maxEvents: config.maxEvents })
    });
    queue = createPersistentExecutionJobQueue({
      filePath: jobFilePath,
      eventJournal,
      ...(config.maxQueueSize === undefined ? {} : { maxQueueSize: config.maxQueueSize }),
      ...(config.maxJobs === undefined ? {} : { maxJobs: config.maxJobs }),
      ...(config.maxAttempts === undefined ? {} : { maxAttempts: config.maxAttempts })
    });
    runtime = createAutonomousExecutionRuntime({ orchestrator, enabled });
    const worker = createExecutionWorker({
      queue,
      runtime,
      eventJournal,
      ...(config.workerId === undefined ? {} : { workerId: config.workerId }),
      ...(config.workerTimeoutMs === undefined ? {} : { timeoutMs: config.workerTimeoutMs })
    });
    supervisor = createExecutionLifecycleSupervisor({
      queue,
      runtime,
      worker,
      eventJournal,
      closeEventJournal: true,
      ...(config.supervisorId === undefined ? {} : { supervisorId: config.supervisorId }),
      ...(config.processRunners === undefined ? {} : { processRunners: config.processRunners })
    });
    const runner = createAutonomousExecutionRunner({
      supervisor,
      eventJournal,
      ...(config.runnerId === undefined ? {} : { runnerId: config.runnerId }),
      ...(config.pollIntervalMs === undefined ? {} : { pollIntervalMs: config.pollIntervalMs }),
      ...(config.maxJobsPerTick === undefined ? {} : { maxJobsPerTick: config.maxJobsPerTick }),
      ...(config.maxConsecutiveErrors === undefined ? {} : { maxConsecutiveErrors: config.maxConsecutiveErrors })
    });

    const runtimeStatus = readMethod(runtime, "getStatus");
    const verifyLedgerSnapshot = readMethod(runtime, "verifyLedger");
    let state = "idle";
    let closePromise = null;

    function assertOpen() {
      if (state === "closing" || state === "closed" || state === "failed") {
        throw new AutonomousExecutionHostError("HOST_NOT_OPEN", "host is closing, closed or failed");
      }
    }

    function getStatus() {
      let runtimeSnapshot;
      let supervisorSnapshot;
      let queueSnapshot;
      let eventSnapshot;
      let runnerSnapshot;
      try { runtimeSnapshot = runtimeStatus(); } catch { runtimeSnapshot = null; }
      try { supervisorSnapshot = supervisor.getStatus(); } catch { supervisorSnapshot = null; }
      try { queueSnapshot = queue.stats(); } catch { queueSnapshot = null; }
      try { eventSnapshot = eventJournal.getStatus(); } catch { eventSnapshot = null; }
      try { runnerSnapshot = runner.getStatus(); } catch { runnerSnapshot = null; }
      return Object.freeze({
        state,
        enabled,
        storageDirectory: resolvedDirectory,
        jobFilePath,
        eventFilePath,
        runtime: runtimeSnapshot,
        supervisor: supervisorSnapshot,
        runner: runnerSnapshot,
        queue: queueSnapshot,
        eventJournal: eventSnapshot,
        queuePersistenceEnabled: queueSnapshot?.persistent === true,
        eventJournalPersistenceEnabled: eventSnapshot?.persistent === true
      });
    }

    function enqueue(plan, jobOptions = {}) {
      assertOpen();
      return supervisor.enqueue(plan, jobOptions);
    }

    function getJob(id) {
      assertOpen();
      return supervisor.getJob(id);
    }

    function listJobs(query = {}) {
      assertOpen();
      return supervisor.listJobs(query);
    }

    function recoverInterrupted(id) {
      assertOpen();
      return supervisor.recoverInterrupted(id);
    }

    function failInterrupted(id, reason) {
      assertOpen();
      return supervisor.failInterrupted(id, reason);
    }

    function retryFailed(id, retryOptions = {}) {
      assertOpen();
      return supervisor.retryFailed(id, retryOptions);
    }

    function listEvents(query = {}) {
      assertOpen();
      return supervisor.listEvents(query);
    }

    function getEventsForJob(id, query = {}) {
      assertOpen();
      return supervisor.getEventsForJob(id, query);
    }

    function getEventJournalStatus() {
      assertOpen();
      return supervisor.getEventJournalStatus();
    }

    function verifyLedger() {
      assertOpen();
      return verifyLedgerSnapshot();
    }

    function start() {
      if (state === "running") return getStatus();
      if (state !== "idle") {
        throw new AutonomousExecutionHostError("HOST_TERMINAL", "host cannot be restarted after shutdown");
      }
      runner.start();
      state = "running";
      return getStatus();
    }

    function close() {
      if (closePromise) return closePromise;
      if (state === "closed") return Promise.resolve(getStatus());
      state = "closing";
      closePromise = (async () => {
        let failure = null;
        try {
          await runner.stop();
        } catch (error) {
          failure = error;
        }
        try {
          await supervisor.close();
        } catch (error) {
          failure ??= error;
        }
        let supervisorState = "unavailable";
        try { supervisorState = supervisor.getStatus().state; } catch {}
        state = supervisorState === "closed" ? "closed" : "failed";
        if (failure) throw failure;
        return getStatus();
      })();
      return closePromise;
    }

    return Object.freeze({
      getStatus,
      start,
      close,
      enqueue,
      getJob,
      listJobs,
      recoverInterrupted,
      failInterrupted,
      retryFailed,
      listEvents,
      getEventsForJob,
      getEventJournalStatus,
      verifyLedger
    });
  } catch (error) {
    if (supervisor) {
      closeQuietly(supervisor, "close");
    } else {
      if (runtime) closeQuietly(runtime, "close");
      if (queue) closeQuietly(queue, "close");
      if (eventJournal) closeQuietly(eventJournal, "close");
    }
    throw error;
  }
}
