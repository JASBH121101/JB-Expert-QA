import { normalizeLocale } from "./locale.js";
import { createHash } from "node:crypto";

function stableAcceptanceHash(value) {
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function resolveAcceptanceIdentity({
  source,
  target,
  sourceLocale,
  targetLocale,
  context = ""
} = {}) {
  if (typeof source !== "string" || !source.trim() ||
      typeof target !== "string" || !target.trim()) {
    throw new TypeError("Acceptance summary requires non-empty source and target text");
  }
  const from = normalizeLocale(sourceLocale);
  const to = normalizeLocale(targetLocale);
  if (!from || !to || from === to) {
    throw new TypeError("Acceptance summary requires supported, different locales");
  }
  if (typeof context !== "string") throw new TypeError("context must be a string");

  return {
    sourceHash: stableAcceptanceHash({ locale: from, context, text: source }),
    targetHash: stableAcceptanceHash({ locale: to, context, text: target }),
    sourceLocale: from,
    targetLocale: to,
    context
  };
}

const ACCEPTANCE_THRESHOLD = 4;
const MIN_SAMPLE_SIZE = 5;

/**
 * Review-driven acceptance feedback, bound to exact source/target content,
 * locale pair and context. Scores are reviewer feedback, not an AI claim
 * of native fluency.
 */
export function recordNativeAcceptanceFeedback({
  source,
  target,
  sourceLocale,
  targetLocale,
  context = "",
  rating,
  reviewer = "anonymous"
} = {}) {
  const identity = resolveAcceptanceIdentity({
    source, target, sourceLocale, targetLocale, context
  });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new RangeError("rating must be an integer from 1 to 5");
  }
  if (typeof reviewer !== "string" || !reviewer.trim() || reviewer.length > 80) {
    throw new TypeError("reviewer must be a non-empty label of at most 80 characters");
  }

  return Object.freeze({
    ...identity,
    rating,
    reviewer: reviewer.trim(),
    accepted: rating >= ACCEPTANCE_THRESHOLD,
    recordedAt: new Date().toISOString()
  });
}

/**
 * Summarize only feedback whose complete content/locale/context fingerprint
 * matches the supplied translation identity. Unmatched records are excluded.
 */
export function summarizeNativeAcceptanceFeedback(records = [], identity = {}) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const hasIdentity = identity &&
    typeof identity === "object" &&
    !Array.isArray(identity) &&
    typeof identity.source === "string" &&
    typeof identity.target === "string" &&
    typeof identity.sourceLocale === "string" &&
    typeof identity.targetLocale === "string";
  if (records.length > 0 && !hasIdentity) {
    throw new TypeError("A translation identity is required to summarize feedback");
  }

  const expected = records.length ? resolveAcceptanceIdentity(identity) : null;
  const valid = expected
    ? records.filter(record =>
      record &&
      Number.isInteger(record.rating) &&
      record.rating >= 1 &&
      record.rating <= 5 &&
      record.sourceHash === expected.sourceHash &&
      record.targetHash === expected.targetHash &&
      record.sourceLocale === expected.sourceLocale &&
      record.targetLocale === expected.targetLocale &&
      record.context === expected.context
    )
    : [];
  const count = valid.length;
  const averageRating = count
    ? Number((valid.reduce((sum, item) => sum + item.rating, 0) / count).toFixed(2))
    : null;
  const acceptedCount = valid.filter(item => item.rating >= ACCEPTANCE_THRESHOLD).length;
  const acceptanceRate = count
    ? Number((acceptedCount / count * 100).toFixed(1))
    : null;
  const status = count < MIN_SAMPLE_SIZE
    ? "insufficient-feedback"
    : acceptanceRate >= 80
      ? "high-acceptance"
      : acceptanceRate >= 60
        ? "mixed-acceptance"
        : "needs-revision";

  return Object.freeze({
    count,
    ignoredCount: records.length - count,
    averageRating,
    acceptedCount,
    acceptanceRate,
    threshold: ACCEPTANCE_THRESHOLD,
    minimumSampleSize: MIN_SAMPLE_SIZE,
    status,
    interpretation: count < MIN_SAMPLE_SIZE
      ? "Collect at least five matching reviews from target-locale users before interpreting acceptance."
      : status === "high-acceptance"
        ? "Feedback indicates strong acceptance for this exact translation and context; it is not a native-fluency certification."
        : status === "mixed-acceptance"
          ? "Feedback is mixed; revise and test alternatives with target-locale users."
          : "Feedback indicates the translation should be revised and re-tested."
  });
}

/**
 * Provides conservative non-review signals for text that may undermine
 * acceptance. These signals never auto-rewrite or auto-approve translations.
 */
export function auditNativeAcceptanceSignals(targetMap, { targetLocale } = {}) {
  const locale = normalizeLocale(targetLocale);
  if (!locale) throw new TypeError("A supported target locale is required");
  if (!targetMap || typeof targetMap !== "object" || Array.isArray(targetMap)) {
    throw new TypeError("targetMap must be a plain flattened translation map");
  }
  const proto = Object.getPrototypeOf(targetMap);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("targetMap must be a plain flattened translation map");
  }
  if (Object.getOwnPropertySymbols(targetMap).length) {
    throw new TypeError("targetMap must not contain symbol keys");
  }

  const descriptors = Object.getOwnPropertyDescriptors(targetMap);
  const findings = [];
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError("targetMap must not contain accessor properties");
    }
    if (typeof descriptor.value !== "string") continue;

    const text = descriptor.value;
    if (/\s{2,}/u.test(text) || /\s+[,.!?;:]/u.test(text)) {
      findings.push(Object.freeze({
        id: "copy-format-naturalness",
        key,
        severity: "low",
        confidence: "mechanical-signal",
        message: "Spacing or punctuation may reduce reading naturalness; verify the text."
      }));
    }
    if (locale.startsWith("es") && /\b(?:clickear|clickea|loguearse|logearse)\b/iu.test(text)) {
      findings.push(Object.freeze({
        id: "copy-acceptance-terminology",
        key,
        severity: "low",
        confidence: "review-signal",
        message: "This wording may be less preferred in the selected Spanish locale or product context; consider a target-user review."
      }));
    }
    if (locale.startsWith("en") && /\b(?:please kindly|do the needful)\b/iu.test(text)) {
      findings.push(Object.freeze({
        id: "copy-acceptance-idiom",
        key,
        severity: "low",
        confidence: "review-signal",
        message: "This phrase may sound non-native or overly formal in some English contexts; review audience and tone."
      }));
    }
  }
  return Object.freeze(findings);
}
