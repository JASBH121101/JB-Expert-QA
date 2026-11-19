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
  { id: "employee", en: ["employee", "employees"], es419: ["empleado", "empleados"] },
  { id: "dashboard", en: ["dashboard", "dashboards"], es419: ["panel", "tablero"] },
  { id: "report", en: ["report", "reports"], es419: ["informe", "reporte"] },
  { id: "customer", en: ["customer", "customers"], es419: ["cliente", "clientes"] },
  { id: "supplier", en: ["supplier", "suppliers", "vendor", "vendors"], es419: ["proveedor", "proveedores"] },
  { id: "order", en: ["order", "orders"], es419: ["pedido", "pedidos", "orden", "órdenes"] },
  { id: "delivery", en: ["delivery", "deliveries"], es419: ["entrega", "entregas", "domicilio"] },
  { id: "warehouse", en: ["warehouse", "warehouses"], es419: ["bodega", "bodegas", "almacén", "almacenes"] },
  { id: "purchase", en: ["purchase", "purchases"], es419: ["compra", "compras"] },
  { id: "sale", en: ["sale", "sales"], es419: ["venta", "ventas"] },
  { id: "invoice", en: ["invoice", "invoices"], es419: ["factura", "facturas"] },
  { id: "discount", en: ["discount", "discounts"], es419: ["descuento", "descuentos"] },
  { id: "tax", en: ["tax", "taxes"], es419: ["impuesto", "impuestos"] },
  { id: "save", en: ["save"], es419: ["guardar"] },
  { id: "cancel", en: ["cancel", "cancelled", "canceled"], es419: ["cancelar", "cancelado"] },
  { id: "delete", en: ["delete", "remove"], es419: ["eliminar", "borrar"] },
  { id: "update", en: ["update", "updates"], es419: ["actualizar", "actualización", "actualizaciones"] },
  { id: "create", en: ["create", "new"], es419: ["crear", "nuevo", "nueva"] }
]);

function escapeRegExp(value) {
  return value.replace(/([\\^$.*+?()[\]{}|])/g, "\\$1");
}

function compileTerm(term) {
  return Object.freeze({
    term,
    pattern: new RegExp("(^|[^\\p{L}\\p{N}])" + escapeRegExp(term.toLocaleLowerCase()) + "($|[^\\p{L}\\p{N}])", "u")
  });
}

function findTerm(text, compiledTerms) {
  const normalized = text.toLocaleLowerCase();
  return compiledTerms.find((entry) => entry.pattern.test(normalized))?.term ?? null;
}

function glossaryLocaleKey(locale) {
  if (locale === "en-US" || locale === "en-GB") return "en";
  if (locale === "es-419" || locale === "es-NI" || locale === "es-MX") return "es419";
  return null;
}

export class LanguageLibrary {
  #compiledPairs = new Map();

  constructor({ glossary = DEFAULT_GLOSSARY } = {}) {
    if (!Array.isArray(glossary) || glossary.length > 1000) {
      throw new TypeError("glossary must be an array of at most 1000 terms");
    }
    this.glossary = Object.freeze(glossary.map((entry) => {
      if (!entry || typeof entry.id !== "string" || !entry.id.trim()) {
        throw new TypeError("each glossary entry requires a non-empty id");
      }
      const snapshot = { ...entry };
      for (const key of ["en", "es419"]) {
        const terms = entry[key] ?? [];
        if (!Array.isArray(terms) || terms.length > 100 ||
            terms.some((term) => typeof term !== "string" || !term.trim())) {
          throw new TypeError("glossary " + key + " terms must be non-empty strings");
        }
        snapshot[key] = Object.freeze(terms.map((term) => term.trim()));
      }
      return Object.freeze(snapshot);
    }));
  }

  #compiledTerms(fromKey, toKey) {
    const pairKey = fromKey + "->" + toKey;
    if (!this.#compiledPairs.has(pairKey)) {
      const compiled = this.glossary.map((entry) => Object.freeze({
        entry,
        source: Object.freeze((entry[fromKey] ?? []).map(compileTerm)),
        target: Object.freeze((entry[toKey] ?? []).map(compileTerm))
      }));
      this.#compiledPairs.set(pairKey, Object.freeze(compiled));
    }
    return this.#compiledPairs.get(pairKey);
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
    for (const { entry, source, target } of this.#compiledTerms(fromKey, toKey)) {
      const matched = findTerm(sourceText, source);
      if (matched && target.length) {
        suggestions.push({ termId: entry.id, matched, suggestions: target.map((item) => item.term) });
      }
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
    for (const { entry, source, target } of this.#compiledTerms(fromKey, toKey)) {
      const foundSource = findTerm(sourceText, source);
      if (!foundSource) continue;
      if (!findTerm(targetText, target)) {
        findings.push({
          termId: entry.id,
          sourceTerm: foundSource,
          expectedTargetTerms: target.map((item) => item.term)
        });
      }
    }
    return findings;
  }
}
