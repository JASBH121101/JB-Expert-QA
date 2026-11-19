import { normalizeLocale } from "./locale.js";

const REPEATED_FUNCTION_WORDS = Object.freeze({
  en: new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "is", "are", "for", "with", "from", "by", "as"]),
  es: new Set(["de", "el", "la", "los", "las", "un", "una", "unos", "unas", "y", "o", "que", "en", "por", "para", "del", "al", "con"]),
  pt: new Set(["de", "o", "a", "os", "as", "um", "uma", "e", "ou", "que", "em", "por", "para", "do", "da", "com"]),
  fr: new Set(["de", "le", "la", "les", "un", "une", "et", "ou", "que", "en", "pour", "du", "des", "à", "avec"]),
  de: new Set(["der", "die", "das", "ein", "eine", "und", "oder", "zu", "von", "in", "mit", "für", "den", "dem"]),
  it: new Set(["di", "il", "lo", "la", "i", "gli", "le", "un", "una", "e", "o", "che", "in", "per", "con"]),
  ar: new Set(["في", "من", "على", "إلى", "عن", "و", "هذا", "هذه"])
});

const UNTRANSLATED_MARKER = /\b(?:TODO|FIXME|TRANSLATE|MISSING_TRANSLATION)\b|\[(?:translate|translation pending|missing translation)\]|\b(?:translation missing|translation pending|missing translation)\b|lorem\s+ipsum/iu;
const MOJIBAKE_MARKER = /[ÃÂ]|â(?:€|™|œ|ž|“|”|—)|ðŸ|\uFFFD/u;
const REPEATED_WORD_PATTERN = /(?<![\p{L}\p{N}])([\p{L}]{1,})\s+\1(?![\p{L}\p{N}])/giu;

function readFlatEntries(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value === Object.prototype) {
    throw new TypeError("targetMap must be a plain flattened translation map");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("targetMap must be a plain flattened translation map");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("targetMap must not contain symbol keys");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = [];
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError("targetMap must not contain accessor properties");
    }
    if (typeof descriptor.value === "string") entries.push([key, descriptor.value]);
  }
  return entries;
}

/**
 * Deterministic linguistic quality signals for translation review.
 * These are heuristics, not proof of incorrect language or automatic approval.
 */
export function auditTranslationLinguisticSignals(targetMap, { targetLocale = "es-419" } = {}) {
  const locale = normalizeLocale(targetLocale);
  if (!locale) throw new TypeError("A supported target locale is required");
  const primary = locale.split("-")[0];
  const repeatedWords = REPEATED_FUNCTION_WORDS[primary] ?? new Set();
  const findings = [];

  for (const [key, value] of readFlatEntries(targetMap)) {
    for (const match of value.matchAll(REPEATED_WORD_PATTERN)) {
      const word = match[1].toLocaleLowerCase(locale);
      if (!repeatedWords.has(word)) continue;
      findings.push(Object.freeze({
        id: "repeated-function-word",
        key,
        severity: "low",
        confidence: "review-signal",
        message: "A common function word is repeated adjacently; verify whether this is intentional.",
        details: Object.freeze({ word, locale, index: match.index })
      }));
    }
    if (UNTRANSLATED_MARKER.test(value)) {
      findings.push(Object.freeze({
        id: "untranslated-marker",
        key,
        severity: "medium",
        confidence: "review-signal",
        message: "The text contains a placeholder or marker that may indicate unfinished translation."
      }));
    }
    if (MOJIBAKE_MARKER.test(value)) {
      findings.push(Object.freeze({
        id: "mojibake",
        key,
        severity: "medium",
        confidence: "mechanical-signal",
        message: "The text contains characters commonly associated with encoding corruption."
      }));
    }
  }
  return Object.freeze(findings);
}
