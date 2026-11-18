export const DEFAULT_LOCALE = "es-419";

export const SUPPORTED_LOCALES = Object.freeze([
  "es-NI", "es-419", "es-MX", "es-ES",
  "en-US", "en-GB",
  "pt-BR", "pt-PT",
  "fr-FR", "de-DE", "it-IT", "ar"
]);

const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur"]);

export function canonicalizeLocale(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return Intl.getCanonicalLocales(value.trim().replaceAll("_", "-"))[0] ?? null;
  } catch {
    return null;
  }
}

export function normalizeLocale(value) {
  const canonical = canonicalizeLocale(value);
  if (!canonical) return null;
  const exact = SUPPORTED_LOCALES.find((item) => item.toLowerCase() === canonical.toLowerCase());
  if (exact) return exact;
  const language = new Intl.Locale(canonical).language;
  return SUPPORTED_LOCALES.find((item) => new Intl.Locale(item).language === language) ?? null;
}

export function resolveLocale(requested, { supportedLocales = SUPPORTED_LOCALES, fallback = DEFAULT_LOCALE } = {}) {
  if (!Array.isArray(supportedLocales) || supportedLocales.length === 0) {
    throw new TypeError("supportedLocales must be a non-empty array");
  }
  const supported = supportedLocales.map((item) => {
    const canonical = canonicalizeLocale(item);
    if (!canonical) throw new TypeError("supportedLocales contains an invalid BCP 47 locale");
    return canonical;
  });
  const fallbackLocale = canonicalizeLocale(fallback);
  if (!fallbackLocale || !supported.includes(fallbackLocale)) {
    throw new TypeError("fallback must be present in supportedLocales");
  }
  const canonicalRequested = canonicalizeLocale(requested);
  if (canonicalRequested && supported.includes(canonicalRequested)) return canonicalRequested;
  if (canonicalRequested) {
    const language = new Intl.Locale(canonicalRequested).language;
    const languageMatch = supported.find((item) => new Intl.Locale(item).language === language);
    if (languageMatch) return languageMatch;
  }
  return fallbackLocale;
}

export function getTextDirection(locale) {
  const canonical = canonicalizeLocale(locale);
  if (!canonical) throw new TypeError("locale must be a valid BCP 47 locale");
  return RTL_LANGUAGES.has(new Intl.Locale(canonical).language) ? "rtl" : "ltr";
}

export function assertLocaleSupported(locale, supportedLocales = SUPPORTED_LOCALES) {
  const canonical = canonicalizeLocale(locale);
  const supported = supportedLocales.map(canonicalizeLocale);
  if (!canonical || !supported.includes(canonical)) {
    throw new RangeError("locale is not registered in this localization engine");
  }
  return canonical;
}
