import { canonicalizeLocale, resolveLocale, getTextDirection, SUPPORTED_LOCALES, DEFAULT_LOCALE } from "./locale.js";
import { auditCatalogs, validateCatalog, selectMessage, interpolateMessage, getCatalogEntry } from "./catalog.js";

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeCatalogs(catalogs) {
  if (!isRecord(catalogs)) throw new TypeError("catalogs must be a locale-keyed plain object");
  const result = Object.create(null);
  for (const [localeValue, catalog] of Object.entries(catalogs)) {
    const locale = canonicalizeLocale(localeValue);
    if (!locale || Object.hasOwn(result, locale)) throw new TypeError("catalog locale is invalid or duplicated");
    result[locale] = validateCatalog(catalog, locale).entries;
  }
  return result;
}

function formatLocale(locale, available) {
  return resolveLocale(locale, { supportedLocales: available, fallback: available[0] });
}

export function createLocalization({ catalogs, defaultLocale = DEFAULT_LOCALE } = {}) {
  const normalized = normalizeCatalogs(catalogs);
  const available = Object.keys(normalized);
  if (available.length === 0) throw new TypeError("at least one translation catalog is required");
  const defaultTag = canonicalizeLocale(defaultLocale);
  if (!defaultTag || !Object.hasOwn(normalized, defaultTag)) {
    throw new TypeError("defaultLocale must have a registered catalog");
  }

  function resolveCatalog(locale) {
    const tag = formatLocale(locale ?? defaultTag, available);
    if (Object.hasOwn(normalized, tag)) return { locale: tag, catalog: normalized[tag] };
    const language = new Intl.Locale(tag).language;
    const languageMatch = available.find((item) => new Intl.Locale(item).language === language);
    if (languageMatch) return { locale: languageMatch, catalog: normalized[languageMatch] };
    return { locale: defaultTag, catalog: normalized[defaultTag] };
  }

  function t(key, { locale, params = {}, count } = {}) {
    const preferred = resolveCatalog(locale ?? defaultTag);
    const fallback = { locale: defaultTag, catalog: normalized[defaultTag] };
    let entry = getCatalogEntry(preferred.catalog, key);
    let messageLocale = preferred.locale;
    if (entry === undefined) {
      entry = getCatalogEntry(fallback.catalog, key);
      messageLocale = fallback.locale;
    }
    if (entry === undefined) throw new RangeError("translation key is missing: " + key);
    const message = selectMessage(entry, messageLocale, count);
    return interpolateMessage(message, params);
  }

  function formatNumber(value, { locale, ...options } = {}) {
    const selected = resolveCatalog(locale ?? defaultTag).locale;
    if (!(typeof value === "number" && Number.isFinite(value)) && typeof value !== "bigint") {
      throw new TypeError("formatNumber value must be a finite number or bigint");
    }
    return new Intl.NumberFormat(selected, options).format(value);
  }

  function formatDate(value, { locale, ...options } = {}) {
    const selected = resolveCatalog(locale ?? defaultTag).locale;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("formatDate value is invalid");
    return new Intl.DateTimeFormat(selected, options).format(date);
  }

  function direction(locale) {
    return getTextDirection(resolveCatalog(locale ?? defaultTag).locale);
  }

  return Object.freeze({
    defaultLocale: defaultTag,
    supportedLocales: Object.freeze([...available]),
    t,
    formatNumber,
    formatDate,
    direction,
    audit: (options = {}) => auditCatalogs(
      Object.fromEntries(available.map((locale) => [locale, normalized[locale]])),
      { sourceLocale: options.sourceLocale ?? defaultTag, requiredLocales: options.requiredLocales ?? available }
    )
  });
}

export { DEFAULT_LOCALE, SUPPORTED_LOCALES, canonicalizeLocale, resolveLocale, getTextDirection };
export { auditCatalogs, validateCatalog } from "./catalog.js";
