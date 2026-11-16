const A2_REQUIREMENTS = Object.freeze([
  "confirmedSecurityVerdict",
  "trustedSignal",
  "replayProtectedSignal",
  "exactAssetBinding",
  "ownerApprovedProfile",
  "reversibleAdapter",
  "independentContainmentVerification",
  "rollbackPlan",
  "forensicEvidencePreserved",
  "budgetAvailable"
]);

const A3_REQUIREMENTS = Object.freeze([
  "independentExternalMonitor",
  "monitorQuorum",
  "durableCoordination",
  "exclusiveUnexpiredLease",
  "monotonicFencing",
  "targetEnforcesFencing",
  "sourceFenced",
  "replicationHealthy",
  "replicationWithinRpo",
  "targetReady",
  "dependenciesReady",
  "trafficCutoverPrepared",
  "rollbackPrepared",
  "postFailoverVerification",
  "budgetAvailable"
]);

const VALID_GATES = new Set([...A2_REQUIREMENTS, ...A3_REQUIREMENTS]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function evaluate(kind, evidence, requirements) {
  if (!isRecord(evidence)) {
    return Object.freeze({
      schema: "jb.resilience.continuity-readiness/v1",
      capability: kind,
      eligible: false,
      denied: Object.freeze([...requirements]),
      reason: "invalid-evidence"
    });
  }

  const denied = [];
  for (const key of requirements) {
    if (evidence[key] !== true) denied.push(key);
  }

  const allowedKeys = new Set([...requirements, "observedAt", "expiresAt", "now"]);
  if (Object.keys(evidence).some((key) => !allowedKeys.has(key))) {
    return Object.freeze({
      schema: "jb.resilience.continuity-readiness/v1",
      capability: kind,
      eligible: false,
      denied: Object.freeze([...requirements]),
      reason: "unsupported-evidence-field"
    });
  }

  const { observedAt, expiresAt, now } = evidence;
  if (![observedAt, expiresAt, now].every(Number.isSafeInteger) ||
      observedAt < 0 || expiresAt <= observedAt || now < observedAt || now >= expiresAt) {
    denied.push("freshnessWindow");
  }

  return Object.freeze({
    schema: "jb.resilience.continuity-readiness/v1",
    capability: kind,
    eligible: denied.length === 0,
    denied: Object.freeze(denied),
    reason: denied.length === 0 ? null : "continuity-gates-not-satisfied",
    executable: false
  });
}

/**
 * Read-only A2/A3 readiness gates. This module never performs containment,
 * promotion, traffic changes, host commands or any other mutation.
 *
 * Every boolean must be derived by a host-owned verifier from authoritative
 * evidence. Caller-supplied booleans are not proof and must not cross a trust
 * boundary without verification by the host integration.
 */
export function evaluateA2ContainmentReadiness(evidence) {
  return evaluate("A2-bounded-containment", evidence, A2_REQUIREMENTS);
}

export function evaluateA3FailoverReadiness(evidence) {
  return evaluate("A3-controlled-failover", evidence, A3_REQUIREMENTS);
}

export const CONTINUITY_GATE_REQUIREMENTS = Object.freeze({
  A2: A2_REQUIREMENTS,
  A3: A3_REQUIREMENTS
});
