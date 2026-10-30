import { createDiagnostic } from "./diagnostic.js";
import { calculateScore } from "./scoring.js";

export class ExpertQAEngine {
  constructor({ registry, config }) {
    if (!registry || typeof registry.list !== "function") {
      throw new TypeError("A valid rule registry is required");
    }
    this.registry = registry;
    this.config = config ?? {};
  }

  async audit(context = {}, options = {}) {
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
              ruleId: rule.id,
              specialist: rule.specialist,
              ...finding
            }));
          }
        }

        execution.push({ ruleId: rule.id, status: "passed", durationMs: Date.now() - startedAt });
      } catch (error) {
        execution.push({
          ruleId: rule.id,
          status: "error",
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const scoring = calculateScore(diagnostics, {
      weights: this.config.weights,
      severityPenalties: this.config.severityPenalties,
      minimumScore: this.config.thresholds?.minimumScore ?? 80,
      failOnCritical: this.config.thresholds?.failOnCritical ?? true
    });

    return Object.freeze({
      engine: "JB Expert QA",
      version: "0.1.0",
      generatedAt: new Date().toISOString(),
      profile: this.config.profile ?? "custom",
      summary: Object.freeze({
        rulesExecuted: execution.length,
        rulesWithErrors: execution.filter((item) => item.status === "error").length,
        findings: diagnostics.length
      }),
      scoring,
      diagnostics: Object.freeze(diagnostics),
      execution: Object.freeze(execution)
    });
  }
}
