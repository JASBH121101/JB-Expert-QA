import { snapshotPlainRecord } from "./safe-record.js";
import { assertSeverity } from "./severities.js";

const REQUIRED_FIELDS = ["id", "specialist", "title", "description", "severity"];

export function createDiagnostic(input) {
  const safeInput = snapshotPlainRecord(input, "diagnostic");
  for (const field of REQUIRED_FIELDS) {
    if (typeof safeInput[field] !== "string" || safeInput[field] === "") {
      throw new TypeError(`Diagnostic field "${field}" is required`);
    }
  }

  assertSeverity(safeInput.severity);

  return Object.freeze({
    id: safeInput.id,
    specialist: safeInput.specialist,
    title: safeInput.title,
    description: safeInput.description,
    severity: safeInput.severity,
    evidence: safeInput.evidence ?? null,
    recommendation: safeInput.recommendation ?? null,
    location: safeInput.location ?? null,
    ruleId: safeInput.ruleId ?? null,
    status: safeInput.status ?? "open",
    metadata: Object.freeze(snapshotPlainRecord(safeInput.metadata ?? {}, "diagnostic.metadata"))
  });
}
