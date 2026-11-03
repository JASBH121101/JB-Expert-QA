import { DEFAULT_SEVERITY_PENALTIES, SEVERITIES } from "./severities.js";
import { isValidSpecialistId } from "./rule-registry.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateEngineConfig(input = {}) {
  if (!isRecord(input)) {
    throw new TypeError("Engine config must be an object");
  }

  const weights = input.weights ?? {};
  if (!isRecord(weights)) {
    throw new TypeError("config.weights must be an object");
  }
  for (const [specialist, weight] of Object.entries(weights)) {
    if (!isValidSpecialistId(specialist)) {
      throw new TypeError("Invalid specialist id in config.weights: \"" + specialist + "\"");
    }
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
      throw new TypeError("Weight for specialist \"" + specialist + "\" must be a non-negative finite number");
    }
  }

  const suppliedPenalties = input.severityPenalties ?? {};
  if (!isRecord(suppliedPenalties)) {
    throw new TypeError("config.severityPenalties must be an object");
  }
  for (const [severity, penalty] of Object.entries(suppliedPenalties)) {
    if (!SEVERITIES.includes(severity)) {
      throw new TypeError("Unknown severity penalty: \"" + severity + "\"");
    }
    if (typeof penalty !== "number" || !Number.isFinite(penalty) || penalty < 0) {
      throw new TypeError("Penalty for severity \"" + severity + "\" must be a non-negative finite number");
    }
  }

  const thresholds = input.thresholds ?? {};
  if (!isRecord(thresholds)) {
    throw new TypeError("config.thresholds must be an object");
  }
  const minimumScore = thresholds.minimumScore ?? 80;
  if (typeof minimumScore !== "number" || !Number.isFinite(minimumScore) ||
      minimumScore < 0 || minimumScore > 100) {
    throw new TypeError("config.thresholds.minimumScore must be between 0 and 100");
  }
  const failOnCritical = thresholds.failOnCritical ?? true;
  if (typeof failOnCritical !== "boolean") {
    throw new TypeError("config.thresholds.failOnCritical must be a boolean");
  }

  const profile = input.profile ?? "custom";
  if (typeof profile !== "string" || !profile.trim()) {
    throw new TypeError("config.profile must be a non-empty string");
  }

  return Object.freeze({
    ...input,
    profile,
    weights: Object.freeze({ ...weights }),
    severityPenalties: Object.freeze({
      ...DEFAULT_SEVERITY_PENALTIES,
      ...suppliedPenalties
    }),
    thresholds: Object.freeze({
      ...thresholds,
      minimumScore,
      failOnCritical
    })
  });
}
