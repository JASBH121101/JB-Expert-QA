import { DOMAINS } from "../core/domains.js";
import { normalizeCatalogProduct } from "./migrations.js";
import { findProductMatches } from "../core/product-matching.js";

const SEARCHABLE_ATTRIBUTES = Object.freeze({
  [DOMAINS.FRAGRANCE]: Object.freeze([
    "scentFamilies", "topNotes", "middleNotes", "baseNotes", "accords",
    "perfumer", "concentration",
  ]),
  [DOMAINS.TECHNOLOGY]: Object.freeze([
    "chipset", "processor", "operatingSystem", "networkBands", "displayType",
    "graphics", "manufacturer",
  ]),
});
const MAX_LIMIT = 50;
function normalizeText(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function tokens(value) { return normalizeText(value).split(/\s+/u).filter(Boolean); }
function asStrings(value) {
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(asStrings);
  return [];
}
function collectFields(product) {
  const fields = [
    ["id", product.id, 1000],
    ["model", product.model, 950],
    ["name", product.name, 900],
    ["aliases", product.aliases ?? [], 860],
    ["brand", product.brand, 820],
    ["productType", product.productType, 280],
    ["deviceType", product.deviceType, 280],
  ];
  const allowed = SEARCHABLE_ATTRIBUTES[product.domain] ?? [];
  for (const key of allowed) {
    if (Object.hasOwn(product.attributes, key)) fields.push([`attributes.${key}`, product.attributes[key], 180]);
  }
  return fields.flatMap(([field, value, weight]) =>
    asStrings(value).map(text => ({ field, text, normalized: normalizeText(text), weight })))
    .filter(item => item.normalized);
}
function identityKey(product) {
  return [
    product.domain,
    normalizeText(product.brand ?? ""),
    normalizeText(product.model ?? product.name),
    normalizeText(product.productType ?? product.deviceType ?? ""),
  ].join("|");
}
function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export class CatalogIndex {
  #products;
  #entries;
  constructor(products = []) {
    if (!Array.isArray(products)) throw new TypeError("Catalog products must be an array");
    const ids = new Set();
    this.#products = products.map(normalizeCatalogProduct);
    for (const product of this.#products) {
      if (ids.has(product.id)) throw new Error(`Duplicate catalog product ID: ${product.id}`);
      ids.add(product.id);
    }
    this.#entries = this.#products.map(product => ({ product, fields: collectFields(product) }));
  }
  get size() { return this.#products.length; }
  search({ query, domain, brand, productType, deviceType, limit = 10 } = {}) {
    if (typeof query !== "string" || !query.trim()) throw new TypeError("Catalog search query is required");
    if (domain !== undefined && !Object.values(DOMAINS).includes(domain)) throw new TypeError("Unsupported catalog domain");
    if (brand !== undefined && (typeof brand !== "string" || !brand.trim())) throw new TypeError("brand filter must be non-empty");
    if (productType !== undefined && (typeof productType !== "string" || !productType.trim())) throw new TypeError("productType filter must be non-empty");
    if (deviceType !== undefined && (typeof deviceType !== "string" || !deviceType.trim())) throw new TypeError("deviceType filter must be non-empty");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new TypeError(`Catalog result limit must be between 1 and ${MAX_LIMIT}`);
    }
    const normalizedQuery = normalizeText(query);
    const queryTokens = tokens(query);
    if (!normalizedQuery || queryTokens.length > 12) {
      throw new TypeError("Catalog search query must contain between 1 and 12 searchable terms");
    }
    const results = [];
    for (const entry of this.#entries) {
      const { product, fields } = entry;
      if (domain && product.domain !== domain) continue;
      if (brand && normalizeText(product.brand ?? "") !== normalizeText(brand)) continue;
      if (productType && product.productType !== productType) continue;
      if (deviceType && product.deviceType !== deviceType) continue;
      const exact = fields.find(field => field.normalized === normalizedQuery);
      let score = exact?.weight ?? 0;
      const matchedFields = new Set(exact ? [exact.field] : []);
      if (!exact) {
        let complete = true;
        for (const token of queryTokens) {
          const candidate = fields.filter(field => field.normalized.split(" ").some(part =>
            part === token || part.startsWith(token)));
          if (candidate.length === 0) { complete = false; break; }
          candidate.sort((a, b) => b.weight - a.weight || compareText(a.field, b.field));
          score += candidate[0].weight * (candidate[0].normalized === token ? 1 : 0.72);
          matchedFields.add(candidate[0].field);
        }
        if (!complete) continue;
      }
      results.push({
        product,
        score,
        matchedFields: Object.freeze([...matchedFields].sort(compareText)),
        matchType: exact ? "exact" : "token",
        explanation: exact
          ? `Exact match in ${exact.field}.`
          : `All query terms matched in: ${[...matchedFields].sort(compareText).join(", ")}.`,
      });
    }
    results.sort((a, b) =>
      Number(b.matchType === "exact") - Number(a.matchType === "exact") ||
      b.score - a.score || compareText(a.product.id, b.product.id));
    return Object.freeze(results.slice(0, limit).map(result => Object.freeze(result)));
  }
  findMatches(product, { minScore = 45, limit = 10 } = {}) {
    const normalized = normalizeCatalogProduct(product);
    return findProductMatches({
      product: normalized,
      candidates: this.#products,
      minScore,
      limit,
    });
  }
  findPotentialDuplicates() {
    const groups = new Map();
    for (const product of this.#products) {
      const key = identityKey(product);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(product);
    }
    return Object.freeze([...groups.entries()]
      .filter(([, products]) => products.length > 1)
      .map(([identity, products]) => Object.freeze({
        identity,
        productIds: Object.freeze(products.map(product => product.id).sort(compareText)),
        count: products.length,
        reviewRequired: true,
      }))
      .sort((a, b) => compareText(a.identity, b.identity)));
  }
}
export function searchCatalog(products, options) {
  return new CatalogIndex(products).search(options);
}
