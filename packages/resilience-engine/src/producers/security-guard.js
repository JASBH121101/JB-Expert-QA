import { normalizeProducerOptions, signProducerSignal, isUuid } from "./shared.js";

const DECISIONS = new Set(["observe", "challenge", "review", "block"]);
const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const EVENT_ACTIONS = new Set(["observed", "challenged", "blocked"]);
const EVENT_OUTCOMES = new Set(["success", "denied", "unavailable", "error", "observed"]);
const IDENTIFIER = /^[A-Za-z0-9:_-]{1,96}$/;
const RULE_ID = /^[A-Z0-9][A-Z0-9_-]{2,95}$/;

function severityForScore(score) {
  if (score >= 90) return "critical";
  if (score >= 75) return "high";
  if (score >= 45) return "medium";
  if (score >= 15) return "low";
  return "info";
}

/**
 * Converts existing Security Guard Core v1 outputs into authenticated
 * Resilience signals. This adapter never promotes an assessment/event to
 * confirmed or tampered: request-policy decisions are not proof of host
 * compromise. An "observe" assessment remains unknown, not a clean heartbeat.
 */
export function createSecurityGuardSignalProducer(options = {}) {
  const config = normalizeProducerOptions(options, "security-guard");

  function fromThreatAssessment(assessment) {
    if (!assessment || typeof assessment !== "object" || Array.isArray(assessment) ||
        assessment.schema !== "jb.security.threat-assessment/v1" ||
        !isUuid(assessment.assessmentId) ||
        !Number.isSafeInteger(assessment.assessedAtMs) || assessment.assessedAtMs < 0 ||
        !Number.isSafeInteger(assessment.riskScore) ||
        assessment.riskScore < 0 || assessment.riskScore > 100 ||
        !DECISIONS.has(assessment.decision) ||
        typeof assessment.tenantId !== "string" || !IDENTIFIER.test(assessment.tenantId) ||
        typeof assessment.applicationId !== "string" || !IDENTIFIER.test(assessment.applicationId) ||
        typeof assessment.policyId !== "string" || !IDENTIFIER.test(assessment.policyId) ||
        !Array.isArray(assessment.signalIds) ||
        assessment.signalIds.length < 1 || assessment.signalIds.length > 128 ||
        assessment.signalIds.some((id) => !isUuid(id)) ||
        new Set(assessment.signalIds).size !== assessment.signalIds.length) {
      throw new TypeError("assessment is not a valid Security Guard threat-assessment/v1 result");
    }

    const state = assessment.decision === "observe" ? "unknown" : "suspected";
    return signProducerSignal(config, {
      eventId: assessment.assessmentId,
      issuedAtMs: assessment.assessedAtMs,
      state,
      severity: severityForScore(assessment.riskScore),
      reasonCode: "SECURITY_GUARD_" + assessment.decision.toUpperCase()
    });
  }

  function fromSecurityEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event) ||
        event.schema !== "jb.security.event/v1" ||
        !isUuid(event.eventId) ||
        !Number.isSafeInteger(event.occurredAtMs) || event.occurredAtMs < 0 ||
        event.producer !== "security-guard-node" ||
        event.category !== "threat" ||
        typeof event.tenantId !== "string" || !IDENTIFIER.test(event.tenantId) ||
        typeof event.applicationId !== "string" || !IDENTIFIER.test(event.applicationId) ||
        typeof event.ruleId !== "string" || !RULE_ID.test(event.ruleId) ||
        !SEVERITIES.has(event.severity) ||
        !EVENT_ACTIONS.has(event.action) ||
        !EVENT_OUTCOMES.has(event.outcome)) {
      throw new TypeError("event is not a supported Security Guard Core v1 threat event");
    }

    return signProducerSignal(config, {
      eventId: event.eventId,
      issuedAtMs: event.occurredAtMs,
      state: event.action === "observed" ? "unknown" : "suspected",
      severity: event.severity,
      reasonCode: "SECURITY_GUARD_THREAT_EVENT"
    });
  }

  return Object.freeze({ fromThreatAssessment, fromSecurityEvent });
}
