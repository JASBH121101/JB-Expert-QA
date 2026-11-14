import { createEvidenceRecord } from "../core/evidence.js";
import { assessSource } from "./source-policy.js";

export function createResearchCandidate(input, { now = new Date().toISOString() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Research candidate input must be an object");
  }
  const evidence = createEvidenceRecord(input);
  if (!evidence.source) throw new TypeError("Research candidates require a source");
  const assessment = assessSource({
    domain: evidence.domain,
    field: evidence.field,
    sourceType: evidence.source.type,
    observedAt: evidence.observedAt,
    now,
  });
  return Object.freeze({
    candidateId: `candidate:${evidence.id}`,
    evidence,
    assessment,
    decision: "pending_review",
    changesVerifiedData: false,
  });
}
