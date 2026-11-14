import { DOMAINS } from "../../core/domains.js";
import { normalizeCatalogIdentity } from "../../core/catalog-identity.js";
import { cloneAndFreeze, normalizeEvidenceIds } from "../../core/immutable.js";

const PRODUCT_TYPES = new Set([
  "perfume", "body_mist", "body_spray", "traditional_attar",
  "concentrated_perfume_oil", "attar_labelled_perfume_oil", "body_oil",
  "lotion_cream", "decant", "manufacturer_sample", "travel_spray",
  // Legacy values remain readable; new catalog entries should use explicit types above.
  "attar_oil", "body_lotion",
]);
const PERFUME_CONCENTRATION_TYPES = new Set(["perfume", "decant", "manufacturer_sample", "travel_spray"]);
const INTENSITY_LEVELS = new Set(["soft", "moderate", "strong", "very_strong"]);
const PROJECTION_LEVELS = new Set(["close", "moderate", "strong", "very_strong"]);
const SILLAGE_LEVELS = new Set(["low", "moderate", "strong", "very_strong"]);
const CONCENTRATIONS = new Set(["extrait", "parfum", "edp", "edt", "edc", "not_applicable"]);
const SCORE_FIELDS = new Set([
  "sillageScore", "versatilityScore", "climateSuitabilityScore",
  "occasionFitScore", "projectionBalanceScore", "projectionDiscretionScore",
  "freshnessScore", "sweetnessBalanceScore", "scentComplexityScore",
]);
const POSITIVE_FIELDS = new Set([
  "volumeMl", "longevityHours", "longevityMinHours", "longevityMaxHours",
  "projectionDurationMinHours", "projectionDurationMaxHours",
  "projectionMeters", "priceUSD", "priceNIO",
]);
const LIST_FIELDS = new Set(["scentFamilies", "topNotes", "middleNotes", "baseNotes", "accords"]);

function normalizeVolume(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.value !== "number" || !Number.isFinite(value.value) ||
      typeof value.unit !== "string") throw new TypeError("volume must be a finite number or { value, unit }");
  const unit = value.unit.trim().toLowerCase();
  if (unit === "ml") return value.value;
  if (["l", "liter", "litre"].includes(unit)) return value.value * 1000;
  throw new TypeError("volume unit must be mL or L");
}

function normalizeHourRange(range, fieldName) {
  if (range === undefined || range === null) return {};
  if (!range || typeof range !== "object" || Array.isArray(range) ||
      typeof range.min !== "number" || typeof range.max !== "number" ||
      !Number.isFinite(range.min) || !Number.isFinite(range.max) ||
      range.min <= 0 || range.max <= range.min) {
    throw new TypeError(fieldName + " must contain positive finite min/max hours with max >= min, with a positive interval width");
  }
  return { min: range.min, max: range.max };
}

function normalizeLevel(value, field, allowed) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.has(value.trim().toLowerCase())) {
    throw new TypeError(field + " must be one of: " + [...allowed].join(", "));
  }
  return value.trim().toLowerCase();
}

function normalizeList(value, field) {
  if (value === undefined || value === null) return undefined;
  const items = Array.isArray(value) ? value : [value];
  if (items.some(item => typeof item !== "string" || !item.trim())) throw new TypeError(`${field} must contain only non-empty strings`);
  return [...new Set(items.map(item => item.trim()))];
}

