export const TRANSLATION_REVIEW_STATES = Object.freeze([
  "pending", "partial", "review-required", "approved", "stale"
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function isValidReviewTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function hasBoundApproval(humanApproval, sourceHash, targetHash) {
  if (humanApproval === null || typeof humanApproval !== "object" || Array.isArray(humanApproval)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(humanApproval);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(humanApproval).length > 0) return false;

  const descriptors = Object.getOwnPropertyDescriptors(humanApproval);
  const valueOf = (key) => {
    const descriptor = descriptors[key];
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  };
  const state = valueOf("state");
  const reviewer = valueOf("reviewer");
  const reviewedAt = valueOf("reviewedAt");
  const reviewedSourceHash = valueOf("sourceHash");
  const reviewedTargetHash = valueOf("targetHash");

  return state === "approved" &&
    typeof reviewer === "string" &&
    Boolean(reviewer.trim()) &&
    isValidReviewTimestamp(reviewedAt) &&
    SHA256_PATTERN.test(sourceHash ?? "") &&
    SHA256_PATTERN.test(targetHash ?? "") &&
    reviewedSourceHash === sourceHash &&
    reviewedTargetHash === targetHash;
}

export function recordTranslationReview({
  state,
  reviewer,
  reviewedAt = new Date().toISOString(),
  note = "",
  sourceHash = null,
  targetHash = null
}) {
  if (!TRANSLATION_REVIEW_STATES.includes(state)) {
    throw new TypeError("Unknown translation review state: " + String(state));
  }
  if (typeof reviewer !== "string" || !reviewer.trim()) {
    throw new TypeError("A reviewer identity is required");
  }
  if ((sourceHash !== null || targetHash !== null) &&
      (!SHA256_PATTERN.test(sourceHash ?? "") || !SHA256_PATTERN.test(targetHash ?? ""))) {
    throw new TypeError("Review content binding requires valid sourceHash and targetHash SHA-256 fingerprints");
  }
  if (state === "approved" &&
      (!isValidReviewTimestamp(reviewedAt) || !sourceHash || !targetHash)) {
    throw new TypeError("Approval requires a valid timestamp and sourceHash/targetHash content binding");
  }
  if (!isValidReviewTimestamp(reviewedAt)) {
    throw new TypeError("reviewedAt must be a valid timestamp");
  }
  return Object.freeze({
    state,
    reviewer: reviewer.trim(),
    reviewedAt: new Date(reviewedAt).toISOString(),
    note: String(note).slice(0, 2000),
    sourceHash,
    targetHash
  });
}

export function resolveTranslationState({
  missingKeys = 0,
  emptyValues = 0,
  placeholderMismatches = 0,
  obsoleteKeys = 0,
  messageShapeMismatches = 0,
  humanApproval = null,
  sourceHash = null,
  targetHash = null
} = {}) {
  // Objective integrity failures always take precedence over human approval.
  if (obsoleteKeys > 0) return "stale";
  if (missingKeys > 0) return "partial";
  if (messageShapeMismatches > 0 || placeholderMismatches > 0) return "review-required";
  if (emptyValues > 0) return "pending";

  // An approval is valid only for the exact source and target content reviewed.
  if (hasBoundApproval(humanApproval, sourceHash, targetHash)) return "approved";

  // Structural success alone cannot certify linguistic quality or current human approval.
  return "review-required";
}
