import { normalizeLocale } from "./locale.js";
import { summarizeNativeAcceptanceFeedback } from "./native-acceptance.js";

const REGISTERS = new Set(["neutral", "formal", "informal"]);
const CONTEXTS = new Set([
  "general", "button", "navigation", "field-label", "validation", "error",
  "success", "notification", "help", "onboarding", "marketing", "legal", "transactional"
]);

function requiredString(value, name, max = 10000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(name + " must be a non-empty string within the supported length");
  }
  return value;
}

function safeRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(name + " must be an object");
  }
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
  const from = normalizeLocale(sourceLocale);
  const to = normalizeLocale(targetLocale);
  if (!from || !to || from === to) throw new TypeError("supported different sourceLocale and targetLocale are required");
  if (!CONTEXTS.has(context)) throw new TypeError("context is not supported");
  if (!REGISTERS.has(intendedRegister)) throw new TypeError("intendedRegister must be neutral, formal, or informal");
  return Object.freeze({ source, sourceLocale: from, targetLocale: to, context, intendedRegister });
}

function validateTermList(terms = []) {
  if (!Array.isArray(terms)) throw new TypeError("requiredTerms must be an array");
  const normalized = terms.map(term => requiredString(term, "required term", 500));
  return [...new Set(normalized)];
}

/** Create an immutable translation candidate bound to source, locale, context and register. */
export function recordTranslationVariant({
  source,
  sourceLocale,
  targetLocale,
  context = "general",
  intendedRegister = "neutral",
  variantId,
  text,
  author = "anonymous",
  note = ""
} = {}) {
  const identity = normalizeIdentity({ source, sourceLocale, targetLocale, context, intendedRegister });
  requiredString(variantId, "variantId", 120);
  requiredString(text, "text");
  requiredString(author, "author", 80);
  if (typeof note !== "string" || note.length > 500) throw new TypeError("note must be a string up to 500 characters");
  return Object.freeze({
    ...identity,
    variantId: variantId.trim(),
    text,
    author: author.trim(),
    note,
    createdAt: new Date().toISOString()
  });
}

function checkVariant(variant, identity) {
  safeRecord(variant, "variant");
  for (const field of ["source", "sourceLocale", "targetLocale", "context", "intendedRegister", "variantId", "text"]) {
    if (typeof variant[field] !== "string") throw new TypeError("variant missing valid " + field);
  }
  const vIdentity = normalizeIdentity(variant);
  if (vIdentity.source !== identity.source ||
      vIdentity.sourceLocale !== identity.sourceLocale ||
      vIdentity.targetLocale !== identity.targetLocale ||
      vIdentity.context !== identity.context ||
      vIdentity.intendedRegister !== identity.intendedRegister) {
    throw new TypeError("variant identity does not match the comparison scope");
  }
  requiredString(variant.variantId, "variantId", 120);
  requiredString(variant.text, "text");
}

/**
 * Compare alternatives for the exact same source/locale/context/register.
 * Human ratings are preferred; automatic indicators remain low-confidence.
 * This function ranks candidates but never approves or rewrites them.
 */
export function compareTranslationVariants({
  source,
  sourceLocale,
  targetLocale,
  context = "general",
  intendedRegister = "neutral",
  variants = [],
  requiredTerms = [],
  feedbackRecords = []
} = {}) {
  const identity = normalizeIdentity({ source, sourceLocale, targetLocale, context, intendedRegister });
  if (!Array.isArray(variants) || variants.length < 2 || variants.length > 50) {
    throw new RangeError("comparison requires between 2 and 50 variants");
  }
  if (!Array.isArray(feedbackRecords)) throw new TypeError("feedbackRecords must be an array");
  const terms = validateTermList(requiredTerms);
  const ids = new Set();
  for (const variant of variants) {
    checkVariant(variant, identity);
    if (ids.has(variant.variantId)) throw new TypeError("variantId values must be unique");
    ids.add(variant.variantId);
  }

  const evaluations = variants.map(variant => {
    const feedback = summarizeNativeAcceptanceFeedback(feedbackRecords, {
      source: identity.source,
      target: variant.text,
      sourceLocale: identity.sourceLocale,
      targetLocale: identity.targetLocale,
      context: identity.context
    });
    const termMatches = terms.filter(term => variant.text.toLocaleLowerCase(identity.targetLocale).includes(term.toLocaleLowerCase(identity.targetLocale)));
    const terminologyCoverage = terms.length ? termMatches.length / terms.length : null;
    const humanAcceptanceScore = feedback.count >= feedback.minimumSampleSize
      ? feedback.averageRating / 5
      : null;
    const humanAcceptanceRate = feedback.count >= feedback.minimumSampleSize
      ? feedback.acceptanceRate / 100
      : null;
    // Without enough target-locale reviewers, do not pretend to measure naturalness or context fit.
    const score = humanAcceptanceScore === null
      ? null
      : Number((humanAcceptanceScore * 0.7 + (terminologyCoverage === null ? 0.3 : terminologyCoverage * 0.3)).toFixed(4));
    return Object.freeze({
      variantId: variant.variantId,
      text: variant.text,
      note: variant.note ?? "",
      terminology: Object.freeze({
        requiredCount: terms.length,
        matchedCount: termMatches.length,
        matchedTerms: Object.freeze(termMatches),
        coverage: terminologyCoverage
      }),
      nativeAcceptance: feedback,
      comparativeScore: score,
      scoreBasis: score === null
        ? "insufficient-human-feedback"
        : terminologyCoverage === null
          ? "human-native-acceptance"
          : "human-native-acceptance-and-terminology",
      advisory: true
    });
  });

  const ranked = [...evaluations].sort((a, b) => {
    if (a.comparativeScore === null && b.comparativeScore === null) return a.variantId.localeCompare(b.variantId);
    if (a.comparativeScore === null) return 1;
    if (b.comparativeScore === null) return -1;
    return b.comparativeScore - a.comparativeScore || a.variantId.localeCompare(b.variantId);
  }).map((item, index) => Object.freeze({ ...item, rank: index + 1 }));

  return Object.freeze({
    identity,
    variantCount: variants.length,
    requiredTerms: Object.freeze(terms),
    evaluations: Object.freeze(ranked),
    status: ranked.every(item => item.comparativeScore === null)
      ? "insufficient-human-feedback"
      : "comparative-review-available",
    recommendation: null,
    autoApproved: false,
    autoRewritten: false,
    interpretation: "Ranking is advisory. Naturalness and context adequacy require target-locale human review; terminology coverage is a mechanical signal."
  });
}
