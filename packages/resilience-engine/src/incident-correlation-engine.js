import { createHash } from "node:crypto";

const INCIDENT_SCHEMA = "jb.resilience.incident-decision/v1";
const INPUT_SCHEMA = "jb.resilience.incident-input/v1";
const HEALTH_SCHEMA = "jb.resilience.health-observation/v1";
const SECURITY_SCHEMA = "jb.resilience.signal-state/v1";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASON_CODE = /^[A-Z][A-Z0-9_.:-]{1,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SECURITY_STATES = new Set([
  "clear", "suspected", "confirmed", "tampered", "unknown", "conflicting", "stale"
]);
const SOURCE_STATES = new Set([
  "clear", "suspected", "confirmed", "tampered", "unknown"
]);
const SOURCE_ENGINES = new Set(["security-guard", "malware-engine"]);
const HEALTH_STATES = new Set(["healthy", "unhealthy", "unknown"]);
const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);

const RULE_ORDER = Object.freeze([
  "OBSERVATION_ID_CONFLICT",
  "SECURITY_TAMPERED",
  "SECURITY_CONFIRMED",
  "SIGNAL_CONFLICT",
  "HEALTH_CONFLICT",
  "SECURITY_STALE",
  "SECURITY_UNKNOWN",
  "SECURITY_SUSPECTED_WITH_FAILURE",
  "SECURITY_SUSPECTED",
  "HEALTH_UNKNOWN",
  "HEALTH_FAILURE_THRESHOLD",
  "HEALTH_DEGRADED",
  "ALL_CLEAR"
]);

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (["__proto__", "prototype", "constructor"].includes(key) ||
        !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      return false;
    }
  }
  return true;
}

function assertExactKeys(value, required, optional, label) {
  if (!isPlainRecord(value)) {
    throw new TypeError(label + " must be a plain data object without accessors");
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) ||
      keys.some((key) => !allowed.has(key))) {
    throw new TypeError(label + " has missing or unsupported fields");
  }
}

function assertDenseArray(value, label, maxLength) {
  if (!Array.isArray(value) || value.length > maxLength ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.keys(value).length !== value.length) {
    throw new TypeError(label + " must be a dense array within its configured limit");
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " must not contain holes or accessors");
    }
  }
}

function assertIdentifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(label + " is invalid");
  }
  return value;
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(label + " must be a non-negative safe integer timestamp");
  }
  return value;
}

function validateEvidenceRefs(value, label) {
  assertDenseArray(value, label, 32);
  const seen = new Set();
  return Object.freeze(value.map((item, index) => {
    assertExactKeys(item, ["refId", "sha256"], [], label + "[" + index + "]");
    assertIdentifier(item.refId, ASSET_ID, label + "[" + index + "].refId");
    if (typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) {
      throw new TypeError(label + "[" + index + "].sha256 must be lowercase SHA-256 hex");
    }
    const key = item.refId + ":" + item.sha256;
    if (seen.has(key)) throw new TypeError(label + " contains duplicate evidence references");
    seen.add(key);
    return Object.freeze({ refId: item.refId, sha256: item.sha256 });
  }));
}

