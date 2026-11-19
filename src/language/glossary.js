import { normalizeLocale } from "./locale.js";

export const DEFAULT_GLOSSARY = Object.freeze([
  { id: "product", en: ["product", "products"], es419: ["producto", "productos"] },
  { id: "category", en: ["category", "categories"], es419: ["categoría", "categorías"] },
  { id: "price", en: ["price", "prices"], es419: ["precio", "precios"] },
  { id: "quantity", en: ["quantity", "quantities"], es419: ["cantidad", "cantidades"] },
  { id: "availability", en: ["availability", "available"], es419: ["disponibilidad", "disponible"] },
  { id: "inventory", en: ["inventory", "stock"], es419: ["inventario", "existencias"] },
  { id: "settings", en: ["settings", "configuration"], es419: ["configuración", "ajustes"] },
  { id: "export", en: ["export", "exportation", "exportations"], es419: ["exportar", "exportación", "exportaciones"] },
  { id: "backup", en: ["backup", "backups"], es419: ["respaldo", "respaldos", "copia de seguridad"] },
  { id: "restore", en: ["restore", "restoration"], es419: ["restaurar", "restauración"] },
  { id: "sign-in", en: ["sign in", "log in", "login"], es419: ["iniciar sesión", "acceder"] },
  { id: "password", en: ["password", "passwords"], es419: ["contraseña", "contraseñas"] },
  { id: "currency", en: ["currency", "currencies"], es419: ["moneda", "monedas"] },
  { id: "country", en: ["country", "countries"], es419: ["país", "países"] },
  { id: "language", en: ["language", "languages"], es419: ["idioma", "idiomas"] },
  { id: "template", en: ["template", "templates"], es419: ["plantilla", "plantillas"] },
  { id: "unit", en: ["unit", "units"], es419: ["unidad", "unidades"] },
  { id: "upload", en: ["upload", "uploads"], es419: ["subir", "cargar"] },
  { id: "image", en: ["image", "images"], es419: ["imagen", "imágenes"] },
  { id: "employee", en: ["employee", "employees"], es419: ["empleado", "empleados"] }
]);

function escapeRegExp(value) {
  return value.replace(/([\\^$.*+?()[\]{}|])/g, "\\$1");
}

const TERM_PATTERN_CACHE_LIMIT = 512;
const termPatternCache = new Map();

function getTermPattern(term) {
  const normalized = term.toLocaleLowerCase();
  let pattern = termPatternCache.get(normalized);
  if (pattern) {
    // Refresh insertion order so frequently used glossary terms remain cached.
    termPatternCache.delete(normalized);
    termPatternCache.set(normalized, pattern);
    return pattern;
  }
  pattern = new RegExp("(^|[^\\p{L}\\p{N}])" + escapeRegExp(normalized) + "($|[^\\p{L}\\p{N}])", "u");
  termPatternCache.set(normalized, pattern);
  if (termPatternCache.size > TERM_PATTERN_CACHE_LIMIT) {
    termPatternCache.delete(termPatternCache.keys().next().value);
  }
  return pattern;
}

function containsTerm(text, term) {
  return getTermPattern(term).test(text.toLocaleLowerCase());
}

function glossaryLocaleKey(locale) {
  if (locale === "en-US" || locale === "en-GB") return "en";
  if (locale === "es-419" || locale === "es-NI" || locale === "es-MX") return "es419";
  return null;
}

export class LanguageLibrary {
  constructor({ glossary = DEFAULT_GLOSSARY } = {}) {
    this.glossary = Object.freeze([...glossary]);
  }

  terms() {
    return this.glossary;
  }

  suggestTranslation(sourceText, { sourceLocale = "en", targetLocale = "es-419" } = {}) {
    if (typeof sourceText !== "string" || !sourceText.trim()) throw new TypeError("sourceText must be a non-empty string");
    const source = normalizeLocale(sourceLocale);
    const target = normalizeLocale(targetLocale);
    if (!source || !target || source === target) throw new TypeError("Two different supported locales are required");
    const fromKey = glossaryLocaleKey(source);
    const toKey = glossaryLocaleKey(target);
    const suggestions = [];
    if (!fromKey || !toKey) {
      return Object.freeze({
        suggestions: Object.freeze(suggestions),
        requiresHumanReview: true,
        autoApproved: false,
        providerUsed: null
      });
    }
    for (const entry of this.glossary) {
      const from = entry[fromKey] ?? [];
      const to = entry[toKey] ?? [];
      const matched = from.find((term) => containsTerm(sourceText, term));
      if (matched && to.length) suggestions.push({ termId: entry.id, matched, suggestions: [...to] });
    }
    return Object.freeze({
      suggestions: Object.freeze(suggestions),
      requiresHumanReview: true,
      autoApproved: false,
      providerUsed: null
    });
  }

  validateTermConsistency(sourceText, targetText, { sourceLocale = "es-419", targetLocale = "en" } = {}) {
    const source = normalizeLocale(sourceLocale);
    const target = normalizeLocale(targetLocale);
    if (!source || !target || source === target) throw new TypeError("Two different supported locales are required");
    const fromKey = glossaryLocaleKey(source);
    const toKey = glossaryLocaleKey(target);
    const findings = [];
    if (!fromKey || !toKey) return findings;
    for (const entry of this.glossary) {
      const sourceTerms = entry[fromKey] ?? [];
      const targetTerms = entry[toKey] ?? [];
      const foundSource = sourceTerms.find((term) => containsTerm(sourceText, term));
      if (!foundSource) continue;
      if (!targetTerms.some((term) => containsTerm(targetText, term))) {
        findings.push({ termId: entry.id, sourceTerm: foundSource, expectedTargetTerms: [...targetTerms] });
      }
    }
    return findings;
  }
}
