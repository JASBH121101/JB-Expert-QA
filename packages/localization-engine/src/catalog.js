import { canonicalizeLocale } from "./locale.js";

const PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/gu;

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainCatalog(value, label = "catalog", depth = 0) {
  if (depth > 24 || !isRecord(value)) throw new TypeError(label + " must be a nested plain object");
  for (const [key, item] of Object.entries(value)) {
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError(label + " contains an unsafe key");
    }
    if (typeof item === "string") continue;
    if (isRecord(item)) {
      const keys = Object.keys(item);
      if (keys.length > 0 && keys.every((entry) => PLURAL_CATEGORIES.has(entry))) {
        if (typeof item.other !== "string") throw new TypeError(label + "." + key + " plural form requires other");
        if (keys.some((entry) => typeof item[entry] !== "string")) {
          throw new TypeError(label + "." + key + " plural forms must be strings");
        }
      } else {
        assertPlainCatalog(item, label + "." + key, depth + 1);
      }
      continue;
    }
    throw new TypeError(label + "." + key + " must be a string, plural object, or nested object");
  }
}

function flattenCatalogInto(value, prefix, output, depth) {
  if (depth > 24) throw new TypeError("catalog exceeds the maximum nesting depth");
  for (const [key, item] of Object.entries(value)) {
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError("catalog contains an unsafe key");
    }
    const path = prefix ? prefix + "." + key : key;
    if (typeof item === "string" || isPluralEntry(item)) output[path] = item;
    else if (isRecord(item)) flattenCatalogInto(item, path, output, depth + 1);
    else throw new TypeError("catalog." + path + " must be a string, plural object, or nested object");
  }
}

export function flattenCatalog(value, prefix = "", output = Object.create(null)) {
  if (!isRecord(value)) return output;
  if (typeof prefix !== "string" || !isRecord(output)) {
    throw new TypeError("catalog flattening prefix and output are invalid");
  }
  assertPlainCatalog(value, "catalog");
  flattenCatalogInto(value, prefix, output, 0);
  return output;
}

function isPluralEntry(value) {
  return isRecord(value) && Object.keys(value).length > 0 &&
    Object.keys(value).every((key) => PLURAL_CATEGORIES.has(key)) &&
    typeof value.other === "string";
}

function getByPath(catalog, key) {
  const segments = key.split(".");
  let current = catalog;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function placeholders(value) {
  if (typeof value !== "string") return new Set();
  return new Set([...value.matchAll(PLACEHOLDER)].map((match) => match[1]));
}

function interpolate(message, params) {
  if (!isRecord(params)) throw new TypeError("params must be a plain object");
  return message.replace(PLACEHOLDER, (_full, name) => {
    if (!Object.hasOwn(params, name)) throw new TypeError("missing translation parameter: " + name);
    const value = params[name];
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError("translation parameter " + name + " must be finite");
      }
      return String(value);
    }
    throw new TypeError("translation parameter " + name + " must be a scalar");
  });
}

export function validateCatalog(catalog, locale) {
  const canonical = canonicalizeLocale(locale);
  if (!canonical) throw new TypeError("catalog locale must be a valid BCP 47 locale");
  assertPlainCatalog(catalog, canonical);
  const entries = Object.fromEntries(Object.entries(flattenCatalog(catalog)).map(([key, item]) => [
    key,
    isPluralEntry(item) ? Object.freeze({ ...item }) : item
  ]));
  return Object.freeze({ locale: canonical, entries: Object.freeze(entries) });
}

