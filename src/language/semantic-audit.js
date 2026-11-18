import { normalizeLocale } from "./locale.js";

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const MARKUP_PATTERN = /<\s*(\/?)\s*([A-Z][\w:-]*)\b[^>]*>/giu;
const NUMBER_PATTERN = /(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+)*(?:\s?%)?(?![\p{L}\p{N}_])/gu;

function readFlatEntries(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value === Object.prototype) {
    throw new TypeError(label + " must be a plain flattened translation map");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(label + " must be a plain flattened translation map");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(label + " must not contain symbol keys");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = [];
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " must not contain accessor properties");
    }
    if (typeof descriptor.value === "string") entries.push([key, descriptor.value]);
  }
  return entries;
}

function comparableText(value) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en");
}

function extractProtectedTokens(value) {
  const urls = value.match(URL_PATTERN) ?? [];
  const withoutUrls = value.replace(URL_PATTERN, " ");
  const emails = withoutUrls.match(EMAIL_PATTERN) ?? [];
  const withoutAddresses = withoutUrls.replace(EMAIL_PATTERN, " ");
  const markup = [...withoutAddresses.matchAll(MARKUP_PATTERN)].map((match) => {
    const closing = match[1] ? "/" : "";
    const tag = match[2].toLocaleLowerCase("en");
    const selfClosing = /\/\s*>$/u.test(match[0]) ? "/" : "";
    return closing + tag + selfClosing;
  });
  const withoutMarkup = withoutAddresses.replace(MARKUP_PATTERN, " ");
  const numbers = withoutMarkup.match(NUMBER_PATTERN) ?? [];
  return { urls, emails, markup, numbers };
}

function makeMismatch(key, id, label, sourceTokens, targetTokens, severity = "medium") {
  return Object.freeze({
    id,
    key,
    severity,
    confidence: "mechanical-signal",
    message: label,
    details: Object.freeze({
      sourceCount: sourceTokens.length,
      targetCount: targetTokens.length
    })
  });
}

/**
 * Audits already-flattened source/target string maps for deterministic signals
 * that can affect meaning or runtime integrity. Findings are review signals,
 * not proof that a translation is linguistically wrong.
 */
export function auditTranslationSemantics(sourceMap, targetMap, {
  sourceLocale = "es-419",
  targetLocale = "en",
  allowUntranslatedKeys = []
} = {}) {
  const source = normalizeLocale(sourceLocale);
  const target = normalizeLocale(targetLocale);
  if (!source || !target || source === target) {
    throw new TypeError("Semantic audit requires two different supported locales");
  }
  if (!Array.isArray(allowUntranslatedKeys) ||
      allowUntranslatedKeys.some((key) => typeof key !== "string" || !key.trim())) {
    throw new TypeError("allowUntranslatedKeys must be an array of non-empty strings");
  }
  const allowed = new Set(allowUntranslatedKeys);
  const sourceEntries = readFlatEntries(sourceMap, "sourceMap");
  const targetEntries = new Map(readFlatEntries(targetMap, "targetMap"));
  const findings = [];

  for (const [key, sourceText] of sourceEntries) {
    if (!targetEntries.has(key)) continue;
    const targetText = targetEntries.get(key);
    const sourceTokens = extractProtectedTokens(sourceText);
    const targetTokens = extractProtectedTokens(targetText);

    if (!allowed.has(key) && sourceText !== targetText &&
        comparableText(sourceText) === comparableText(targetText) &&
        [...sourceText].filter((character) => /\p{L}/u.test(character)).length >= 5) {
      findings.push(makeMismatch(
        key,
        "unchanged-source-text",
        "Source and target text are identical; confirm this is intentional for the target locale.",
        sourceText,
        targetText,
        "low"
      ));
    } else if (!allowed.has(key) && comparableText(sourceText) === comparableText(targetText) &&
        [...sourceText].filter((character) => /\p{L}/u.test(character)).length >= 5) {
      findings.push(makeMismatch(
        key,
        "unchanged-source-text",
        "Source and target text are identical; confirm this is intentional for the target locale.",
        sourceText,
        targetText,
        "low"
      ));
    }

    if (JSON.stringify(sourceTokens.urls) !== JSON.stringify(targetTokens.urls)) {
      findings.push(makeMismatch(
        key, "protected-url-mismatch",
        "URLs differ between source and target; verify that destinations were preserved.",
        sourceTokens.urls, targetTokens.urls
      ));
    }
    if (JSON.stringify(sourceTokens.emails) !== JSON.stringify(targetTokens.emails)) {
      findings.push(makeMismatch(
        key, "protected-email-mismatch",
        "Email addresses differ between source and target; verify the contact destination.",
        sourceTokens.emails, targetTokens.emails
      ));
    }
    if (JSON.stringify(sourceTokens.markup) !== JSON.stringify(targetTokens.markup)) {
      findings.push(makeMismatch(
        key, "protected-markup-mismatch",
        "HTML tag order or structure differs between source and target.",
        sourceTokens.markup, targetTokens.markup
      ));
    }
    if (JSON.stringify(sourceTokens.numbers) !== JSON.stringify(targetTokens.numbers)) {
      findings.push(makeMismatch(
        key, "protected-number-mismatch",
        "Numeric literals differ between source and target; verify the intended value and locale formatting.",
        sourceTokens.numbers, targetTokens.numbers,
        "low"
      ));
    }
  }

  return Object.freeze(findings);
}
