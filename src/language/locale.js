export const DEFAULT_LOCALE = "es-419";
export const SUPPORTED_LOCALES = Object.freeze(["es-419", "en"]);

export function normalizeLocale(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replaceAll("_", "-").toLowerCase();
  if (normalized === "es" || normalized.startsWith("es-")) return "es-419";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return null;
}

export function resolveLocale(requested, fallback = DEFAULT_LOCALE) {
  return normalizeLocale(requested) ?? normalizeLocale(fallback) ?? DEFAULT_LOCALE;
}

export function isSupportedLocale(value) {
  return SUPPORTED_LOCALES.includes(normalizeLocale(value));
}
