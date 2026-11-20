import { createHash } from "node:crypto";
import { comparePlaceholders } from "./placeholders.js";
import { LanguageLibrary } from "./glossary.js";
import { resolveTranslationState } from "./review.js";
import { auditTranslationSemantics } from "./semantic-audit.js";
import { auditTranslationLinguisticSignals } from "./linguistic-signals.js";
import { auditTranslationRegionalStyle } from "./regional-style.js";

function isPlainTranslationRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value === Object.prototype) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getTranslationEntries(value) {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("translation map must not contain symbol keys");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = [];
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError("translation map must not contain accessor properties");
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

export function flattenTranslationMap(value, prefix = "", output = Object.create(null), depth = 0) {
  if (!isPlainTranslationRecord(output)) {
    throw new TypeError("translation map output must be a plain record and not Object.prototype");
  }
  if (!isPlainTranslationRecord(value)) return output;
  if (typeof prefix !== "string") {
    throw new TypeError("translation map prefix must be a string");
  }
  if (!Number.isInteger(depth) || depth < 0 || depth > 24) {
    throw new RangeError("translation map exceeds the maximum nesting depth");
  }
  for (const [key, item] of getTranslationEntries(value)) {
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError("translation map contains a prototype-sensitive key");
    }
    const path = prefix ? prefix + "." + key : key;
    if (typeof item === "string") {
      if (Object.hasOwn(output, path)) {
        throw new TypeError("translation map contains a duplicate flattened key: " + path);
      }
      Object.defineProperty(output, path, {
        value: item,
        enumerable: true,
        configurable: true,
        writable: true
      });
    } else if (isPlainTranslationRecord(item)) {
      flattenTranslationMap(item, path, output, depth + 1);
    }
  }
  return output;
}

export function stableTranslationHash(value) {
  if (!isPlainTranslationRecord(value)) {
    throw new TypeError("translation hash requires a plain flattened string map");
  }
  const entries = getTranslationEntries(value);
  for (const [key, item] of entries) {
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError("translation map contains a prototype-sensitive key");
    }
    if (typeof item !== "string") {
      throw new TypeError("translation hash requires a flattened string map");
    }
  }
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function findShapeMismatchPath(path, otherKeys) {
  const otherSet = otherKeys instanceof Set ? otherKeys : new Set(otherKeys);
  const segments = path.split(".");
  for (let length = segments.length - 1; length > 0; length--) {
    const ancestor = segments.slice(0, length).join(".");
    if (otherSet.has(ancestor)) return ancestor;
  }
  for (const key of otherSet) {
    if (key.startsWith(path + ".")) return path;
  }
  return null;
}

export function auditTranslationMaps(sourceMap, targetMap, {
  sourceLocale = "es-419",
  targetLocale = "en",
  library = new LanguageLibrary(),
  humanApproval = null,
  allowUntranslatedKeys = []
} = {}) {
  const source = flattenTranslationMap(sourceMap);
  const target = flattenTranslationMap(targetMap);
  const sourceKeys = Object.keys(source).sort();
  const targetKeys = Object.keys(target).sort();
  const sourceSet = new Set(sourceKeys);
  const targetSet = new Set(targetKeys);
  const findings = [];
  const reportedShapeMismatches = new Set();
  let missingKeys = 0, emptyValues = 0, placeholderMismatches = 0, obsoleteKeys = 0, messageShapeMismatches = 0;

  const semanticFindings = auditTranslationSemantics(source, target, {
    sourceLocale,
    targetLocale,
    allowUntranslatedKeys
  });
  findings.push(...semanticFindings);
  const linguisticFindings = auditTranslationLinguisticSignals(target, { targetLocale });
  findings.push(...linguisticFindings);
  const regionalStyleFindings = auditTranslationRegionalStyle(target, { targetLocale });
  findings.push(...regionalStyleFindings);

  const reportShapeMismatch = (key) => {
    if (reportedShapeMismatches.has(key)) return;
    reportedShapeMismatches.add(key);
    messageShapeMismatches++;
    findings.push({
      id: "message-shape-mismatch",
      key,
      severity: "high",
      message: "Source and target use different nested message structures."
    });
  };

  for (const key of sourceKeys) {
    if (!targetSet.has(key)) {
      const shapeKey = findShapeMismatchPath(key, targetKeys);
      if (shapeKey) reportShapeMismatch(shapeKey);
      else {
        missingKeys++;
        findings.push({ id: "missing-key", key, severity: "high", message: "Translation key is missing from target locale." });
      }
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

  for (const key of targetKeys) {
    if (!sourceSet.has(key)) {
      const shapeKey = findShapeMismatchPath(key, sourceKeys);
      if (shapeKey) reportShapeMismatch(shapeKey);
      else {
        obsoleteKeys++;
        findings.push({ id: "obsolete-key", key, severity: "low", message: "Target locale contains a key absent from the source locale." });
      }
    }
  }

  const sourceHash = stableTranslationHash(source);
  const targetHash = stableTranslationHash(target);
  const state = resolveTranslationState({
    missingKeys,
    emptyValues,
    placeholderMismatches,
    obsoleteKeys,
    messageShapeMismatches,
    humanApproval,
    sourceHash,
    targetHash
  });
  return Object.freeze({
    status: "checked",
    sourceLocale,
    targetLocale,
    reviewStatus: state,
    counts: Object.freeze({
      sourceKeys: sourceKeys.length,
      targetKeys: targetKeys.length,
      missingKeys,
      emptyValues,
      placeholderMismatches,
      obsoleteKeys,
      messageShapeMismatches,
      glossaryReview: findings.filter((item) => item.id === "glossary-review").length,
      unchangedSourceText: semanticFindings.filter((item) => item.id === "unchanged-source-text").length,
      protectedTokenMismatches: semanticFindings.filter((item) => item.id.startsWith("protected-")).length,
      corruptedText: semanticFindings.filter((item) => item.id.startsWith("corrupted-") || item.id === "suspicious-encoding-sequence").length,
      linguisticSignals: linguisticFindings.length,
      regionalStyleSignals: regionalStyleFindings.length
    }),
    sourceHash,
    targetHash,
    findings: Object.freeze(findings)
  });
}