function validateSecurityState(value, assetId, environment, now, windowMs, maxClockSkewMs) {
  assertExactKeys(value, [
    "schema", "state", "reason", "assetId", "environment",
    "sources", "evidenceRefs", "preserveEvidence", "authorizationGranted"
  ], [], "securityState");
  if (value.schema !== SECURITY_SCHEMA || !SECURITY_STATES.has(value.state)) {
    throw new TypeError("securityState must be a Trusted Signal Gateway signal-state/v1 result");
  }
  if (value.assetId !== assetId || value.environment !== environment) {
    throw new TypeError("securityState asset/environment scope does not match the incident input");
  }
  if (typeof value.reason !== "string" || !/^[a-z][a-z0-9-]{1,95}$/.test(value.reason)) {
    throw new TypeError("securityState.reason is invalid");
  }
  if (value.preserveEvidence !== true || value.authorizationGranted !== false) {
    throw new TypeError("securityState must preserve evidence and must never grant authorization");
  }

  assertDenseArray(value.sources, "securityState.sources", 32);
  const sourceIds = new Map();
  const sources = value.sources.map((source, index) => {
    assertExactKeys(source, [
      "sourceId", "sourceEngine", "state", "issuedAtMs", "reasonCode"
    ], ["severity"], "securityState.sources[" + index + "]");
    assertIdentifier(source.sourceId, IDENTIFIER, "security source ID");
    const priorSource = sourceIds.get(source.sourceId);
    if (priorSource) {
      if (value.state !== "conflicting" ||
          priorSource.sourceEngine !== source.sourceEngine ||
          priorSource.issuedAtMs !== source.issuedAtMs ||
          priorSource.states.has(source.state)) {
        throw new TypeError("securityState contains an invalid duplicate source identity");
      }
      priorSource.states.add(source.state);
    } else {
      sourceIds.set(source.sourceId, {
        sourceEngine: source.sourceEngine,
        issuedAtMs: source.issuedAtMs,
        states: new Set([source.state])
      });
    }
    if (!SOURCE_ENGINES.has(source.sourceEngine) || !SOURCE_STATES.has(source.state)) {
      throw new TypeError("securityState contains an unsupported source engine or state");
    }
    assertTimestamp(source.issuedAtMs, "security source issuedAtMs");
    if (source.issuedAtMs > now + maxClockSkewMs) {
      throw new TypeError("security source timestamp is too far in the future");
    }
    assertIdentifier(source.reasonCode, REASON_CODE, "security source reasonCode");
    if (Object.hasOwn(source, "severity") && !SEVERITIES.has(source.severity)) {
      throw new TypeError("security source severity is invalid");
    }
    return Object.freeze({
      sourceId: source.sourceId,
      sourceEngine: source.sourceEngine,
      state: source.state,
      issuedAtMs: source.issuedAtMs,
      reasonCode: source.reasonCode,
      ...(Object.hasOwn(source, "severity") ? { severity: source.severity } : {})
    });
  });

  if (value.state === "clear" &&
      (sources.length === 0 || sources.some((source) => source.state !== "clear"))) {
    throw new TypeError("a clear security state requires at least one clear source and no contradictory source");
  }
  const evidenceRefs = validateEvidenceRefs(value.evidenceRefs, "securityState.evidenceRefs");
  let effectiveState = value.state;
  let effectiveReason = value.reason;
  if (["clear", "suspected"].includes(effectiveState) &&
      sources.some((source) => now - source.issuedAtMs > windowMs)) {
    effectiveState = "stale";
    effectiveReason = "trusted-signal-snapshot-stale";
  }

  return Object.freeze({
    state: effectiveState,
    reason: effectiveReason,
    assetId: value.assetId,
    environment: value.environment,
    sources: Object.freeze(sources),
    evidenceRefs
  });
}

function validateHealthObservation(value, assetId, environment, serviceId) {
  assertExactKeys(value, [
    "schema", "observationId", "assetId", "environment", "serviceId",
    "observedAtMs", "status", "consecutiveFailures", "reasonCode"
  ], [], "health observation");
  if (value.schema !== HEALTH_SCHEMA) {
    throw new TypeError("health observation schema is unsupported");
  }
  assertIdentifier(value.observationId, UUID, "health observationId");
  if (value.assetId !== assetId ||
      value.environment !== environment ||
      value.serviceId !== serviceId) {
    throw new TypeError("health observation asset/environment/service scope mismatch");
  }
  assertTimestamp(value.observedAtMs, "health observation observedAtMs");
  if (!HEALTH_STATES.has(value.status)) {
    throw new TypeError("health observation status is unsupported");
  }
  if (!Number.isSafeInteger(value.consecutiveFailures) ||
      value.consecutiveFailures < 0 || value.consecutiveFailures > 1_000_000) {
    throw new TypeError("health observation consecutiveFailures is invalid");
  }
  if (value.status === "healthy" && value.consecutiveFailures !== 0) {
    throw new TypeError("healthy observations must have zero consecutive failures");
  }
  if (value.status === "unhealthy" && value.consecutiveFailures < 1) {
    throw new TypeError("unhealthy observations must report at least one consecutive failure");
  }
  assertIdentifier(value.reasonCode, REASON_CODE, "health observation reasonCode");

  return Object.freeze({
    schema: HEALTH_SCHEMA,
    observationId: value.observationId,
    assetId,
    environment,
    serviceId,
    observedAtMs: value.observedAtMs,
    status: value.status,
    consecutiveFailures: value.consecutiveFailures,
    reasonCode: value.reasonCode
  });
}

function fingerprintObservation(observation) {
  return JSON.stringify({
    observationId: observation.observationId,
    assetId: observation.assetId,
    environment: observation.environment,
    serviceId: observation.serviceId,
    observedAtMs: observation.observedAtMs,
    status: observation.status,
    consecutiveFailures: observation.consecutiveFailures,
    reasonCode: observation.reasonCode
  });
}