export function normalizeFragranceProduct(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Fragrance product must be an object");
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : null;
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : null;
  if (!id || !name) throw new TypeError("Fragrance product requires id and name");
  const productType = String(input.productType ?? "").trim().toLowerCase();
  if (!PRODUCT_TYPES.has(productType)) throw new TypeError("productType must be a supported explicit fragrance format");
  if (input.domain !== undefined && input.domain !== DOMAINS.FRAGRANCE) throw new TypeError("Fragrance adapter cannot normalize another domain");
  if (!input.attributes || typeof input.attributes !== "object" || Array.isArray(input.attributes)) throw new TypeError("Fragrance product attributes must be an object");

  const attributes = { ...input.attributes };
  if (attributes.volume !== undefined && attributes.volumeMl !== undefined) throw new TypeError("Provide either volumeMl or volume with a unit, not both");
  if (attributes.volume !== undefined) attributes.volumeMl = normalizeVolume(attributes.volume);
  delete attributes.volume;
  if (attributes.longevityRange !== undefined) {
    if (attributes.longevityMinHours !== undefined || attributes.longevityMaxHours !== undefined) {
      throw new TypeError("Provide either longevityRange or longevityMinHours/longevityMaxHours");
    }
    const range = normalizeHourRange(attributes.longevityRange, "longevityRange");
    attributes.longevityMinHours = range.min;
    attributes.longevityMaxHours = range.max;
  }
  delete attributes.longevityRange;

  if (attributes.projectionDurationRange !== undefined) {
    if (attributes.projectionDurationMinHours !== undefined ||
        attributes.projectionDurationMaxHours !== undefined) {
      throw new TypeError("Provide either projectionDurationRange or projectionDurationMinHours/projectionDurationMaxHours");
    }
    const range = normalizeHourRange(attributes.projectionDurationRange, "projectionDurationRange");
    attributes.projectionDurationMinHours = range.min;
    attributes.projectionDurationMaxHours = range.max;
  }
  delete attributes.projectionDurationRange;

  if (attributes.concentration !== undefined) {
    const concentration = String(attributes.concentration).trim().toLowerCase();
    if (!CONCENTRATIONS.has(concentration)) throw new TypeError("Unsupported fragrance concentration");
    if (!PERFUME_CONCENTRATION_TYPES.has(productType) && concentration !== "not_applicable") {
      throw new TypeError("Body mist, body spray, attar/oil and body lotion must not inherit perfume concentration");
    }
    attributes.concentration = concentration;
  }
  for (const field of POSITIVE_FIELDS) {
    const value = attributes[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
        (["volumeMl", "priceUSD", "priceNIO"].includes(field) && value === 0)) {
      throw new TypeError(`${field} must be a valid non-negative number`);
    }
  }
  for (const [minField, maxField, label] of [
    ["longevityMinHours", "longevityMaxHours", "longevityRange"],
    ["projectionDurationMinHours", "projectionDurationMaxHours", "projectionDurationRange"],
  ]) {
    const hasMin = attributes[minField] !== undefined && attributes[minField] !== null;
    const hasMax = attributes[maxField] !== undefined && attributes[maxField] !== null;
    if (hasMin !== hasMax) throw new TypeError(label + " requires both minimum and maximum bounds");
    if (hasMin && attributes[minField] <= 0) {
      throw new TypeError(label + " minimum must be greater than zero");
    }
    if (hasMin && attributes[maxField] <= attributes[minField]) {
      throw new TypeError(label + " maximum must be greater than its minimum");
    }
  }
  if (attributes.intensityLevel !== undefined) {
    attributes.intensityLevel = normalizeLevel(attributes.intensityLevel, "intensityLevel", INTENSITY_LEVELS);
  }
  if (attributes.projectionLevel !== undefined) {
    attributes.projectionLevel = normalizeLevel(attributes.projectionLevel, "projectionLevel", PROJECTION_LEVELS);
  }
  if (attributes.sillageLevel !== undefined) {
    attributes.sillageLevel = normalizeLevel(attributes.sillageLevel, "sillageLevel", SILLAGE_LEVELS);
  }
  if (attributes.parentFragranceId !== undefined) {
    if (typeof attributes.parentFragranceId !== "string" || !attributes.parentFragranceId.trim()) {
      throw new TypeError("parentFragranceId must be a non-empty string");
    }
    attributes.parentFragranceId = attributes.parentFragranceId.trim();
  }
  if (productType === "decant") {
    if (!attributes.parentFragranceId) {
      throw new TypeError("A decant must reference its canonical parentFragranceId");
    }
    if (!(attributes.volumeMl > 0)) {
      throw new TypeError("A decant must specify a positive volumeMl");
    }
  }
  for (const field of SCORE_FIELDS) {
    const value = attributes[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) throw new TypeError(`${field} must be between 0 and 100`);
  }
  for (const field of LIST_FIELDS) {
    if (attributes[field] !== undefined) attributes[field] = normalizeList(attributes[field], field);
  }

  return Object.freeze({
    id, name, domain: DOMAINS.FRAGRANCE, productType,
    ...normalizeCatalogIdentity(input),
    attributes: cloneAndFreeze(attributes),
    evidenceIds: normalizeEvidenceIds(input.evidenceIds, "Fragrance evidenceIds"),
  });
}

export const FRAGRANCE_PRODUCT_TYPES = Object.freeze([...PRODUCT_TYPES]);
export const FRAGRANCE_CONCENTRATIONS = Object.freeze([...CONCENTRATIONS]);
