import { auditCatalogs } from "../../packages/localization-engine/src/catalog.js";
import { DEFAULT_LOCALE, normalizeLocale } from "./locale.js";

/**
 * Runs Language QA's locale policy over complete catalogs, delegating CLDR
 * plural-category and message-shape validation to the shared localization
 * engine. Findings remain review-required; this function never approves copy.
 */
export function auditTranslationCatalogs(catalogs, {
  sourceLocale = DEFAULT_LOCALE,
  requiredLocales
} = {}) {
  if (catalogs === null || typeof catalogs !== "object" || Array.isArray(catalogs)) {
    throw new TypeError("catalogs must be a locale-keyed object");
  }
  const normalizedCatalogs = Object.create(null);
  for (const [localeValue, catalog] of Object.entries(catalogs)) {
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