function compareObservations(left, right) {
  return left.observedAtMs - right.observedAtMs ||
    left.observationId.localeCompare(right.observationId);
}

function incidentIdFor({ assetId, environment, serviceId, windowStartMs }) {
  const material = [
    "jb.resilience.incident/v1",
    assetId,
    environment,
    serviceId,
    String(windowStartMs)
  ].join("\0");
  const digest = createHash("sha256").update(material, "utf8").digest("hex");
  return "incident-" + digest.slice(0, 32);
}

function buildHealthSummary(observations, now, windowMs, maxClockSkewMs, settings) {
  const normalized = [];
  const byId = new Map();
  let duplicateIdConflict = false;

  for (let index = 0; index < observations.length; index += 1) {
    const item = validateHealthObservation(
      observations[index], settings.assetId, settings.environment, settings.serviceId
    );
    if (item.observedAtMs > now + maxClockSkewMs) {
      throw new TypeError("health observation is too far in the future");
    }
    const fingerprint = fingerprintObservation(item);
    const prior = byId.get(item.observationId);
    if (prior) {
      if (prior !== fingerprint) duplicateIdConflict = true;
      continue;
    }
    byId.set(item.observationId, fingerprint);
    normalized.push(item);
  }

  normalized.sort(compareObservations);
  const cutoff = Math.max(0, now - windowMs);
  const fresh = normalized.filter((item) => item.observedAtMs >= cutoff);
  const ignoredStaleObservationIds = normalized
    .filter((item) => item.observedAtMs < cutoff)
    .map((item) => item.observationId)
    .sort();

  if (fresh.length === 0) {
    return Object.freeze({
      state: duplicateIdConflict ? "conflicting" : "unknown",
      reason: duplicateIdConflict ? "duplicate-observation-id-conflict" : "no-fresh-health-observations",
      lastObservedAtMs: null,
      consecutiveFailures: 0,
      observationsInWindow: 0,
      unhealthyObservationsInWindow: 0,
      observationIds: Object.freeze([]),
      ignoredStaleObservationIds: Object.freeze(ignoredStaleObservationIds),
      duplicateIdConflict
    });
  }

  const latestTime = fresh[fresh.length - 1].observedAtMs;
  const latest = fresh.filter((item) => item.observedAtMs === latestTime);
  const latestStates = new Set(latest.map((item) =>
    item.status + ":" + item.consecutiveFailures
  ));
  const latestConflict = latestStates.size > 1;
  const latestObservation = latest[latest.length - 1];
  const state = duplicateIdConflict || latestConflict
    ? "conflicting"
    : latestObservation.status;

  return Object.freeze({
    state,
    reason: duplicateIdConflict
      ? "duplicate-observation-id-conflict"
      : latestConflict ? "same-time-health-observations-disagree"
        : latestObservation.reasonCode.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    lastObservedAtMs: latestTime,
    consecutiveFailures: state === "unhealthy" ? latestObservation.consecutiveFailures : 0,
    observationsInWindow: fresh.length,
    unhealthyObservationsInWindow: fresh.filter((item) => item.status === "unhealthy").length,
    observationIds: Object.freeze(fresh.map((item) => item.observationId).sort()),
    ignoredStaleObservationIds: Object.freeze(ignoredStaleObservationIds),
    duplicateIdConflict
  });
}

