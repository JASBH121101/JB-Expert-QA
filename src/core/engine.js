import { snapshotPlainRecord } from "./safe-record.js";
import { snapshotPlainRecord } from "./safe-record.js";
import { createDiagnostic } from "./diagnostic.js";
import { validateEngineConfig } from "./config.js";
import { ENGINE_VERSION } from "./version.js";
import { calculateScore } from "./scoring.js";
import { redactSensitiveText } from "./redaction.js";

export class ExpertQAEngine {
  constructor(options = {}) {
    const safeOptions = snapshotPlainRecord(options, "engine options");
    const registry = safeOptions.registry;
    const config = safeOptions.config ?? {};
    if (!registry || typeof registry.list !== "function") {
      throw new TypeError("A valid rule registry is required");
    }
    this.registry = registry;
    this.config = validateEngineConfig(config);
  }

  async audit(context = {}, options = {}) {
    const safeOptions = snapshotPlainRecord(options, "audit options");
    const specialist = safeOptions.specialist;
    if (specialist !== undefined &&
        (typeof specialist !== "string" || !specialist.trim())) {
      throw new TypeError("options.specialist must be a non-empty specialist id");
    }

    const rules = this.registry.list(
      specialist ? { specialist } : {}
    );
    const diagnostics = [];
    const execution = [];

    for (const rule of rules) {
      const startedAt = Date.now();
      try {
        const controller = new AbortController();
        let timeoutHandle;
        const timeoutMs = this.config.execution.ruleTimeoutMs;
        const timeout = new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(new Error("Rule evaluation timed out after " + timeoutMs + " ms"));
          }, timeoutMs);
        });
        let result;
        try {
          result = await Promise.race([
            Promise.resolve().then(() => rule.evaluate(context, { signal: controller.signal })),
            timeout
          ]);
        } finally {
          clearTimeout(timeoutHandle);
        }
        const findings = result == null ? [] : Array.isArray(result) ? result : [result];

        for (const finding of findings) {
          if (finding) {
            const safeFinding = snapshotPlainRecord(finding, "rule finding");
            diagnostics.push(createDiagnostic({
              ...safeFinding,
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
          error: redactSensitiveText(error instanceof Error ? error.message : String(error))
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
      execution: Object.freeze(execution.map((entry) => Object.freeze(entry)))
    });
  }
}
