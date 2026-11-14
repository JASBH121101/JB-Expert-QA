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
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\\\$&");
}

function containsTerm(text, term) {
  const pattern = new RegExp("(^|[^\\\\p{L}\\\\p{N}])" + escapeRegExp(term.toLocaleLowerCase()) + "($|[^\\\\p{L}\\\\p{N}])", "u");
  return pattern.test(text.toLocaleLowerCase());
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
    const fromKey = source === "es-419" ? "es419" : "en";
    const toKey = target === "es-419" ? "es419" : "en";
    const suggestions = [];
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
    const fromKey = source === "es-419" ? "es419" : "en";
    const toKey = target === "es-419" ? "es419" : "en";
    const findings = [];
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
