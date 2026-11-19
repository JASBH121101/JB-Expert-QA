export const DEFAULT_LOCALE = "es-419";
export const SUPPORTED_LOCALES = Object.freeze([
  "es-NI", "es-419", "es-MX", "es-ES",
  "en-US", "en-GB",
  "pt-BR", "pt-PT",
  "fr-FR", "de-DE", "it-IT", "ar"
]);

// Regional aliases are mapped only to an explicitly supported locale.
// Keep Iberian Spanish distinct from Latin-American Spanish.
const SPANISH_LATAM_REGIONS = new Set([
  "419", "NI", "MX", "GT", "HN", "CR", "PA", "SV", "DO",
  "CO", "AR", "CL", "PE", "UY", "PY", "BO", "VE", "EC"
]);
const LANGUAGE_DEFAULTS = Object.freeze({
  en: "en-US",
  pt: "pt-BR",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  ar: "ar"
});

function canonicalizeLocale(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return Intl.getCanonicalLocales(value.trim().replaceAll("_", "-"))[0] ?? null;
  } catch {
    return null;
  }
}

export function normalizeLocale(value) {
  const canonical = canonicalizeLocale(value);
  if (!canonical) return null;

  const exact = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === canonical.toLowerCase());
  if (exact) return exact;

  // Language QA supports registered base-language aliases and regional
  // fallbacks, but rejects scripts, extensions and malformed tags.
  if (!/^[a-z]{2}(?:-(?:[A-Z]{2}|[0-9]{3}))?$/.test(canonical)) return null;
  const [language, region] = canonical.split("-");
  if (language === "es") {
    if (!region) return "es-419";
    if (region === "ES") return "es-ES";
    if (SPANISH_LATAM_REGIONS.has(region)) return "es-419";
    return null;
  }
  const defaultLocale = LANGUAGE_DEFAULTS[language];
  if (!defaultLocale) return null;
  if (language === "en" && region === "GB") return "en-GB";
  return defaultLocale;
}

export function resolveLocale(requested, fallback = DEFAULT_LOCALE) {
  return normalizeLocale(requested) ?? normalizeLocale(fallback) ?? DEFAULT_LOCALE;
}

export function isSupportedLocale(value) {
  return SUPPORTED_LOCALES.includes(normalizeLocale(value));
}
