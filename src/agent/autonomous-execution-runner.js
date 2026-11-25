const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;

export class AutonomousExecutionRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AutonomousExecutionRunnerError";
    this.code = code;
  }
}

function readOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AutonomousExecutionRunnerError("INVALID_OPTIONS", "options must be a plain object");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new AutonomousExecutionRunnerError("INVALID_OPTIONS", "options must be a plain object");
  }
  const allowed = new Set(["supervisor", "runnerId", "pollIntervalMs", "maxJobsPerTick", "maxConsecutiveErrors", "eventJournal"]);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new AutonomousExecutionRunnerError("UNSUPPORTED_OPTION", "options contain unsupported fields");
    }
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !Object.hasOwn(d, "value")) {
      throw new AutonomousExecutionRunnerError("ACCESSOR_NOT_ALLOWED", "options cannot contain accessors");
    }
    out[key] = d.value;
  }
  return out;
}

function ownMethod(target, name, errorCode = "INVALID_SUPERVISOR") {
  const d = target && Object.getOwnPropertyDescriptor(target, name);
  if (!d || !Object.hasOwn(d, "value") || typeof d.value !== "function") {
    throw new AutonomousExecutionRunnerError(errorCode, "dependency must expose trusted " + name + "()");
  }
  return d.value.bind(target);
}

/**
 * Explicit host-side poller for the existing policy-gated execution supervisor.
 * Construction is inert; the host must call start(). The runner never owns or
 * closes the supervisor, queue, runtime, worker, or event journal.
 */
