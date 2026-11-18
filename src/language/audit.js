import { createHash } from "node:crypto";
import { comparePlaceholders } from "./placeholders.js";
import { LanguageLibrary } from "./glossary.js";
import { resolveTranslationState } from "./review.js";

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function flattenTranslationMap(value, prefix = "", output = Object.create(null), depth = 0) {
  if (!isPlainRecord(value)) return output;
  if (typeof prefix !== "string" || !isPlainRecord(output)) {
    throw new TypeError("translation map prefix and output must be valid plain values");
  }
  if (!Number.isInteger(depth) || depth < 0 || depth > 24) {
    throw new RangeError("translation map exceeds the maximum nesting depth");
  }
  for (const [key, item] of Object.entries(value)) {
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError("translation map contains a prototype-sensitive key");
    }
    const path = prefix ? prefix + "." + key : key;
    if (typeof item === "string") {
      if (Object.hasOwn(output, path)) {
        throw new TypeError("translation map contains a duplicate flattened key: " + path);
      }
      output[path] = item;
    } else if (isPlainRecord(item)) {
      flattenTranslationMap(item, path, output, depth + 1);
    }
  }
  return output;
}

export function stableTranslationHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

export function auditTranslationMaps(sourceMap, targetMap, { sourceLocale = "es-419", targetLocale = "en", library = new LanguageLibrary(), humanApproval = null } = {}) {
  const source = flattenTranslationMap(sourceMap);
  const target = flattenTranslationMap(targetMap);
  const sourceKeys = Object.keys(source).sort();
  const targetKeys = Object.keys(target).sort();
  const sourceSet = new Set(sourceKeys);
  const targetSet = new Set(targetKeys);
  const findings = [];
  const reportedShapeMismatches = new Set();
  let missingKeys = 0, emptyValues = 0, placeholderMismatches = 0, obsoleteKeys = 0, messageShapeMismatches = 0;

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

  const state = resolveTranslationState({
    missingKeys,
    emptyValues,
    placeholderMismatches,
    obsoleteKeys,
    messageShapeMismatches,
    humanApproval
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
      glossaryReview: findings.filter((item) => item.id === "glossary-review").length
    }),
    sourceHash: stableTranslationHash(source),
    targetHash: stableTranslationHash(target),
    findings: Object.freeze(findings)
  });
}
