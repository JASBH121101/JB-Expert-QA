export const TRANSLATION_REVIEW_STATES = Object.freeze([
  "pending", "partial", "review-required", "approved", "stale"
]);

export function recordTranslationReview({ state, reviewer, reviewedAt = new Date().toISOString(), note = "" }) {
  if (!TRANSLATION_REVIEW_STATES.includes(state)) throw new TypeError("Unknown translation review state: " + String(state));
  if (typeof reviewer !== "string" || !reviewer.trim()) throw new TypeError("A reviewer identity is required");
  if (state === "approved" && !reviewedAt) throw new TypeError("Approval requires a review timestamp");
  const timestamp = new Date(reviewedAt);
  if (Number.isNaN(timestamp.getTime())) throw new TypeError("reviewedAt must be a valid timestamp");
  return Object.freeze({ state, reviewer: reviewer.trim(), reviewedAt: timestamp.toISOString(), note: String(note).slice(0, 2000) });
}

export function resolveTranslationState({ missingKeys = 0, emptyValues = 0, placeholderMismatches = 0, obsoleteKeys = 0, messageShapeMismatches = 0, humanApproval = null } = {}) {
  if (humanApproval?.state === "approved" && humanApproval.reviewer && humanApproval.reviewedAt) return "approved";
  if (obsoleteKeys > 0) return "stale";
  if (missingKeys > 0) return "partial";
  if (messageShapeMismatches > 0 || placeholderMismatches > 0) return "review-required";
  if (emptyValues > 0) return "pending";
  // Structural checks do not certify meaning, tone or regional suitability.
  return "review-required";
}
