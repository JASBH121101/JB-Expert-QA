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

function normalizeEvidence(value, allowedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;

  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) return null;

    const normalized = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return null;
      if (!allowedKeys.has(key)) {
        return { unsupported: true };
      }
      normalized[key] = descriptor.value;
    }

    return { value: normalized, unsupported: false };
  } catch {
    return null;
  }
}

function evaluate(kind, evidence, requirements) {
  const allowedKeys = new Set([...requirements, "observedAt", "expiresAt", "now"]);
  const normalized = normalizeEvidence(evidence, allowedKeys);

  if (normalized === null) {
    return Object.freeze({
      schema: "jb.resilience.continuity-readiness/v1",
      capability: kind,
      eligible: false,
      denied: Object.freeze([...requirements]),
      reason: "invalid-evidence",
      executable: false
    });
  }

  if (normalized.unsupported) {
    return Object.freeze({
      schema: "jb.resilience.continuity-readiness/v1",
      capability: kind,
      eligible: false,
      denied: Object.freeze([...requirements]),
      reason: "unsupported-evidence-field",
      executable: false
    });
  }

  const denied = [];
  const safeEvidence = normalized.value;
  for (const key of requirements) {
    if (safeEvidence[key] !== true) denied.push(key);
  }

  const { observedAt, expiresAt, now } = safeEvidence;
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
