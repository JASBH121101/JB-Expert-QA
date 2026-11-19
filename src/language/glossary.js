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
    pattern: new RegExp("(^|[^\\p{L}\\p{N}])" + escapeRegExp(term.toLowerCase()) + "($|[^\\p{L}\\p{N}])", "u")
  });
}

function findTerm(text, compiledTerms) {
  const normalized = text.toLowerCase();
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
    const ids = new Set();
    const glossarySnapshot = [];
    for (let index = 0; index < glossary.length; index += 1) {
      const entryDescriptor = Object.getOwnPropertyDescriptor(glossary, String(index));
      if (!entryDescriptor || !Object.hasOwn(entryDescriptor, "value")) {
        throw new TypeError("glossary must not contain holes or accessor properties");
      }
      const entry = entryDescriptor.value;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new TypeError("each glossary entry requires a plain record");
      }
      const idDescriptor = Object.getOwnPropertyDescriptor(entry, "id");
      if (!idDescriptor || !Object.hasOwn(idDescriptor, "value") ||
          typeof idDescriptor.value !== "string" || !idDescriptor.value.trim()) {
        throw new TypeError("each glossary entry requires a data-property id");
      }
      if (ids.has(idDescriptor.value)) throw new TypeError("glossary entry ids must be unique");
      ids.add(idDescriptor.value);
      if (typeof entry !== "object" || Array.isArray(entry)) {
        throw new TypeError("each glossary entry must be a plain record");
      }
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("each glossary entry must be a plain record");
      }
      if (Object.getOwnPropertySymbols(entry).length > 0) {
        throw new TypeError("glossary entries must not contain symbol keys");
      }
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      const snapshot = Object.create(null);
      for (const property of Object.keys(descriptors)) {
        const descriptor = descriptors[property];
        if (!descriptor.enumerable) continue;
        if (!Object.hasOwn(descriptor, "value")) {
          throw new TypeError("glossary entries must not contain accessor properties");
        }
        if (property === "__proto__" || property === "prototype" || property === "constructor") {
          throw new TypeError("glossary entries cannot contain prototype-sensitive keys");
        }
        snapshot[property] = descriptor.value;
      }
      for (const key of ["en", "es419"]) {
        const terms = snapshot[key] ?? [];
        if (!Array.isArray(terms) || terms.length > 100 || Object.getOwnPropertySymbols(terms).length > 0) {
          throw new TypeError("glossary " + key + " terms must be a safe array of at most 100 terms");
        }
        const copiedTerms = [];
        for (let index = 0; index < terms.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(terms, String(index));
          if (!descriptor || !Object.hasOwn(descriptor, "value")) {
            throw new TypeError("glossary " + key + " terms must not contain holes or accessor properties");
          }
          if (typeof descriptor.value !== "string" || !descriptor.value.trim() || descriptor.value.length > 120) {
            throw new TypeError("glossary " + key + " terms must be non-empty strings of at most 120 characters");
          }
          copiedTerms.push(descriptor.value.trim());
        }
        snapshot[key] = Object.freeze(copiedTerms);
      }
      glossarySnapshot.push(Object.freeze(snapshot));
    }
    this.glossary = Object.freeze(glossarySnapshot);
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
