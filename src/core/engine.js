import { createRequire } from "node:module";
import { createDiagnostic } from "./diagnostic.js";
import { validateEngineConfig } from "./config.js";
import { calculateScore } from "./scoring.js";

const require = createRequire(import.meta.url);
const { version: ENGINE_VERSION } = require("../../package.json");

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

    const rules = this.registry.list(
      options.specialist ? { specialist: options.specialist } : {}
    );
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
        specialists: Object.freeze(includedSpecialists)
      }),
      scoring,
      diagnostics: Object.freeze(diagnostics),
      execution: Object.freeze(execution)
    });
  }
}
