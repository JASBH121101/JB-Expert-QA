import { createHash } from "node:crypto";
import { comparePlaceholders } from "./placeholders.js";
import { LanguageLibrary } from "./glossary.js";
import { resolveTranslationState } from "./review.js";

export function flattenTranslationMap(value, prefix = "", output = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? prefix + "." + key : key;
    if (typeof item === "string") output[path] = item;
    else if (item && typeof item === "object" && !Array.isArray(item)) flattenTranslationMap(item, path, output);
  }
  return output;
}

export function stableTranslationHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function auditTranslationMaps(sourceMap, targetMap, { sourceLocale = "es-419", targetLocale = "en", library = new LanguageLibrary(), humanApproval = null } = {}) {
  const source = flattenTranslationMap(sourceMap);
  const target = flattenTranslationMap(targetMap);
  const findings = [];
  let missingKeys = 0, emptyValues = 0, placeholderMismatches = 0, obsoleteKeys = 0;

  for (const key of Object.keys(source).sort()) {
    if (!Object.hasOwn(target, key)) {
      missingKeys++;
      findings.push({ id: "missing-key", key, severity: "high", message: "Translation key is missing from target locale." });
      continue;
    }
    if (!target[key].trim()) {
      emptyValues++;
      findings.push({ id: "empty-value", key, severity: "medium", message: "Target translation is empty." });
      continue;
    }
    const placeholders = comparePlaceholders(source[key], target[key]);
    if (!placeholders.matches) {
      placeholderMismatches++;
      findings.push({ id: "placeholder-mismatch", key, severity: "high", message: "Source and target placeholders differ.", details: placeholders });
    }
    const termFindings = library.validateTermConsistency(source[key], target[key], { sourceLocale, targetLocale });
    for (const item of termFindings) {
      findings.push({ id: "glossary-review", key, severity: "low", message: "Approved glossary term may not be represented in the target text.", details: item, confidence: "review-only" });
    }
  }

  for (const key of Object.keys(target).sort()) {
    if (!Object.hasOwn(source, key)) {
      obsoleteKeys++;
      findings.push({ id: "obsolete-key", key, severity: "low", message: "Target locale contains a key absent from the source locale." });
    }
  }

  const state = resolveTranslationState({ missingKeys, emptyValues, placeholderMismatches, obsoleteKeys, humanApproval });
  return Object.freeze({
    status: "checked",
    sourceLocale,
    targetLocale,
    reviewStatus: state,
    counts: Object.freeze({
      sourceKeys: Object.keys(source).length,
      targetKeys: Object.keys(target).length,
      missingKeys, emptyValues, placeholderMismatches, obsoleteKeys,
      glossaryReview: findings.filter((item) => item.id === "glossary-review").length
    }),
    sourceHash: stableTranslationHash(source),
    targetHash: stableTranslationHash(target),
    findings: Object.freeze(findings)
  });
}