export function createAutonomousExecutionRunner(options = {}) {
  const config = readOptions(options);
  const getSupervisorStatus = ownMethod(config.supervisor, "getStatus");
  const startSupervisor = ownMethod(config.supervisor, "start");
  const drainSupervisor = ownMethod(config.supervisor, "drain");
  const recordEvent = config.eventJournal === undefined
    ? null
    : ownMethod(config.eventJournal, "recordEvent", "INVALID_EVENT_JOURNAL");

  const runnerId = config.runnerId ?? "runner-" + Math.random().toString(36).slice(2, 12);
  const pollIntervalMs = config.pollIntervalMs ?? 1000;
  const maxJobsPerTick = config.maxJobsPerTick ?? 5;
  const maxConsecutiveErrors = config.maxConsecutiveErrors ?? 3;
  if (typeof runnerId !== "string" || !ID_PATTERN.test(runnerId)) {
    throw new AutonomousExecutionRunnerError("INVALID_RUNNER_ID", "runnerId has an invalid format");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60000) {
    throw new AutonomousExecutionRunnerError("INVALID_POLL_INTERVAL", "pollIntervalMs must be 100–60000");
  }
  if (!Number.isSafeInteger(maxJobsPerTick) || maxJobsPerTick < 1 || maxJobsPerTick > 100) {
    throw new AutonomousExecutionRunnerError("INVALID_BATCH_SIZE", "maxJobsPerTick must be 1–100");
  }
  if (!Number.isSafeInteger(maxConsecutiveErrors) || maxConsecutiveErrors < 1 || maxConsecutiveErrors > 20) {
    throw new AutonomousExecutionRunnerError("INVALID_ERROR_THRESHOLD", "maxConsecutiveErrors must be 1–20");
  }

  let state = "idle";
  let stopRequested = false;
  let loopPromise = null;
  let tickPromise = null;
  let timer = null;
  let wakeWait = null;
  let nextPollAt = null;
  let lastTickAt = null;
  let lastActivityAt = null;
  let ticks = 0;
  let processed = 0;
  let consecutiveErrors = 0;
  let lastErrorCode = null;
  let eventEmissionFailures = 0;

  function emitEvent(eventType, severity = "info", code) {
    if (!recordEvent) return;
    try {
      let supervisorId;
      try {
        const snapshot = getSupervisorStatus();
        if (typeof snapshot?.supervisorId === "string" && ID_PATTERN.test(snapshot.supervisorId)) {
          supervisorId = snapshot.supervisorId;
        }
      } catch {}
      const result = recordEvent({
        eventType,
        severity,
        stage: "runner",
        ...(supervisorId ? { supervisorId } : {}),
        ...(code ? { code } : {})
      });
      if (result && typeof result.then === "function") {
        eventEmissionFailures += 1;
        Promise.resolve(result).catch(() => {});
      }
    } catch {
      eventEmissionFailures += 1;
    }
  }

  function status() {
    let supervisor;
    try { supervisor = getSupervisorStatus(); } catch { supervisor = null; }
    const persistent = supervisor?.queue?.persistent;
    return Object.freeze({
      runnerId, state, started: state === "running", stopRequested,
      pollIntervalMs, maxJobsPerTick, maxConsecutiveErrors,
      lastTickAt, lastActivityAt, nextPollAt, ticks, processed,
      consecutiveErrors, lastErrorCode, eventEmissionFailures,
      queuePersistenceEnabled: typeof persistent === "boolean" ? persistent : null,
      supervisorState: supervisor?.state ?? "unavailable"
    });
  }

  async function tick() {
    if (state !== "running") return Object.freeze({ processed: 0, skipped: true });
    if (tickPromise) return tickPromise;
    tickPromise = (async () => {
      ticks += 1;
      lastTickAt = new Date().toISOString();
      try {
        const report = await drainSupervisor({ maxJobs: maxJobsPerTick });
        const count = Number.isSafeInteger(report?.processed) && report.processed >= 0 ? report.processed : 0;
        processed += count;
        if (count > 0) {
          lastActivityAt = new Date().toISOString();
          emitEvent("AUTONOMOUS_RUNNER_TICK", "info", "RUNNER_TICK_COMPLETED");
        }
        consecutiveErrors = 0;
        lastErrorCode = null;
        return Object.freeze({ processed: count, report });
      } catch (error) {
        consecutiveErrors += 1;
        lastErrorCode = typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(error.code)
          ? error.code : "RUNNER_TICK_FAILED";
        if (consecutiveErrors >= maxConsecutiveErrors) {
          state = "failed";
          stopRequested = true;
          nextPollAt = null;
          emitEvent("AUTONOMOUS_RUNNER_FAILED", "error", lastErrorCode);
        }
        return Object.freeze({ processed: 0, errorCode: lastErrorCode, consecutiveErrors });
      } finally {
        tickPromise = null;
      }
    })();
    return tickPromise;
  }

  function wait() {
    return new Promise((resolve) => {
      nextPollAt = new Date(Date.now() + pollIntervalMs).toISOString();
      wakeWait = resolve;
      timer = setTimeout(() => {
        timer = null;
        wakeWait = null;
        nextPollAt = null;
        resolve();
      }, pollIntervalMs);
    });
  }

  async function runLoop() {
    while (state === "running" && !stopRequested) {
      await tick();
      if (state !== "running" || stopRequested) break;
      await wait();
    }
    if (state === "running") state = "stopped";
  }

  function start() {
    if (state === "running") return status();
    if (state === "stopped" || state === "failed" || state === "closed") {
      throw new AutonomousExecutionRunnerError("RUNNER_TERMINAL", "runner cannot be restarted after stopping");
    }
    const supervisorStatus = getSupervisorStatus();
    if (supervisorStatus?.state === "closed" || supervisorStatus?.state === "closing") {
      throw new AutonomousExecutionRunnerError("SUPERVISOR_CLOSED", "supervisor is closing or closed");
    }
    startSupervisor();
    state = "running";
    stopRequested = false;
    emitEvent("AUTONOMOUS_RUNNER_STARTED", "info", "RUNNER_STARTED");
    loopPromise = runLoop();
    return status();
  }

  async function stop() {
    if (state === "idle") {
      state = "stopped";
      stopRequested = true;
      emitEvent("AUTONOMOUS_RUNNER_STOPPED", "info", "RUNNER_STOPPED");
      return status();
    }
    if (state === "stopped" || state === "closed") return status();
    stopRequested = true;
    if (timer) { clearTimeout(timer); timer = null; }
    nextPollAt = null;
    if (wakeWait) { const wake = wakeWait; wakeWait = null; wake(); }
    if (state !== "failed") state = "stopping";
    if (tickPromise) await tickPromise;
    if (loopPromise) await loopPromise;
    if (state !== "failed") {
      state = "stopped";
      emitEvent("AUTONOMOUS_RUNNER_STOPPED", "info", "RUNNER_STOPPED");
    }
    return status();
  }

  return Object.freeze({ runnerId, getStatus: status, tick, start, stop });
}