export function auditCatalogs(catalogs, { sourceLocale, requiredLocales = [] } = {}) {
  const sourceTag = canonicalizeLocale(sourceLocale);
  if (!sourceTag || !isRecord(catalogs) || !Object.hasOwn(catalogs, sourceTag)) {
    throw new TypeError("sourceLocale must identify a catalog in catalogs");
  }
  const source = validateCatalog(catalogs[sourceTag], sourceTag).entries;
  const findings = [];
  const sourceKeys = Object.keys(source);
  const sourceKeySet = new Set(sourceKeys);
  const findShapeMismatchPath = (path, otherKeys) => {
    const otherSet = otherKeys instanceof Set ? otherKeys : new Set(otherKeys);
    const segments = path.split(".");
    for (let length = segments.length - 1; length > 0; length--) {
      const ancestor = segments.slice(0, length).join(".");
      if (otherSet.has(ancestor)) return ancestor;
    }
    if (otherKeys.some((key) => key.startsWith(path + "."))) return path;
    return null;
  };
  for (const localeValue of requiredLocales) {
    const locale = canonicalizeLocale(localeValue);
    if (!locale) throw new TypeError("requiredLocales contains an invalid locale");
    if (!Object.hasOwn(catalogs, locale)) {
      findings.push({ locale, key: "*", code: "catalog-missing", severity: "high" });
      continue;
    }
    const target = validateCatalog(catalogs[locale], locale).entries;
    const targetKeys = Object.keys(target);
    const targetKeySet = new Set(targetKeys);
    const reportedShapeMismatches = new Set();
    const reportShapeMismatch = (key) => {
      if (reportedShapeMismatches.has(key)) return;
      reportedShapeMismatches.add(key);
      findings.push({ locale, key, code: "message-shape-mismatch", severity: "high" });
    };
    for (const key of sourceKeys) {
      if (!Object.hasOwn(target, key)) {
        const shapeKey = findShapeMismatchPath(key, targetKeySet);
        if (shapeKey) reportShapeMismatch(shapeKey);
        else findings.push({ locale, key, code: "translation-missing", severity: "high" });
        continue;
      }
      const sourceValue = source[key];
      const targetValue = target[key];
      if ((typeof sourceValue === "object") !== (typeof targetValue === "object")) {
        findings.push({ locale, key, code: "message-shape-mismatch", severity: "high" });
        continue;
      }
      const sourceIsPlural = typeof sourceValue === "object";
      if (!sourceIsPlural) {
        const expected = placeholders(sourceValue);
        const actual = placeholders(targetValue);
        if (expected.size !== actual.size || [...expected].some((item) => !actual.has(item))) {
          findings.push({ locale, key, code: "placeholder-mismatch", severity: "high" });
        }
      } else {
        const requiredPluralCategories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
        for (const category of requiredPluralCategories) {
          if (!Object.hasOwn(targetValue, category)) {
            findings.push({
              locale,
              key,
              code: "plural-category-missing",
              category,
              severity: "high"
            });
          }
        }
        // Plural languages may legitimately omit a count in grammatical
        // forms such as Arabic one/two. Compare the mandatory "other" form
        // and reject any target-only placeholder names in other forms.
        const expected = placeholders(sourceValue.other);
        const actual = placeholders(targetValue.other);
        const allowed = new Set(Object.values(sourceValue).flatMap((item) => [...placeholders(item)]));
        const targetForms = Object.values(targetValue);
        const targetOnly = targetForms.some((item) =>
          [...placeholders(item)].some((name) => !allowed.has(name))
        );
        if (expected.size !== actual.size || [...expected].some((item) => !actual.has(item)) || targetOnly) {
          findings.push({ locale, key, code: "placeholder-mismatch", severity: "high" });
        }
      }
    }
    for (const key of targetKeys) {
      if (!Object.hasOwn(source, key)) {
        const shapeKey = findShapeMismatchPath(key, sourceKeySet);
        if (shapeKey) reportShapeMismatch(shapeKey);
        else findings.push({ locale, key, code: "obsolete-translation", severity: "low" });
      }
    }
  }
  return Object.freeze({
    status: findings.length === 0 ? "passed" : "review-required",
    sourceLocale: sourceTag,
    requiredLocales: Object.freeze(requiredLocales.map(canonicalizeLocale)),
    findings: Object.freeze(findings)
  });
}

export function selectMessage(entry, locale, count) {
  if (typeof entry === "string") return entry;
  if (!isPluralEntry(entry)) throw new TypeError("translation entry has an unsupported shape");
  if (typeof count !== "number" || !Number.isFinite(count)) {
    throw new TypeError("plural translation requires a finite numeric count");
  }
  const category = new Intl.PluralRules(locale).select(count);
  return entry[category] ?? entry.other;
}

export function interpolateMessage(message, params = {}) {
  return interpolate(message, params);
}

export function getCatalogEntry(catalog, key) {
  if (typeof key !== "string" || !key.trim() || key.length > 256) {
    throw new TypeError("translation key must be a non-empty string up to 256 characters");
  }
  if (Object.hasOwn(catalog, key)) return catalog[key];
  return getByPath(catalog, key);
}
