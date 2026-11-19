import { normalizeLocale } from "./locale.js";

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const MARKUP_PATTERN = /<\s*(\/?)\s*([A-Z][\w:-]*)\b[^>]*>/giu;
const NUMBER_PATTERN = /(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+)*(?:\s?%)?(?![\p{L}\p{N}_])/gu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const MOJIBAKE_PATTERNS = Object.freeze([/Ã[\u0080-\u00BF]/u, /Â[\u0080-\u00BF]/u, /â€[™œž]/u, /ðŸ/u]);

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

const TARGET_LANGUAGE_MARKERS = Object.freeze({
  es: /\b(?:y|de|del|la|el|los|las|un|una|unos|unas|en|por|para|con|que|es|año|configuración|nuevo|nueva)\b/iu,
  en: /\b(?:the|and|or|of|to|in|for|with|from|your|you|is|are|new|year|settings|save|account)\b/iu,
  pt: /\b(?:e|de|da|do|das|dos|em|para|com|que|uma|um|novo|nova)\b/iu,
  fr: /\b(?:et|de|du|des|la|le|les|un|une|en|pour|avec|que|nouveau|nouvelle)\b/iu,
  de: /\b(?:und|der|die|das|ein|eine|einer|einem|mit|für|von|zu|ist|neue|neuer)\b/iu,
  it: /\b(?:e|di|da|del|della|il|lo|la|gli|le|un|una|in|per|con|che|nuovo|nuova)\b/iu,
  ar: /(?:\\b(?:و|في|من|على|إلى|مع|هذا|هذه|عام)\\b)/u
});

function containsTargetLanguageSignal(value, locale) {
  const language = locale.split("-")[0].toLowerCase();
  return TARGET_LANGUAGE_MARKERS[language]?.test(value) ?? false;
}

function appendEncodingFindings(key, sourceEncoding, targetEncoding, findings) {
  if (targetEncoding.replacement > sourceEncoding.replacement) {
    findings.push(Object.freeze({
      id: "corrupted-replacement-character",
      key,
      severity: "high",
      confidence: "mechanical-signal",
      message: "Target text contains an unexpected Unicode replacement character (U+FFFD), which usually indicates decoding or copy corruption.",
      details: Object.freeze({
        sourceCount: sourceEncoding.replacement,
        targetCount: targetEncoding.replacement
      })
    }));
  }
  if (targetEncoding.controls.length > sourceEncoding.controls.length) {
    findings.push(Object.freeze({
      id: "corrupted-control-character",
      key,
      severity: "medium",
      confidence: "mechanical-signal",
      message: "Target text contains unexpected non-whitespace control characters.",
      details: Object.freeze({
        sourceCodes: Object.freeze(sourceEncoding.controls),
        targetCodes: Object.freeze(targetEncoding.controls)
      })
    }));
  }
  if (!sourceEncoding.mojibake && targetEncoding.mojibake) {
    findings.push(Object.freeze({
      id: "suspicious-encoding-sequence",
      key,
      severity: "medium",
      confidence: "heuristic-signal",
      message: "Target text contains a common mojibake pattern; verify its character encoding and original source.",
      details: Object.freeze({ sourceDetected: false, targetDetected: true })
    }));
  }
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

function suspiciousUnicode(value) {
  const replacement = [...value].filter((character) => character.codePointAt(0) === 0xFFFD).length;
  const controls = [...value.matchAll(CONTROL_CHARACTER_PATTERN)].map((match) =>
    "U+" + match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")
  );
  const mojibake = MOJIBAKE_PATTERNS.some((pattern) => pattern.test(value));
  return { replacement, controls, mojibake };
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

    const sourceEncoding = suspiciousUnicode(sourceText);
    const targetEncoding = suspiciousUnicode(targetText);
    appendEncodingFindings(key, sourceEncoding, targetEncoding, findings);

    const hasEncodingDamage =
      sourceEncoding.replacement > 0 || targetEncoding.replacement > 0 ||
      sourceEncoding.controls.length > 0 || targetEncoding.controls.length > 0 ||
      sourceEncoding.mojibake || targetEncoding.mojibake;
    if (!allowed.has(key) && !hasEncodingDamage &&
        !containsTargetLanguageSignal(targetText, target) &&
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

  const sourceKeys = new Set(sourceEntries.map(([key]) => key));
  const emptyEncoding = Object.freeze({ replacement: 0, controls: [], mojibake: false });
  for (const [key, targetText] of targetEntries) {
    if (sourceKeys.has(key)) continue;
    appendEncodingFindings(key, emptyEncoding, suspiciousUnicode(targetText), findings);
  }

  return Object.freeze(findings);
}
