import { normalizeLocale } from "./locale.js";
import { summarizeNativeAcceptanceFeedback } from "./native-acceptance.js";

const REGISTERS = new Set(["neutral", "formal", "informal"]);
const CONTEXTS = new Set(["general", "button", "navigation", "field-label", "validation", "error", "success", "notification", "help", "onboarding", "marketing", "legal", "transactional"]);
const DIMENSIONS = Object.freeze(["naturalness", "contextualAdequacy", "terminologyConsistency"]);
const MIN_DIMENSION_SAMPLE = 5;

function requiredString(value, name, max = 10000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(name + " must be a non-empty string within the supported length");
  return value;
}
function safeRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(name + " must be an object");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(name + " must be a plain object");
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError(name + " must not contain symbol keys");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (!Object.hasOwn(descriptors[key], "value")) throw new TypeError(name + " must not contain accessor properties");
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new TypeError(name + " contains a prototype-sensitive key");
  }
  return value;
}
function normalizeIdentity({ source, sourceLocale, targetLocale, context = "general", intendedRegister = "neutral" } = {}) {
  requiredString(source, "source");
  const from = normalizeLocale(sourceLocale), to = normalizeLocale(targetLocale);
  if (!from || !to || from === to) throw new TypeError("supported different sourceLocale and targetLocale are required");
  if (!CONTEXTS.has(context)) throw new TypeError("context is not supported");
  if (!REGISTERS.has(intendedRegister)) throw new TypeError("intendedRegister must be neutral, formal, or informal");
  return Object.freeze({ source, sourceLocale: from, targetLocale: to, context, intendedRegister });
}
function validateTermList(terms = []) {
  if (!Array.isArray(terms)) throw new TypeError("requiredTerms must be an array");
  return [...new Set(terms.map(term => requiredString(term, "required term", 500)))];
}
function summarizeDimension(records, variantId, dimension) {
  const valid = records.filter(record => record && record.variantId === variantId && Number.isInteger(record[dimension]) && record[dimension] >= 1 && record[dimension] <= 5);
  const count = valid.length;
  const average = count ? Number((valid.reduce((sum, record) => sum + record[dimension], 0) / count).toFixed(2)) : null;
  return Object.freeze({
    count,
    minimumSampleSize: MIN_DIMENSION_SAMPLE,
    average,
    score: count >= MIN_DIMENSION_SAMPLE ? average / 5 : null,
    status: count < MIN_DIMENSION_SAMPLE ? "insufficient-feedback" : "reviewed"
  });
}
export function recordTranslationVariant({ source, sourceLocale, targetLocale, context = "general", intendedRegister = "neutral", variantId, text, author = "anonymous", note = "" } = {}) {
  const identity = normalizeIdentity({ source, sourceLocale, targetLocale, context, intendedRegister });
  requiredString(variantId, "variantId", 120);
  requiredString(text, "text");
  requiredString(author, "author", 80);
  if (typeof note !== "string" || note.length > 500) throw new TypeError("note must be a string up to 500 characters");
  return Object.freeze({ ...identity, variantId: variantId.trim(), text, author: author.trim(), note, createdAt: new Date().toISOString() });
}
function checkVariant(variant, identity) {
  safeRecord(variant, "variant");
  for (const field of ["source", "sourceLocale", "targetLocale", "context", "intendedRegister", "variantId", "text"]) {
    if (typeof variant[field] !== "string") throw new TypeError("variant missing valid " + field);
  }
  const vIdentity = normalizeIdentity(variant);
  if (vIdentity.source !== identity.source || vIdentity.sourceLocale !== identity.sourceLocale || vIdentity.targetLocale !== identity.targetLocale || vIdentity.context !== identity.context || vIdentity.intendedRegister !== identity.intendedRegister) throw new TypeError("variant identity does not match the comparison scope");
  requiredString(variant.variantId, "variantId", 120);
  requiredString(variant.text, "text");
}
/**
 * Compares alternatives scoped to identical source/locale/context/register.
 * Human naturalness, contextual adequacy, terminology consistency and native
 * acceptance are not inferred by machine; each dimension requires five ratings.
 * The output is advisory and never approves, rewrites, or selects a candidate.
 */
