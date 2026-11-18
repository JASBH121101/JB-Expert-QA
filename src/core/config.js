import { DEFAULT_SEVERITY_PENALTIES, SEVERITIES } from "./severities.js";
import { isValidSpecialistId } from "./rule-registry.js";
import { snapshotPlainRecord } from "./safe-record.js";

export function validateEngineConfig(input = {}) {
  const suppliedConfig = snapshotPlainRecord(input, "Engine config");
  const weights = snapshotPlainRecord(suppliedConfig.weights ?? {}, "config.weights");
  for (const [specialist, weight] of Object.entries(weights)) {
    if (!isValidSpecialistId(specialist)) {
      throw new TypeError("Invalid specialist id in config.weights: \"" + specialist + "\"");
    }
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
      throw new TypeError("Weight for specialist \"" + specialist + "\" must be a non-negative finite number");
    }
  }

  const suppliedPenalties = snapshotPlainRecord(
    suppliedConfig.severityPenalties ?? {}, "config.severityPenalties"
  );
  for (const [severity, penalty] of Object.entries(suppliedPenalties)) {
    if (!SEVERITIES.includes(severity)) {
      throw new TypeError("Unknown severity penalty: \"" + severity + "\"");
    }
    if (typeof penalty !== "number" || !Number.isFinite(penalty) || penalty < 0) {
      throw new TypeError("Penalty for severity \"" + severity + "\" must be a non-negative finite number");
    }
  }

  const thresholds = snapshotPlainRecord(
    suppliedConfig.thresholds ?? {}, "config.thresholds"
  );
  const minimumScore = thresholds.minimumScore ?? 80;
  if (typeof minimumScore !== "number" || !Number.isFinite(minimumScore) ||
      minimumScore < 0 || minimumScore > 100) {
    throw new TypeError("config.thresholds.minimumScore must be between 0 and 100");
  }
  const failOnCritical = thresholds.failOnCritical ?? true;
  if (typeof failOnCritical !== "boolean") {
    throw new TypeError("config.thresholds.failOnCritical must be a boolean");
  }

  const scan = snapshotPlainRecord(suppliedConfig.scan ?? {}, "config.scan");
  const scanDefaults = {
    maxFiles: 2500,
    maxFileBytes: 1_000_000,
    maxTotalBytes: 20_000_000,
    maxDepth: 20
  };
  for (const [name, value] of Object.entries(scan)) {
    if (!Object.hasOwn(scanDefaults, name)) {
      throw new TypeError("Unknown project scan option: \"" + name + "\"");
    }
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError("config.scan." + name + " must be a positive integer");
    }
  }

  const suppliedAdvisories = snapshotPlainRecord(
    suppliedConfig.advisories ?? {}, "config.advisories"
  );
  const advisoryDefaults = {
    enabled: false,
    required: false,
    provider: "osv",
    maxPackages: 1000,
    batchSize: 100,
    maxVulnerabilities: 200,
    timeoutMs: 8000
  };
  for (const [name, value] of Object.entries(suppliedAdvisories)) {
    if (!Object.hasOwn(advisoryDefaults, name)) {
      throw new TypeError("Unknown advisory option: \"" + name + "\"");
    }
    if (["enabled", "required"].includes(name) && typeof value !== "boolean") {
      throw new TypeError("config.advisories." + name + " must be a boolean");
    }
    if (name === "provider" && value !== "osv") {
      throw new TypeError("config.advisories.provider must be \"osv\"");
    }
    if (["maxPackages", "batchSize", "maxVulnerabilities", "timeoutMs"].includes(name)) {
      if (!Number.isInteger(value) || value < 1) {
        throw new TypeError("config.advisories." + name + " must be a positive integer");
      }
      const upperBounds = { maxPackages: 5000, batchSize: 100, maxVulnerabilities: 1000, timeoutMs: 30000 };
      if (value > upperBounds[name]) {
        throw new TypeError("config.advisories." + name + " exceeds the safety limit of " + upperBounds[name]);
      }
    }
  }
  const advisories = { ...advisoryDefaults, ...suppliedAdvisories };

  const suppliedExecution = snapshotPlainRecord(
    suppliedConfig.execution ?? {}, "config.execution"
  );
  const executionDefaults = { ruleTimeoutMs: 15000 };
  for (const [name, value] of Object.entries(suppliedExecution)) {
    if (!Object.hasOwn(executionDefaults, name)) {
      throw new TypeError("Unknown execution option: \"" + name + "\"");
    }
    if (!Number.isInteger(value) || value < 1 || value > 120000) {
      throw new TypeError("config.execution." + name + " must be an integer between 1 and 120000");
    }
  }
  const execution = { ...executionDefaults, ...suppliedExecution };

  const profile = suppliedConfig.profile ?? "custom";
  if (typeof profile !== "string" || !profile.trim()) {
    throw new TypeError("config.profile must be a non-empty string");
  }

  return Object.freeze({
    ...suppliedConfig,
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
    }),
    scan: Object.freeze({ ...scanDefaults, ...scan }),
    advisories: Object.freeze(advisories),
    execution: Object.freeze(execution)
  });
}
