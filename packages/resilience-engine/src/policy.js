const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateResiliencePolicy(policy) {
  if (!isRecord(policy) ||
      policy.schema !== "jb.resilience.policy/v1" ||
      policy.mode !== "semi-autonomous" ||
      !Number.isSafeInteger(policy.failureThreshold) ||
      policy.failureThreshold < 1 || policy.failureThreshold > 10 ||
      !Number.isSafeInteger(policy.maxRestarts) ||
      policy.maxRestarts < 0 || policy.maxRestarts > 5 ||
      !Number.isSafeInteger(policy.cooldownMs) ||
      policy.cooldownMs < 1000 || policy.cooldownMs > 86_400_000 ||
      !Array.isArray(policy.services) || policy.services.length > 100) {
    throw new TypeError("resilience policy is invalid");
  }
  const seen = new Set();
  const services = policy.services.map((service) => {
    if (!isRecord(service) || typeof service.id !== "string" ||
        !SERVICE_ID.test(service.id) || typeof service.critical !== "boolean" ||
        seen.has(service.id)) throw new TypeError("resilience service allowlist is invalid");
    seen.add(service.id);
    return Object.freeze({ id: service.id, critical: service.critical });
  });
  return Object.freeze({
    schema: policy.schema, mode: policy.mode,
    failureThreshold: policy.failureThreshold,
    maxRestarts: policy.maxRestarts, cooldownMs: policy.cooldownMs,
    services: Object.freeze(services)
  });
}

export function evaluateRecoveryEligibility(policy, {
  serviceId, consecutiveFailures, restartCount, lastRestartAt = null, now
} = {}) {
  const service = policy.services.find((entry) => entry.id === serviceId);
  if (!service) return Object.freeze({ eligible: false, reason: "service-not-allowlisted" });
  if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 0 ||
      !Number.isSafeInteger(restartCount) || restartCount < 0 ||
      !Number.isSafeInteger(now) || now < 0 ||
      (lastRestartAt !== null && (!Number.isSafeInteger(lastRestartAt) || lastRestartAt < 0))) {
    return Object.freeze({ eligible: false, reason: "invalid-recovery-state" });
  }
  if (consecutiveFailures < policy.failureThreshold) {
    return Object.freeze({ eligible: false, reason: "failure-threshold-not-reached" });
  }
  if (restartCount >= policy.maxRestarts) {
    return Object.freeze({ eligible: false, reason: "restart-limit-reached" });
  }
  if (lastRestartAt !== null && now - lastRestartAt < policy.cooldownMs) {
    return Object.freeze({ eligible: false, reason: "restart-cooldown-active" });
  }
  return Object.freeze({
    eligible: true, action: "restart-service", serviceId,
    approvalRequired: service.critical,
    reason: service.critical ? "critical-service-requires-human-approval" : "allowlisted-recovery"
  });
}