function deriveDecision(security, health, thresholds) {
  const unhealthy = health.state === "unhealthy";
  const failedThreshold = unhealthy &&
    health.consecutiveFailures >= thresholds.escalationFailureThreshold;
  const criticalFailure = unhealthy &&
    health.consecutiveFailures >= thresholds.criticalFailureThreshold;

  const matched = {
    OBSERVATION_ID_CONFLICT: health.duplicateIdConflict,
    SECURITY_TAMPERED: security.state === "tampered",
    SECURITY_CONFIRMED: security.state === "confirmed",
    SIGNAL_CONFLICT: security.state === "conflicting",
    HEALTH_CONFLICT: health.state === "conflicting",
    SECURITY_STALE: security.state === "stale",
    SECURITY_UNKNOWN: security.state === "unknown",
    SECURITY_SUSPECTED_WITH_FAILURE: security.state === "suspected" && unhealthy,
    SECURITY_SUSPECTED: security.state === "suspected",
    HEALTH_UNKNOWN: health.state === "unknown",
    HEALTH_FAILURE_THRESHOLD: security.state === "clear" && failedThreshold,
    HEALTH_DEGRADED: security.state === "clear" && unhealthy && !failedThreshold,
    ALL_CLEAR: security.state === "clear" && health.state === "healthy"
  };

  let selectedRule;
  let priority;
  let riskScore;
  let decision;
  let recommendedNextStep;

  if (matched.OBSERVATION_ID_CONFLICT) {
    selectedRule = "OBSERVATION_ID_CONFLICT";
    priority = "critical";
    riskScore = 100;
    decision = "escalate";
    recommendedNextStep = "hold-and-human-review";
  } else if (matched.SECURITY_TAMPERED) {
    selectedRule = "SECURITY_TAMPERED";
    priority = "critical";
    riskScore = 100;
    decision = "human-review";
    recommendedNextStep = "preserve-evidence-and-human-review";
  } else if (matched.SECURITY_CONFIRMED) {
    selectedRule = "SECURITY_CONFIRMED";
    priority = "critical";
    riskScore = 95;
    decision = "human-review";
    recommendedNextStep = "preserve-evidence-and-human-review";
  } else if (matched.SIGNAL_CONFLICT) {
    selectedRule = "SIGNAL_CONFLICT";
    priority = "critical";
    riskScore = 92;
    decision = "escalate";
    recommendedNextStep = "hold-and-human-review";
  } else if (matched.HEALTH_CONFLICT) {
    selectedRule = "HEALTH_CONFLICT";
    priority = "critical";
    riskScore = 90;
    decision = "escalate";
    recommendedNextStep = "request-health-reconciliation";
  } else if (matched.SECURITY_STALE) {
    selectedRule = "SECURITY_STALE";
    priority = "high";
    riskScore = 80;
    decision = "hold";
    recommendedNextStep = "refresh-trusted-security-signals";
  } else if (matched.SECURITY_UNKNOWN) {
    selectedRule = "SECURITY_UNKNOWN";
    priority = "high";
    riskScore = 75;
    decision = "hold";
    recommendedNextStep = "refresh-trusted-security-signals";
  } else if (matched.SECURITY_SUSPECTED_WITH_FAILURE) {
    selectedRule = "SECURITY_SUSPECTED_WITH_FAILURE";
    priority = criticalFailure ? "critical" : "high";
    riskScore = Math.min(100, 75 + Math.min(25, health.consecutiveFailures * 5));
    decision = "escalate";
    recommendedNextStep = "human-review";
  } else if (matched.SECURITY_SUSPECTED) {
    selectedRule = "SECURITY_SUSPECTED";
    priority = "high";
    riskScore = 65;
    decision = "escalate";
    recommendedNextStep = "human-review";
  } else if (matched.HEALTH_UNKNOWN) {
    selectedRule = "HEALTH_UNKNOWN";
    priority = "medium";
    riskScore = 35;
    decision = "hold";
    recommendedNextStep = "request-fresh-health-observation";
  } else if (matched.HEALTH_FAILURE_THRESHOLD) {
    selectedRule = "HEALTH_FAILURE_THRESHOLD";
    priority = criticalFailure ? "critical" : "high";
    riskScore = Math.min(90, 45 + Math.min(45, health.consecutiveFailures * 7));
    decision = "review-recovery-policy";
    recommendedNextStep = "evaluate-a1-policy-separately";
  } else if (matched.HEALTH_DEGRADED) {
    selectedRule = "HEALTH_DEGRADED";
    priority = "medium";
    riskScore = Math.min(60, 25 + health.consecutiveFailures * 5);
    decision = "observe";
    recommendedNextStep = "continue-health-monitoring";
  } else {
    selectedRule = "ALL_CLEAR";
    priority = "info";
    riskScore = 0;
    decision = "observe";
    recommendedNextStep = "none";
  }

  const trace = Object.freeze(RULE_ORDER.map((ruleId) => Object.freeze({
    ruleId,
    matched: matched[ruleId] === true,
    selected: ruleId === selectedRule
  })));

  return Object.freeze({
    selectedRule,
    priority,
    riskScore,
    decision,
    recommendedNextStep,
    trace
  });
}

/**
 * Correlates one trusted security-state snapshot with bounded host health
 * observations for one exact asset/environment/service and a fixed time window.
 * This engine is deterministic and read-only. It does not persist incidents,
 * authorize recovery, execute actions, collect telemetry, or modify source engines.
 */