export function compareTranslationVariants({ source, sourceLocale, targetLocale, context = "general", intendedRegister = "neutral", variants = [], requiredTerms = [], feedbackRecords = [], dimensionFeedback = [] } = {}) {
  const identity = normalizeIdentity({ source, sourceLocale, targetLocale, context, intendedRegister });
  if (!Array.isArray(variants) || variants.length < 2 || variants.length > 50) throw new RangeError("comparison requires between 2 and 50 variants");
  if (!Array.isArray(feedbackRecords)) throw new TypeError("feedbackRecords must be an array");
  if (!Array.isArray(dimensionFeedback)) throw new TypeError("dimensionFeedback must be an array");
  const terms = validateTermList(requiredTerms), ids = new Set();
  for (const variant of variants) { checkVariant(variant, identity); if (ids.has(variant.variantId)) throw new TypeError("variantId values must be unique"); ids.add(variant.variantId); }
  const nativeReviewerKeys = new Set();
  for (const record of feedbackRecords) {
    safeRecord(record, "native acceptance feedback record");
    if (!Number.isInteger(record.rating) || record.rating < 1 || record.rating > 5) throw new RangeError("native acceptance rating must be an integer from 1 to 5");
    requiredString(record.reviewer, "native acceptance reviewer", 80);
    requiredString(record.sourceHash, "native acceptance sourceHash", 128);
    requiredString(record.targetHash, "native acceptance targetHash", 128);
    requiredString(record.sourceLocale, "native acceptance sourceLocale", 35);
    requiredString(record.targetLocale, "native acceptance targetLocale", 35);
    if (typeof record.context !== "string") throw new TypeError("native acceptance context must be a string");
    const reviewerKey = [record.sourceHash, record.targetHash, record.sourceLocale, record.targetLocale, record.context, record.reviewer.trim().toLowerCase()].join(":");
    if (nativeReviewerKeys.has(reviewerKey)) throw new TypeError("each reviewer may submit only one Native Acceptance rating per exact variant");
    nativeReviewerKeys.add(reviewerKey);
  }
  const dimensionReviewerKeys = new Set();
  for (const record of dimensionFeedback) {
    safeRecord(record, "dimensionFeedback record");
    const variant = variants.find(item => item.variantId === record.variantId);
    if (!variant) throw new TypeError("dimension feedback references an unknown variantId");
    if (record.source !== identity.source || record.target !== variant.text ||
        record.sourceLocale !== identity.sourceLocale || record.targetLocale !== identity.targetLocale ||
        record.context !== identity.context || record.intendedRegister !== identity.intendedRegister) {
      throw new TypeError("dimension feedback fingerprint does not match the exact variant and comparison scope");
    }
    requiredString(record.reviewer, "reviewer", 80);
    const reviewerKey = record.variantId + ":" + record.reviewer.trim().toLowerCase();
    if (dimensionReviewerKeys.has(reviewerKey)) throw new TypeError("each reviewer may submit only one dimension review per variant");
    dimensionReviewerKeys.add(reviewerKey);
    for (const dimension of DIMENSIONS) {
      if (!Number.isInteger(record[dimension]) || record[dimension] < 1 || record[dimension] > 5) throw new RangeError(dimension + " rating must be an integer from 1 to 5");
    }
  }
  const evaluations = variants.map(variant => {
    const nativeAcceptance = summarizeNativeAcceptanceFeedback(feedbackRecords, { source: identity.source, target: variant.text, sourceLocale: identity.sourceLocale, targetLocale: identity.targetLocale, context: identity.context });
    const dimensions = Object.fromEntries(DIMENSIONS.map(dimension => [dimension, summarizeDimension(dimensionFeedback, variant.variantId, dimension)]));
    const matchedTerms = terms.filter(term => variant.text.toLocaleLowerCase(identity.targetLocale).includes(term.toLocaleLowerCase(identity.targetLocale)));
    const terminologyCoverage = terms.length ? matchedTerms.length / terms.length : null;
    const nativeScore = nativeAcceptance.count >= nativeAcceptance.minimumSampleSize ? nativeAcceptance.averageRating / 5 : null;
    const humanDimensionsReady = DIMENSIONS.every(dimension => dimensions[dimension].score !== null);
    const ready = nativeScore !== null && humanDimensionsReady;
    // Human dimensions are 90%; mechanical terminology coverage contributes 10% only when configured.
    const humanMean = ready ? (nativeScore + DIMENSIONS.reduce((sum, dimension) => sum + dimensions[dimension].score, 0)) / 4 : null;
    const comparativeScore = ready ? Number((humanMean * (terminologyCoverage === null ? 1 : 0.9) + (terminologyCoverage === null ? 0 : terminologyCoverage * 0.1)).toFixed(4)) : null;
    return Object.freeze({
      variantId: variant.variantId, text: variant.text, note: variant.note ?? "",
      terminology: Object.freeze({ requiredCount: terms.length, matchedCount: matchedTerms.length, matchedTerms: Object.freeze(matchedTerms), coverage: terminologyCoverage }),
      nativeAcceptance, humanDimensions: Object.freeze(dimensions), comparativeScore,
      scoreBasis: ready ? (terminologyCoverage === null ? "four-human-dimensions" : "four-human-dimensions-plus-mechanical-terminology") : "insufficient-human-feedback",
      advisory: true
    });
  });
  const ranked = [...evaluations].sort((a,b) => a.comparativeScore === null && b.comparativeScore === null ? a.variantId.localeCompare(b.variantId) : a.comparativeScore === null ? 1 : b.comparativeScore === null ? -1 : b.comparativeScore-a.comparativeScore || a.variantId.localeCompare(b.variantId)).map((item,index) => Object.freeze({ ...item, rank:index+1 }));
  return Object.freeze({
    identity, variantCount:variants.length, requiredTerms:Object.freeze(terms), evaluations:Object.freeze(ranked),
    status: ranked.every(item => item.comparativeScore === null) ? "insufficient-human-feedback" : "comparative-review-available",
    recommendation:null, autoApproved:false, autoRewritten:false,
    interpretation:"Comparative scores require at least five target-locale ratings for Native Acceptance and each human dimension (naturalness, contextual adequacy, terminology consistency). Terminology coverage is mechanical and advisory. No candidate is approved or rewritten."
  });
}
