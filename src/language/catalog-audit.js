import { auditCatalogs } from "../../packages/localization-engine/src/catalog.js";
import { DEFAULT_LOCALE, normalizeLocale } from "./locale.js";

function snapshotCatalog(value, label, depth = 0, budget = { entries: 0 }) {
  if (depth > 24 || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be a nested plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(label + " must be a nested plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(label + " must not contain symbol keys");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " must not contain accessor properties");
    }
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError(label + " contains a prototype-sensitive key");
    }
    budget.entries += 1;
    if (budget.entries > 10000) throw new RangeError("catalog exceeds the 10000-entry safety limit");
    const item = descriptor.value;
    const safeValue = typeof item === "string"
      ? item
      : snapshotCatalog(item, label + "." + key, depth + 1, budget);
    Object.defineProperty(output, key, {
      value: safeValue,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return output;
}

/**
 * Runs Language QA's locale policy over complete catalogs, delegating CLDR
 * plural-category and message-shape validation to the shared localization
 * engine. Input is descriptor-inspected before delegation so getters are
 * never executed. Findings remain review-required; copy is never approved.
 */
export function auditTranslationCatalogs(catalogs, {
  sourceLocale = DEFAULT_LOCALE,
  requiredLocales
} = {}) {
  if (catalogs === null || typeof catalogs !== "object" || Array.isArray(catalogs)) {
    throw new TypeError("catalogs must be a locale-keyed object");
  }
  const catalogSnapshot = snapshotCatalog(catalogs, "catalogs");
  const normalizedCatalogs = Object.create(null);
  for (const [localeValue, catalog] of Object.entries(catalogSnapshot)) {
    const locale = normalizeLocale(localeValue);
    if (!locale) {
      throw new TypeError("catalog locale is not supported by Language QA: " + localeValue);
    }
    if (Object.hasOwn(normalizedCatalogs, locale)) {
      throw new TypeError("catalog locale aliases resolve to a duplicate locale: " + locale);
    }
    normalizedCatalogs[locale] = catalog;
  }

  const source = normalizeLocale(sourceLocale);
  if (!source || !Object.hasOwn(normalizedCatalogs, source)) {
    throw new TypeError("sourceLocale must identify a supported catalog");
  }
  const requested = requiredLocales ?? Object.keys(normalizedCatalogs).filter((locale) => locale !== source);
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new TypeError("requiredLocales must be a non-empty array");
  }
  const targets = requested.map((value) => {
    const locale = normalizeLocale(value);
    if (!locale) throw new TypeError("requiredLocales contains an unsupported Language QA locale");
    if (locale === source) throw new TypeError("requiredLocales must not include the source locale");
    return locale;
  });
  if (new Set(targets).size !== targets.length) {
    throw new TypeError("requiredLocales must not contain duplicate locale aliases");
  }

  const result = auditCatalogs(normalizedCatalogs, {
    sourceLocale: source,
    requiredLocales: targets
  });
  return Object.freeze({
    ...result,
    engine: "jb-localization-engine",
    reviewRequired: result.findings.length > 0 || result.status !== "passed",
    autoApproved: false
  });
}
