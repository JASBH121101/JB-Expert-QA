function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

  function observe({ serviceId, healthy, securityThreatActive = false } = {}) {
    if (typeof serviceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(serviceId) ||
        typeof healthy !== "boolean" || typeof securityThreatActive !== "boolean") {
      throw new TypeError("health observation requires serviceId and boolean health/securityThreatActive values");
    }
    if (!states.has(serviceId) && states.size >= maxServices) {
      throw new RangeError("health monitor service capacity reached");
    }
    if (!states.has(serviceId) && states.size >= maxServices) {
      throw new RangeError("health monitor service capacity reached");
    }
    const previous = getState(serviceId);
    if (previous.restartCount >= maxRecoveryAttempts) {
      throw new RangeError("health monitor recovery-attempt limit reached");
    }
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("clock must return a non-negative safe integer");
    }
    const next = {
      ...previous,
      consecutiveFailures: healthy ? 0 : previous.consecutiveFailures + 1,
      lastObservedAt: now,
      status: healthy ? "healthy" : "unhealthy",
      securityThreatActive
    };
    states.set(serviceId, next);
    if (healthy) return Object.freeze({ ...next, recovery: null });
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
    if (typeof serviceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(serviceId) || typeof executed !== "boolean") {
      throw new TypeError("recovery result requires serviceId and boolean executed");
    }
    const previous = getState(serviceId);
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("clock must return a non-negative safe integer");
    }
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
    if (typeof serviceId !== "string" || !serviceId) {
      throw new TypeError("serviceId is required");
    }
    return Object.freeze({ ...getState(serviceId) });
  }

  return Object.freeze({ observe, recordRecoveryAttempt, getSnapshot });
}
