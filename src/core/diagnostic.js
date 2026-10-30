import { assertSeverity } from "./severities.js";

const REQUIRED_FIELDS = ["id", "specialist", "title", "description", "severity"];

export function createDiagnostic(input) {
  for (const field of REQUIRED_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      throw new TypeError(`Diagnostic field "${field}" is required`);
    }
  }

  assertSeverity(input.severity);

  return Object.freeze({
    id: String(input.id),
    specialist: String(input.specialist),
    title: String(input.title),
    description: String(input.description),
    severity: input.severity,
    evidence: input.evidence ?? null,
    recommendation: input.recommendation ?? null,
    location: input.location ?? null,
    ruleId: input.ruleId ?? null,
    status: input.status ?? "open",
    metadata: Object.freeze({ ...(input.metadata ?? {}) })
  });
}
