import { DOMAINS } from "./domains.js";

const UNIVERSAL_IDENTIFIERS = Object.freeze(["gtin", "ean", "upc"]);
const MANUFACTURER_IDENTIFIERS = Object.freeze(["mpn", "manufacturerSku", "modelNumber"]);
const VARIANT_FIELDS = Object.freeze([
  "ramGB", "storageGB", "color", "edition", "carrier", "network", "region",
  "condition", "finish", "concentration", "volumeMl", "formulation", "packaging",
]);
const CAPACITY_FACTORS = Object.freeze({ mb: 1 / 1024, gb: 1, tb: 1024 });
const VOLUME_FACTORS = Object.freeze({ ml: 1, l: 1000 });

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/\b\d+(?:\.\d+)?\s*(?:gb|tb|mb)\b/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}
function normalizeIdentifier(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/gu, "");
}
function canonicalBarcode(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  let digits = value.replace(/[\s-]/gu, "");
  if (!/^\d+$/u.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return null;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    const distanceFromRight = body.length - index - 1;
    sum += Number(body[index]) * (distanceFromRight % 2 === 0 ? 3 : 1);
  }
  if ((10 - (sum % 10)) % 10 !== Number(digits.at(-1))) return null;
  while (digits.length > 12 && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}
function collectUniversalIdentifiers(product) {
  return UNIVERSAL_IDENTIFIERS.flatMap(field => {
    const raw = product.identifiers?.[field] ?? product[field];
    const canonical = canonicalBarcode(raw);
    return canonical ? [{ field, value: canonical }] : [];
  });
}
function tokenSimilarity(left, right) {
  const a = new Set(normalizeText(left).split(" ").filter(Boolean));
  const b = new Set(normalizeText(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}
function category(product) {
  return product.domain === DOMAINS.TECHNOLOGY
    ? product.deviceType ?? null
    : product.productType ?? null;
}
function normalizeCapacity(field, value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^([\d,]+(?:\.\d+)?)\s*(mb|gb|tb)?$/iu);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/gu, ""));
  const unit = (match[2] ?? (field === "volumeMl" ? "ml" : "gb")).toLowerCase();
  return Number.isFinite(amount) && CAPACITY_FACTORS[unit] !== undefined
    ? amount * CAPACITY_FACTORS[unit]
    : null;
}
function normalizeVolume(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^([\d,]+(?:\.\d+)?)\s*(ml|l)?$/iu);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/gu, ""));
  const unit = (match[2] ?? "ml").toLowerCase();
  return Number.isFinite(amount) ? amount * VOLUME_FACTORS[unit] : null;
}
function canonicalVariantValue(field, value) {
  if (["ramGB", "storageGB"].includes(field)) {
    const normalized = normalizeCapacity(field, value);
    if (normalized !== null) return `number:${normalized.toFixed(4)}`;
  }
  if (field === "volumeMl") {
    const normalized = normalizeVolume(value);
    if (normalized !== null) return `number:${normalized.toFixed(4)}`;
  }
  let normalized = normalizeText(value);
  if (field === "color") normalized = normalized.replace(/\bgrey\b/gu, "gray");
  if (field === "concentration") {
    const aliases = new Map([
      ["eau de parfum", "edp"], ["eau parfum", "edp"], ["edp", "edp"],
      ["eau de toilette", "edt"], ["eau toilette", "edt"], ["edt", "edt"],
      ["eau de cologne", "edc"], ["eau cologne", "edc"], ["edc", "edc"],
    ]);
    normalized = aliases.get(normalized) ?? normalized;
  }
  return normalized;
}
function variantValue(product, field) {
  return product.variant?.[field] ??
    product.attributes?.[field] ??
    product[field] ??
    undefined;
}
function internalVariantConflicts(product) {
  const conflicts = [];
  for (const field of VARIANT_FIELDS) {
    const values = [
      product.variant?.[field],
      product.attributes?.[field],
      product[field],
    ].filter(value => value !== undefined && value !== null && value !== "");
    const normalized = new Set(values.map(value => canonicalVariantValue(field, value)));
    if (normalized.size > 1) conflicts.push(field);
  }
  return conflicts;
}
function compareVariants(left, right) {
  const conflicts = [];
  const comparable = [];
  for (const field of VARIANT_FIELDS) {
    const a = variantValue(left, field);
    const b = variantValue(right, field);
    if (a === undefined || a === null || a === "" || b === undefined || b === null || b === "") continue;
    comparable.push(field);
    if (canonicalVariantValue(field, a) !== canonicalVariantValue(field, b)) conflicts.push(field);
  }
  return { conflicts, comparable };
}
function identifierValue(product, field) {
  const value = product.identifiers?.[field] ?? product[field];
  return value === undefined || value === null || value === "" ? null : normalizeIdentifier(value);
}
function sharedIdentifier(left, right) {
  const leftBarcodes = collectUniversalIdentifiers(left);
  const rightBarcodes = collectUniversalIdentifiers(right);
  for (const a of leftBarcodes) {
    for (const b of rightBarcodes) {
      if (a.value === b.value) {
        return {
          field: a.field === b.field ? a.field : `${a.field}/${b.field}`,
          kind: "universal",
          value: a.value,
        };
      }
    }
  }
  for (const field of MANUFACTURER_IDENTIFIERS) {
    const a = identifierValue(left, field), b = identifierValue(right, field);
    if (a && b && a === b) return { field, kind: "manufacturer", value: a };
  }
  return null;
}
function conflictingManufacturerIdentifiers(left, right) {
  return MANUFACTURER_IDENTIFIERS.filter(field => {
    const a = identifierValue(left, field), b = identifierValue(right, field);
    return Boolean(a && b && a !== b);
  });
}
function hasUniversalIdentifierConflict(left, right) {
  const a = collectUniversalIdentifiers(left);
  const b = collectUniversalIdentifiers(right);
  if (!a.length || !b.length) return false;
  return !a.some(leftItem => b.some(rightItem => leftItem.value === rightItem.value));
}
function hasInternalUniversalIdentifierConflict(product) {
  const values = collectUniversalIdentifiers(product).map(item => item.value);
  return new Set(values).size > 1;
}
function modelText(product) {
  const value = product.model ?? product.name;
  let model = normalizeText(value);
  const brand = normalizeText(product.brand);
  if (brand && model.startsWith(`${brand} `)) model = model.slice(brand.length + 1);
  return model;
}
function validateProduct(product, label) {
  if (!product || typeof product !== "object" || Array.isArray(product)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (typeof product.id !== "string" || !product.id.trim()) {
    throw new TypeError(`${label}.id must be a non-empty string`);
  }
  if (!Object.values(DOMAINS).includes(product.domain)) {
    throw new TypeError(`${label}.domain is unsupported`);
  }
  if (typeof product.name !== "string" || !product.name.trim()) {
    throw new TypeError(`${label}.name must be a non-empty string`);
  }
  for (const field of ["attributes", "identifiers", "variant"]) {
    if (product[field] !== undefined && product[field] !== null &&
        (typeof product[field] !== "object" || Array.isArray(product[field]))) {
      throw new TypeError(`${label}.${field} must be an object`);
    }
  }
  if (product.aliases !== undefined &&
      (!Array.isArray(product.aliases) || product.aliases.some(alias => typeof alias !== "string" || !alias.trim()))) {
    throw new TypeError(`${label}.aliases must be an array of non-empty strings`);
  }
  for (const field of VARIANT_FIELDS) {
    const values = [
      product.variant?.[field],
      product.attributes?.[field],
      product[field],
    ].filter(value => value !== undefined && value !== null);
    if (values.some(value =>
      (typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "string" && !value.trim()) ||
      (typeof value === "number" && !Number.isFinite(value))
    )) {
      throw new TypeError(`${label} variant field ${field} must be a non-empty string or finite number`);
    }
  }
  for (const field of UNIVERSAL_IDENTIFIERS) {
    const value = product.identifiers?.[field] ?? product[field];
    if (value !== undefined && value !== null && value !== "" && !canonicalBarcode(value)) {
      throw new TypeError(`${label}.identifiers.${field} must be a valid GTIN/EAN/UPC barcode`);
    }
  }
  for (const field of MANUFACTURER_IDENTIFIERS) {
    const value = product.identifiers?.[field] ?? product[field];
    if (value !== undefined && value !== null && value !== "" &&
        (typeof value !== "string" && typeof value !== "number" || !normalizeIdentifier(value))) {
      throw new TypeError(`${label}.identifiers.${field} must be a non-empty identifier`);
    }
  }
  for (const field of ["brand", "model", "market", "deviceType", "productType"]) {
    const value = product[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new TypeError(`${label}.${field} must be a string when provided`);
    }
  }
  return product;
}
function rejected(left, right, reason, conflict, reviewRequired = false) {
  return Object.freeze({
    leftId: left.id, rightId: right.id, score: 0, matchType: "no_match",
    sameVariant: false, matchedIdentifier: null,
    comparableVariantFields: Object.freeze([]), variantConflicts: Object.freeze([]),
    reasons: Object.freeze([reason]), conflicts: Object.freeze(Array.isArray(conflict) ? conflict : [conflict]),
    reviewRequired,
  });
}

/**
 * Deterministic identity comparison. Scores are heuristic matching scores,
 * not probabilities. This function never merges or changes catalog records.
 */
export function matchProducts(leftInput, rightInput) {
  const left = validateProduct(leftInput, "left");
  const right = validateProduct(rightInput, "right");
  const leftCategory = category(left);
  const rightCategory = category(right);

  if (left.domain !== right.domain) return rejected(left, right, "Different product domains.", "domain");
  if (leftCategory && rightCategory && leftCategory !== rightCategory) {
    return rejected(left, right, "Different product categories.", "category");
  }
  if ((leftCategory && !rightCategory) || (!leftCategory && rightCategory)) {
    return rejected(left, right, "Category is missing on one candidate.", "category_missing", true);
  }

  const leftBrand = normalizeText(left.brand);
  const rightBrand = normalizeText(right.brand);
  if (leftBrand && rightBrand && leftBrand !== rightBrand) {
    return rejected(left, right, "Brand mismatch.", "brand");
  }

  const leftInternalConflicts = internalVariantConflicts(left);
  const rightInternalConflicts = internalVariantConflicts(right);
  if (leftInternalConflicts.length || rightInternalConflicts.length ||
      hasInternalUniversalIdentifierConflict(left) || hasInternalUniversalIdentifierConflict(right)) {
    const conflicts = [
      ...leftInternalConflicts.map(field => `left.${field}`),
      ...rightInternalConflicts.map(field => `right.${field}`),
      ...(hasInternalUniversalIdentifierConflict(left) ? ["left.universal_identifier"] : []),
      ...(hasInternalUniversalIdentifierConflict(right) ? ["right.universal_identifier"] : []),
    ];
    return rejected(
      left, right, "A candidate contains inconsistent variant or identity values.",
      conflicts, true,
    );
  }

  const identifierConflicts = conflictingManufacturerIdentifiers(left, right);
  if (identifierConflicts.length) {
    return rejected(
      left, right, "Conflicting manufacturer identifiers.", identifierConflicts, true,
    );
  }

  const identifier = sharedIdentifier(left, right);
  const universalConflict = hasUniversalIdentifierConflict(left, right);
  const variants = compareVariants(left, right);
  const sameBrand = Boolean(leftBrand && rightBrand && leftBrand === rightBrand);
  const leftModel = modelText(left);
  const rightModel = modelText(right);
  const modelSimilarity = tokenSimilarity(leftModel, rightModel);
  const exactModel = Boolean(leftModel && rightModel && leftModel === rightModel);
  const exactName = normalizeText(left.name) === normalizeText(right.name);
  const aliases = [...(left.aliases ?? []), left.name];
  const aliasMatch = aliases.some(value =>
    normalizeText(value) === normalizeText(right.name) ||
    (right.aliases ?? []).some(alias => normalizeText(value) === normalizeText(alias))
  );

  let score = 0;
  const reasons = [];
  if (identifier?.kind === "universal") {
    score = 100;
    reasons.push(`Exact ${identifier.field.toUpperCase()} barcode match.`);
  } else if (identifier?.kind === "manufacturer") {
    score = 98;
    reasons.push(`Exact manufacturer identifier match (${identifier.field}).`);
  } else {
    if (sameBrand) { score += 18; reasons.push("Brand matches."); }
    if (exactModel) { score += 72; reasons.push("Normalized model matches exactly."); }
    else if (modelSimilarity >= 0.8) {
      score += Math.round(62 * modelSimilarity);
      reasons.push("Model names have strong token similarity.");
    } else if (modelSimilarity >= 0.55) {
      score += Math.round(48 * modelSimilarity);
      reasons.push("Model names have partial token similarity.");
    } else if (exactName || aliasMatch) {
      score += 60;
      reasons.push("Product name or registered alias matches.");
    } else {
      const nameSimilarity = tokenSimilarity(left.name, right.name);
      if (nameSimilarity >= 0.75) {
        score += Math.round(48 * nameSimilarity);
        reasons.push("Product names have token similarity.");
      }
    }
    if (leftCategory && rightCategory) {
      score += 10;
      reasons.push("Product category matches.");
    }
  }

  const conflicts = [...variants.conflicts];
  if (universalConflict) {
    conflicts.push("universal_identifier");
    reasons.push("Universal product barcodes differ; only a family-level match can be returned.");
  }
  const sameMarket = !left.market || !right.market ||
    normalizeText(left.market) === normalizeText(right.market);
  if (!sameMarket) {
    conflicts.push("market");
    reasons.push("Market/region differs; regional SKU compatibility needs review.");
  }
  if (variants.conflicts.length) {
    reasons.push(`Variant attributes differ: ${variants.conflicts.join(", ")}.`);
  }

  score = Math.min(100, score);
  const familyMatch = score >= 65;
  const variantKnown = variants.comparable.length > 0 || Boolean(identifier);
  const sameVariant = familyMatch && variants.conflicts.length === 0 && sameMarket &&
    !universalConflict &&
    Boolean(identifier || (score >= 85 && variants.comparable.length > 0 && (exactModel || modelSimilarity >= 0.95)));

  let matchType = "no_match";
  if (sameVariant) matchType = identifier ? "exact_variant" : "same_variant";
  else if (familyMatch) matchType = "same_product_family";
  else if (score >= 45) matchType = "possible";
  else score = 0;

  if (!sameVariant && familyMatch && !variants.conflicts.length && !variantKnown) {
    reasons.push("Core model looks compatible, but variant details are insufficient to confirm an exact SKU.");
  }
  if (sameVariant) reasons.push("No conflicting variant attributes were found.");

  return Object.freeze({
    leftId: left.id,
    rightId: right.id,
    score,
    matchType,
    sameVariant,
    matchedIdentifier: identifier ? identifier.field : null,
    comparableVariantFields: Object.freeze(variants.comparable),
    variantConflicts: Object.freeze(variants.conflicts),
    reasons: Object.freeze(reasons),
    conflicts: Object.freeze(conflicts),
    reviewRequired: !sameVariant || !identifier || !sameMarket || universalConflict,
  });
}

export function findProductMatches({ product: productInput, candidates, minScore = 45, limit = 10 } = {}) {
  const product = validateProduct(productInput, "product");
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) {
    throw new TypeError("minScore must be between 0 and 100");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError("limit must be between 1 and 50");
  }
  const matches = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = validateProduct(candidate, "candidate");
    if (normalized.id === product.id || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    const match = matchProducts(product, normalized);
    if (match.score >= minScore && match.matchType !== "no_match") matches.push(match);
  }
  matches.sort((a, b) =>
    b.score - a.score ||
    Number(b.sameVariant) - Number(a.sameVariant) ||
    a.rightId.localeCompare(b.rightId, "en")
  );
  return Object.freeze(matches.slice(0, limit));
}

export class ProductIdentityMatcher {
  match(left, right) { return matchProducts(left, right); }
  findMatches(options) { return findProductMatches(options); }
}
