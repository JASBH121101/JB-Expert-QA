const MAX_ALIASES = 24;
const IDENTIFIER_FIELDS = Object.freeze([
  "gtin", "ean", "upc", "mpn", "manufacturerSku", "modelNumber", "retailerSku",
]);
const BARCODE_FIELDS = new Set(["gtin", "ean", "upc"]);
const VARIANT_FIELDS = Object.freeze([
  "ramGB", "storageGB", "color", "edition", "carrier", "network", "region",
  "condition", "finish", "volumeMl", "concentration", "productType", "capacity",
  "formulation", "packaging",
]);

function optionalText(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string when provided`);
  }
  return value.trim();
}

function scalar(value, field) {
  if (typeof value === "string") return optionalText(value, field);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return undefined;
  throw new TypeError(`${field} must be a string, finite number, or boolean`);
}

function validateBarcode(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a barcode string`);
  }
  const digits = value.replace(/[\s-]/gu, "");
  if (!/^\d+$/u.test(digits) || ![8, 12, 13, 14].includes(digits.length)) {
    throw new TypeError(`${field} must contain 8, 12, 13 or 14 digits`);
  }
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    const distanceFromRight = body.length - index - 1;
    sum += Number(body[index]) * (distanceFromRight % 2 === 0 ? 3 : 1);
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  if (checkDigit !== Number(digits.at(-1))) {
    throw new TypeError(`${field} has an invalid barcode check digit`);
  }
  return digits;
}

function normalizeIdentifiers(input) {
  const raw = input.identifiers ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("identifiers must be an object");
  }
  const identifiers = {};
  for (const field of IDENTIFIER_FIELDS) {
    const rawValue = raw[field] ?? input[field];
    if (rawValue === undefined || rawValue === null) continue;
    const value = BARCODE_FIELDS.has(field)
      ? validateBarcode(rawValue, `identifiers.${field}`)
      : scalar(rawValue, `identifiers.${field}`);
    if (value !== undefined) identifiers[field] = String(value).trim();
  }
  const unknown = Object.keys(raw).filter(key => !IDENTIFIER_FIELDS.includes(key));
  if (unknown.length) throw new TypeError(`Unsupported identifiers: ${unknown.join(", ")}`);
  return Object.keys(identifiers).length ? Object.freeze(identifiers) : undefined;
}

function normalizeVariant(input) {
  const raw = input.variant ?? input.variantAttributes ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("variant must be an object");
  }
  const variant = {};
  for (const field of VARIANT_FIELDS) {
    const value = scalar(raw[field], `variant.${field}`);
    if (value !== undefined) variant[field] = value;
  }
  const unknown = Object.keys(raw).filter(key => !VARIANT_FIELDS.includes(key));
  if (unknown.length) throw new TypeError(`Unsupported variant fields: ${unknown.join(", ")}`);
  return Object.keys(variant).length ? Object.freeze(variant) : undefined;
}

export function normalizeCatalogIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Catalog identity input must be an object");
  }
  const brand = optionalText(input.brand, "brand");
  const model = optionalText(input.model, "model");
  const rawAliases = input.aliases ?? [];
  if (!Array.isArray(rawAliases) || rawAliases.length > MAX_ALIASES ||
      rawAliases.some(alias => typeof alias !== "string" || !alias.trim())) {
    throw new TypeError(`aliases must be an array of at most ${MAX_ALIASES} non-empty strings`);
  }
  const aliases = [...new Set(rawAliases.map(alias => alias.trim()))];
  const identifiers = normalizeIdentifiers(input);
  const variant = normalizeVariant(input);
  const market = optionalText(input.market ?? input.region, "market");
  const condition = optionalText(input.condition, "condition");
  return {
    ...(brand ? { brand } : {}),
    ...(model ? { model } : {}),
    ...(aliases.length ? { aliases: Object.freeze(aliases) } : {}),
    ...(identifiers ? { identifiers } : {}),
    ...(variant ? { variant } : {}),
    ...(market ? { market } : {}),
    ...(condition ? { condition } : {}),
  };
}
