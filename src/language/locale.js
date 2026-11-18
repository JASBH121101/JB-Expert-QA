export const DEFAULT_LOCALE = "es-419";
export const SUPPORTED_LOCALES = Object.freeze(["es-419", "en"]);

// Only approved Latin-American Spanish aliases collapse to es-419.
// In particular, es-ES is deliberately not treated as Latin-American Spanish.
const SPANISH_LATAM_REGIONS = new Set([
  "419", "NI", "MX", "GT", "HN", "CR", "PA", "SV", "DO",
  "CO", "AR", "CL", "PE", "UY", "PY", "BO", "VE", "EC"
]);

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

  if (canonical === "es") return "es-419";
  const spanish = /^es-(419|[A-Z]{2})$/.exec(canonical);
  if (spanish && SPANISH_LATAM_REGIONS.has(spanish[1])) return "es-419";

  if (/^en(?:-[A-Z]{2}|-[0-9]{3})?$/.test(canonical)) return "en";
  return null;
}

export function resolveLocale(requested, fallback = DEFAULT_LOCALE) {
  return normalizeLocale(requested) ?? normalizeLocale(fallback) ?? DEFAULT_LOCALE;
}

export function isSupportedLocale(value) {
  return SUPPORTED_LOCALES.includes(normalizeLocale(value));
}
