function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

export function createHealthMonitor({ engine, clock = Date.now, maxServices = 1000, maxRecoveryAttempts = 5 } = {}) {
  if (!isRecord(engine) || typeof engine.evaluateRecovery !== "function") {
    throw new TypeError("a resilience engine instance is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!Number.isSafeInteger(maxServices) || maxServices < 1 || maxServices > 10_000 ||
      !Number.isSafeInteger(maxRecoveryAttempts) || maxRecoveryAttempts < 1 || maxRecoveryAttempts > 20) {
    throw new TypeError("health monitor capacity limits are invalid");
  }
  const states = new Map();

  function getState(serviceId) {
    return states.get(serviceId) ?? {
      consecutiveFailures: 0,
      restartCount: 0,
      lastRestartAt: null,
      lastObservedAt: null,
      status: "unknown",
      securityThreatActive: false
    };
  }

  function assertCanTrack(serviceId) {
    if (!states.has(serviceId) && states.size >= maxServices) {
      throw new RangeError("health monitor service capacity reached");
    }
  }

  function readClock() {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("clock must return a non-negative safe integer");
    }
    return now;
  }

  function observe({ serviceId, healthy, securityThreatActive = false } = {}) {
    if (typeof serviceId !== "string" || !SERVICE_ID.test(serviceId) ||
        typeof healthy !== "boolean" || typeof securityThreatActive !== "boolean") {
      throw new TypeError("health observation requires serviceId and boolean health/securityThreatActive values");
    }
    assertCanTrack(serviceId);
    const previous = getState(serviceId);
    const now = readClock();
    const next = {
      ...previous,
      consecutiveFailures: healthy ? 0 : previous.consecutiveFailures + 1,
      lastObservedAt: now,
      status: healthy ? "healthy" : "unhealthy",
      securityThreatActive
    };
    states.set(serviceId, next);
    if (healthy) return Object.freeze({ ...next, recovery: null });

    // Keep observing unhealthy services, but never issue a new proposal after the monitor's attempt cap.
    // Security-threat suspension remains the most informative reason when both conditions apply.
    if (next.securityThreatActive) {
      return Object.freeze({
        ...next,
        recovery: Object.freeze({ eligible: false, reason: "security-threat-active" })
      });
    }
    if (next.restartCount >= maxRecoveryAttempts) {
      return Object.freeze({
        ...next,
        recovery: Object.freeze({ eligible: false, reason: "recovery-attempt-limit-reached" })
      });
    }

    const recovery = engine.evaluateRecovery({
      serviceId,
      consecutiveFailures: next.consecutiveFailures,
      restartCount: next.restartCount,
      lastRestartAt: next.lastRestartAt,
      securityThreatActive: next.securityThreatActive
    });
    return Object.freeze({ ...next, recovery });
  }

  function recordRecoveryAttempt({ serviceId, executed } = {}) {
    if (typeof serviceId !== "string" || !SERVICE_ID.test(serviceId) || typeof executed !== "boolean") {
      throw new TypeError("recovery result requires serviceId and boolean executed");
    }
    assertCanTrack(serviceId);
    const previous = getState(serviceId);
    if (previous.restartCount >= maxRecoveryAttempts) {
      throw new RangeError("health monitor recovery-attempt limit reached");
    }
    const now = readClock();
    const next = {
      ...previous,
      restartCount: previous.restartCount + 1,
      lastRestartAt: now,
      status: executed ? "recovery-requested" : "recovery-failed"
    };
    states.set(serviceId, next);
    return Object.freeze({ ...next });
  }

  function getSnapshot(serviceId) {
    if (typeof serviceId !== "string" || !SERVICE_ID.test(serviceId)) {
      throw new TypeError("serviceId is required and must be valid");
    }
    return Object.freeze({ ...getState(serviceId) });
  }

  return Object.freeze({ observe, recordRecoveryAttempt, getSnapshot });
}
