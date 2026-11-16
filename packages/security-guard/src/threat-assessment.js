import { randomUUID } from "node:crypto";
import {
  validateThreatAssessmentPolicyV1,
  validateThreatAssessmentV1,
  validateThreatSignalV1
} from "./core-contract-v1.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function signalContribution(signal, policy) {
  const severityWeight = policy.severityWeights[signal.severity];
  const typeWeight = policy.typeWeights[signal.type];
  return Math.round(severityWeight * typeWeight * signal.confidence / 100);
}

/**
 * Creates a deterministic, server-policy-owned Core v1 threat assessor.
 *
 * This component only creates a risk assessment. It does not block requests,
 * issue challenges, mutate middleware behavior, or persist signals.
 */
export function createThreatAssessmentEngine(options = {}) {
  if (!isRecord(options)) throw new TypeError("Threat assessment options must be an object");
  for (const key of Object.keys(options)) {
    if (!["policy", "clock", "idGenerator"].includes(key)) {
      throw new TypeError("Unknown threat assessment option: " + key);
    }
  }

  const policy = validateThreatAssessmentPolicyV1(options.policy);
  const clock = options.clock ?? Date.now;
  const idGenerator = options.idGenerator ?? randomUUID;
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (typeof idGenerator !== "function") throw new TypeError("idGenerator must be a function");

  function assess(inputSignals) {
    if (!policy.enabled) return null;
    if (!Array.isArray(inputSignals) || inputSignals.length > 128) {
      throw new TypeError("signals must be an array containing at most 128 entries");
    }
    if (inputSignals.length === 0) return null;

    const assessedAtMs = clock();
    if (!Number.isSafeInteger(assessedAtMs) || assessedAtMs < 0) {
      throw new TypeError("clock must return a non-negative safe integer timestamp in milliseconds");
    }

    const signals = inputSignals.map((signal) => validateThreatSignalV1(signal));
    const seenSignalIds = new Set();
    for (const signal of signals) {
      if (signal.tenantId !== policy.tenantId ||
          signal.applicationId !== policy.applicationId) {
        throw new TypeError("all threat signals must belong to the configured tenant and application");
      }
      if (seenSignalIds.has(signal.signalId)) {
        throw new TypeError("duplicate threat signal IDs are not allowed");
      }
      seenSignalIds.add(signal.signalId);
    }

    // Signals without a pseudonymous subject cannot safely be correlated to an actor.
    const identifiedSignals = signals.filter((signal) =>
      typeof signal.subjectKey === "string" && typeof signal.subjectKeyId === "string"
    );
    if (identifiedSignals.length === 0) return null;

    const subjectKey = identifiedSignals[0].subjectKey;
    const subjectKeyId = identifiedSignals[0].subjectKeyId;
    if (identifiedSignals.some((signal) =>
      signal.subjectKey !== subjectKey || signal.subjectKeyId !== subjectKeyId
    )) {
      throw new TypeError("signals from different pseudonymous subjects cannot be combined");
    }

    const cutoff = assessedAtMs - policy.windowMs;
    const eligible = identifiedSignals
      .filter((signal) =>
        signal.detectedAtMs <= assessedAtMs &&
        signal.detectedAtMs >= cutoff &&
        signal.confidence >= policy.minimumConfidence
      )
      .sort((left, right) =>
        right.detectedAtMs - left.detectedAtMs ||
        compareStrings(left.signalId, right.signalId)
      )
      .slice(0, policy.maxSignals);

    if (eligible.length === 0) return null;

    // A rule contributes at most once; repeated samples cannot inflate its weight.
    const strongestContributionByRule = new Map();
    for (const signal of eligible) {
      const contribution = signalContribution(signal, policy);
      const previous = strongestContributionByRule.get(signal.ruleId) ?? 0;
      if (contribution > previous) {
        strongestContributionByRule.set(signal.ruleId, contribution);
      }
    }
    const riskScore = Math.min(
      100,
      [...strongestContributionByRule.values()].reduce((sum, value) => sum + value, 0)
    );

    const blockEvidence = eligible.filter((signal) =>
      signal.confidence >= policy.blockRequirements.minimumConfidence
    );
    const distinctBlockRules = new Set(blockEvidence.map((signal) => signal.ruleId));
    const distinctBlockTypes = new Set(blockEvidence.map((signal) => signal.type));
    const blockQualified =
      riskScore >= policy.thresholds.block &&
      blockEvidence.length >= policy.blockRequirements.minSignals &&
      distinctBlockRules.size >= policy.blockRequirements.minDistinctRules &&
      distinctBlockTypes.size >= policy.blockRequirements.minDistinctTypes;

    let decision = "observe";
    if (blockQualified) decision = "block";
    else if (riskScore >= policy.thresholds.review) decision = "review";
    else if (riskScore >= policy.thresholds.challenge) decision = "challenge";

    const orderedSignalIds = [...eligible]
      .sort((left, right) =>
        left.detectedAtMs - right.detectedAtMs ||
        compareStrings(left.signalId, right.signalId)
      )
      .map((signal) => signal.signalId);

    return validateThreatAssessmentV1({
      schema: "jb.security.threat-assessment/v1",
      assessmentId: idGenerator(),
      tenantId: policy.tenantId,
      applicationId: policy.applicationId,
      assessedAtMs,
      riskScore,
      decision,
      signalIds: orderedSignalIds,
      policyId: policy.id
    });
  }

  return Object.freeze({
    assess,
    getPolicy: () => policy
  });
}
