import { createDiagnostic } from "./diagnostic.js";
import { validateEngineConfig } from "./config.js";
import { ENGINE_VERSION } from "./version.js";
import { calculateScore } from "./scoring.js";

export class ExpertQAEngine {
  constructor({ registry, config = {} } = {}) {
    if (!registry || typeof registry.list !== "function") {
      throw new TypeError("A valid rule registry is required");
    }
    this.registry = registry;
    this.config = validateEngineConfig(config);
  }

  async audit(context = {}, options = {}) {
    if (options.specialist !== undefined &&
        (typeof options.specialist !== "string" || !options.specialist.trim())) {
      throw new TypeError("options.specialist must be a non-empty specialist id");
    }

    const availableRules = this.registry.list(
      options.specialist ? { specialist: options.specialist } : {}
    );
    let rules = availableRules;
    if (options.ruleIds !== undefined) {
      if (!Array.isArray(options.ruleIds) || options.ruleIds.length === 0 ||
          options.ruleIds.some((id) => typeof id !== "string" || !id.trim()) ||
          new Set(options.ruleIds).size !== options.ruleIds.length) {
        throw new TypeError("options.ruleIds must be a non-empty array of unique rule IDs");
      }
      const requestedIds = new Set(options.ruleIds);
      const knownIds = new Set(availableRules.map((rule) => rule.id));
      const unknownIds = options.ruleIds.filter((id) => !knownIds.has(id));
      if (unknownIds.length) {
        throw new TypeError("Unknown rule ID(s) for this audit selection: " + unknownIds.join(", "));
      }
      rules = availableRules.filter((rule) => requestedIds.has(rule.id));
    }
    const diagnostics = [];
    const execution = [];

    for (const rule of rules) {
      const startedAt = Date.now();
      try {
        const result = await rule.evaluate(context);
        const findings = result == null ? [] : Array.isArray(result) ? result : [result];

        for (const finding of findings) {
          if (finding) {
            diagnostics.push(createDiagnostic({
              ...finding,
              ruleId: rule.id,
              specialist: rule.specialist
            }));
          }
        }

        execution.push({
          ruleId: rule.id,
          specialist: rule.specialist,
          status: "passed",
          durationMs: Date.now() - startedAt
        });
      } catch (error) {
        execution.push({
          ruleId: rule.id,
          specialist: rule.specialist,
          status: "error",
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const includedSpecialists = [...new Set(rules.map((rule) => rule.specialist))];
    const scoring = calculateScore(diagnostics, {
      weights: this.config.weights,
      severityPenalties: this.config.severityPenalties,
      minimumScore: this.config.thresholds.minimumScore,
      failOnCritical: this.config.thresholds.failOnCritical,
      includedSpecialists,
      executionErrors: execution.filter((item) => item.status === "error").length
    });

    return Object.freeze({
      engine: "JB Expert QA",
      version: ENGINE_VERSION,
      generatedAt: new Date().toISOString(),
      profile: this.config.profile,
      summary: Object.freeze({
        rulesExecuted: execution.length,
        rulesWithErrors: execution.filter((item) => item.status === "error").length,
        findings: diagnostics.length,
        specialists: Object.freeze(includedSpecialists),
        selection: options.ruleIds === undefined
          ? Object.freeze({ type: options.specialist ? "specialist" : "full", specialist: options.specialist ?? null })
          : Object.freeze({ type: "targeted-rules", ruleIds: Object.freeze(rules.map((rule) => rule.id)) })
      }),
      scoring,
      diagnostics: Object.freeze(diagnostics),
      execution: Object.freeze(execution)
    });
  }
}