export function createIncidentCorrelationEngine(options = {}) {
  const allowed = new Set([
    "clock", "windowMs", "maxClockSkewMs", "maxHealthObservations",
    "escalationFailureThreshold", "criticalFailureThreshold"
  ]);
  if (!isPlainRecord(options)) throw new TypeError("incident engine options must be a plain data object");
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("unsupported incident engine option: " + key);
  }

  const clock = options.clock ?? Date.now;
  const windowMs = options.windowMs ?? 5 * 60_000;
  const maxClockSkewMs = options.maxClockSkewMs ?? 30_000;
  const maxHealthObservations = options.maxHealthObservations ?? 100;
  const escalationFailureThreshold = options.escalationFailureThreshold ?? 3;
  const criticalFailureThreshold = options.criticalFailureThreshold ?? 5;

  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!Number.isSafeInteger(windowMs) || windowMs < 30_000 || windowMs > 30 * 60_000) {
    throw new TypeError("windowMs must be between 30000 and 1800000");
  }
  if (!Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0 || maxClockSkewMs > 120_000) {
    throw new TypeError("maxClockSkewMs must be between 0 and 120000");
  }
  if (!Number.isSafeInteger(maxHealthObservations) ||
      maxHealthObservations < 1 || maxHealthObservations > 500) {
    throw new TypeError("maxHealthObservations must be between 1 and 500");
  }
  if (!Number.isSafeInteger(escalationFailureThreshold) ||
      escalationFailureThreshold < 1 || escalationFailureThreshold > 100) {
    throw new TypeError("escalationFailureThreshold must be between 1 and 100");
  }
  if (!Number.isSafeInteger(criticalFailureThreshold) ||
      criticalFailureThreshold <= escalationFailureThreshold ||
      criticalFailureThreshold > 1_000_000) {
    throw new TypeError("criticalFailureThreshold must exceed escalationFailureThreshold and be at most 1000000");
  }

  function evaluateIncident(input) {
    assertExactKeys(input, [
      "schema", "assetId", "environment", "serviceId",
      "securityState", "healthObservations"
    ], [], "incident input");
    if (input.schema !== INPUT_SCHEMA) {
      throw new TypeError("incident input schema is unsupported");
    }
    const assetId = assertIdentifier(input.assetId, ASSET_ID, "assetId");
    const environment = assertIdentifier(input.environment, IDENTIFIER, "environment");
    const serviceId = assertIdentifier(input.serviceId, IDENTIFIER, "serviceId");
    const now = clock();
    assertTimestamp(now, "incident engine clock");

    const security = validateSecurityState(
      input.securityState, assetId, environment, now, windowMs, maxClockSkewMs
    );
    assertDenseArray(input.healthObservations, "healthObservations", maxHealthObservations);
    const health = buildHealthSummary(
      input.healthObservations,
      now,
      windowMs,
      maxClockSkewMs,
      { assetId, environment, serviceId }
    );
    const decision = deriveDecision(security, health, {
      escalationFailureThreshold,
      criticalFailureThreshold
    });
    const windowStartMs = Math.floor(now / windowMs) * windowMs;
    const incidentId = incidentIdFor({
      assetId, environment, serviceId, windowStartMs
    });

    return Object.freeze({
      schema: INCIDENT_SCHEMA,
      incidentId,
      assetId,
      environment,
      serviceId,
      window: Object.freeze({
        startMs: windowStartMs,
        endMs: now,
        durationMs: windowMs
      }),
      evaluatedAtMs: now,
      security: Object.freeze({
        state: security.state,
        reason: security.reason,
        sources: security.sources,
        evidenceRefs: security.evidenceRefs
      }),
      health,
      priority: decision.priority,
      riskScore: decision.riskScore,
      decision: decision.decision,
      recommendedNextStep: decision.recommendedNextStep,
      decisionRule: decision.selectedRule,
      trace: decision.trace,
      reasonCodes: Object.freeze([
        security.state === "clear" ? "SECURITY_CLEAR" : "SECURITY_" + security.state.toUpperCase(),
        "HEALTH_" + health.state.toUpperCase(),
        decision.selectedRule
      ]),
      evidenceRefs: security.evidenceRefs,
      preserveEvidence: true,
      authorizationGranted: false,
      mayAuthorizeRecovery: false
    });
  }

  return Object.freeze({
    engine: "JB Resilience Engine",
    module: "Incident Correlation & Decision Engine",
    version: "0.5.0",
    mode: "deterministic-read-only",
    windowMs,
    evaluateIncident
  });
}
