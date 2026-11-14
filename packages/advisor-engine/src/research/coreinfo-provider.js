import { DOMAINS } from "../core/domains.js";
import { SOURCE_TYPES } from "../core/evidence.js";
import { assertFetch, createJsonReader, isoNow, requireText } from "./provider-utils.js";

const COREINFO_BASE = "https://www.coreinfos.in";

function normalizeCoreInfoKey(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function unwrapCoreInfoRecord(body) {
  const record = body?.device ?? body?.data?.device ?? body?.data ??
    body?.result?.device ?? body?.result ?? body;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("CoreInfo returned an invalid device record");
  }
  return record;
}

function collectCoreInfoValues(value, path = [], output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectCoreInfoValues(item, path, output);
    return output;
  }
  if (!value || typeof value !== "object") {
    if (path.length && value !== undefined && value !== null && value !== "") {
      output.push({ key: normalizeCoreInfoKey(path.at(-1)), path: path.join("."), value });
    }
    return output;
  }

  const label = value.name ?? value.label ?? value.key ?? value.title;
  if (typeof label === "string" && Object.hasOwn(value, "value") &&
      (typeof value.value !== "object" || value.value === null)) {
    output.push({ key: normalizeCoreInfoKey(label), path: [...path, label].join("."), value: value.value });
  }
  const groupLabel = value.category ?? value.group ?? value.section;
  for (const [key, child] of Object.entries(value)) {
    if (["name", "label", "key", "title", "category", "group", "section"].includes(key)) continue;
    const childPath = key === "items" && typeof groupLabel === "string" && groupLabel.trim()
      ? [...path, groupLabel, key]
      : [...path, key];
    collectCoreInfoValues(child, childPath, output);
  }
  return output;
}

const COREINFO_FIELD_ALIASES = Object.freeze({
  name: ["name", "model", "model_name", "device_name", "title"],
  identity: ["name", "model", "model_name", "device_name", "title"],
  brand: ["brand", "manufacturer"],
  manufacturer: ["brand", "manufacturer"],
  model: ["model", "model_name", "name"],
  device_type: ["device_type", "category", "type"],
  release_date: ["release_date", "launch_date", "released_date"],
  operating_system: ["operating_system", "os", "platform"],
  chipset: ["chipset", "processor", "cpu", "soc"],
  processor: ["processor", "cpu", "chipset", "soc"],
  gpu: ["gpu", "graphics_processor", "graphics"],
  ram: ["ram", "ram_size", "ram_capacity", "memory_ram"],
  ram_gb: ["ram_gb", "ram", "ram_size"],
  storage: ["storage", "internal_storage", "storage_capacity", "rom"],
  storage_gb: ["storage_gb", "storage", "internal_storage"],
  display_size: ["display_size", "display_size_inches", "screen_size", "screen_size_inches", "screen_diagonal", "diagonal", "diagonal_size", "size"],
  display_resolution: ["display_resolution", "display_resolution_px", "resolution", "resolution_px", "resolution_pixels", "screen_resolution"],
  display_type: ["display_type", "screen_type", "panel_type"],
  refresh_rate: ["refresh_rate", "refresh_rate_hz"],
  battery: ["battery", "battery_capacity", "capacity"],
  battery_capacity: ["battery_capacity", "battery", "capacity"],
  camera: ["camera", "main_camera", "rear_camera"],
  cameras: ["cameras", "camera", "rear_camera"],
  weight: ["weight", "device_weight"],
  connectivity: ["connectivity", "network", "wireless"],
  price_currency: ["price_currency", "currency", "original_currency", "source_currency"],
});

function coreInfoPrice(record, flattened) {
  const value = record.published_price ?? record.listed_price ?? record.original_price ??
    record.launch_price ?? record.price ?? record.pricing;
  if (value === undefined || value === null) return undefined;
  const currencyValue = record.price_currency ?? record.original_currency ??
    record.source_currency ?? record.currency ??
    flattened.find(item => ["currency", "pricecurrency", "originalcurrency", "sourcecurrency"].includes(item.key))?.value;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof currencyValue !== "string" || !currencyValue.trim()) return undefined;
    return { amount: value, currency: currencyValue.trim().toUpperCase(), indicative: true, basis: "published_reference" };
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const nested = value.original ?? value.published ?? value.listed ?? value;
    const amountValue = nested.amount ?? nested.value ?? nested.price;
    const amount = typeof amountValue === "number"
      ? amountValue
      : typeof amountValue === "string"
        ? Number(amountValue.replace(/[\s,]/gu, ""))
        : NaN;
    const currencyRaw = nested.currency ?? nested.currency_code ?? currencyValue;
    const currency = ({ "₹": "INR", "$": "USD", "€": "EUR", "£": "GBP" })[currencyRaw] ??
      (typeof currencyRaw === "string" ? currencyRaw.trim().toUpperCase() : null);
    if (Number.isFinite(amount) && currency) {
      return {
        amount,
        currency,
        indicative: true,
        basis: "published_reference",
      };
    }
    const display = nested.display ?? nested.formatted ?? nested.label;
    if (typeof display === "string") return parseCoreInfoPriceText(display, currency);
  }
  if (typeof value === "string") return parseCoreInfoPriceText(value, currencyValue);
  return undefined;
}

function parseCoreInfoPriceText(text, currencyHint) {
  const input = text.trim();
  const symbols = { "₹": "INR", "$": "USD", "€": "EUR", "£": "GBP" };
  const symbolMatch = input.match(/([₹$€£])\s*([\d,]+(?:\.\d+)?)/u);
  let amountText;
  let currency;
  if (symbolMatch) {
    amountText = symbolMatch[2];
    currency = symbols[symbolMatch[1]];
  } else {
    const codeMatch = input.match(/\b(INR|USD|EUR|GBP)\s*([\d,]+(?:\.\d+)?)\b/iu) ??
      input.match(/([\d,]+(?:\.\d+)?)\s*(INR|USD|EUR|GBP)\b/iu);
    if (codeMatch) {
      const codeFirst = /^[A-Za-z]{3}/u.test(codeMatch[0]);
      amountText = codeFirst ? codeMatch[2] : codeMatch[1];
      currency = (codeFirst ? codeMatch[1] : codeMatch[2]).toUpperCase();
    } else if (/^[\d,]+(?:\.\d+)?$/u.test(input) &&
        typeof currencyHint === "string" && /^[A-Z]{3}$/iu.test(currencyHint.trim())) {
      amountText = input;
      currency = currencyHint.trim().toUpperCase();
    } else {
      return undefined;
    }
  }
  const amount = Number(amountText.replace(/,/gu, ""));
  if (!Number.isFinite(amount) || amount < 0 || !currency) return undefined;
  return { amount, currency, indicative: true, basis: "published_reference" };
}

function coreInfoValue(record, field) {
  if (field === "price" || field === "published_price" || field === "price_reference") {
    return coreInfoPrice(record, collectCoreInfoValues(record));
  }
  const aliases = COREINFO_FIELD_ALIASES[field];
  if (!aliases) throw new Error(`CoreInfo provider does not support field: ${field}`);
  for (const alias of aliases) {
    const direct = record[alias];
    if (direct !== undefined && direct !== null && direct !== "") {
      if ((field === "brand" || field === "manufacturer") &&
          direct && typeof direct === "object" && !Array.isArray(direct)) {
        return direct.name ?? direct.label ?? direct.value;
      }
      return direct;
    }
  }
  const flattened = collectCoreInfoValues(record);
  for (const alias of aliases) {
    const key = normalizeCoreInfoKey(alias);
    const result = flattened.find(item => {
      if (item.key !== key) return false;
      if (field === "display_size" && key === "size") {
        const path = normalizeCoreInfoKey(item.path);
        return path.includes("display") || path.includes("screen");
      }
      return true;
    });
    if (result && result.value !== undefined && result.value !== null && result.value !== "") return result.value;
  }
  return undefined;
}

/**
 * CoreInfo read-only exact-slug provider. It preserves the source currency
 * and never turns its indicative price or FX estimates into a local retail price.
 * Reuse requires attribution to CoreInfo and a link to the device page.
 */
export function createCoreInfoResearchProvider({
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  timeoutMs = 12_000,
  cacheTtlMs = 60 * 60_000,
  minRequestIntervalMs = 150,
} = {}) {
  assertFetch(fetchImpl);
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const readJson = createJsonReader(fetchImpl, {
    timeoutMs, cacheTtlMs, maxCacheEntries: 100, minRequestIntervalMs,
  });
  return Object.freeze({
    id: "coreinfo-device-catalog",
    domains: Object.freeze([DOMAINS.TECHNOLOGY]),
    async search(request) {
      const query = requireText(request.query, "query");
      const field = requireText(request.field, "field").toLowerCase();
      const slug = query.replace(/^coreinfo:/u, "");
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
        throw new TypeError("CoreInfo query must be an exact device slug, e.g. huawei-nova-16-se");
      }
      const apiUrl = `${COREINFO_BASE}/api/device/${encodeURIComponent(slug)}.json`;
      const record = unwrapCoreInfoRecord(await readJson(apiUrl, "CoreInfo device record"));
      if (record.slug && record.slug !== slug) {
        throw new Error("CoreInfo detail response does not match the requested device slug");
      }
      const value = coreInfoValue(record, field);
      if (value === undefined || value === null || value === "") return [];
      const pageUrl = `${COREINFO_BASE}/${slug}`;
      const references = Array.isArray(record.source_urls)
        ? record.source_urls.filter(url => typeof url === "string" && /^https:\/\//u.test(url)).slice(0, 8)
        : [];
      const priceNote = field === "price" || field === "published_price" || field === "price_reference"
        ? "Price is a published reference in the original source currency; it may not be current, local to Nicaragua, or a live retailer quote. Converted estimates are not used."
        : "CoreInfo compiles published manufacturer and retailer information. Missing fields are not inferred.";
      return [{
        id: slug,
        value,
        confidence: 0.78,
        source: {
          name: "CoreInfo",
          url: pageUrl,
          type: SOURCE_TYPES.DATABASE,
          references: [apiUrl, ...references].slice(0, 10),
          attribution: "Data from CoreInfo",
        },
        observedAt: isoNow(clock),
        note: `${priceNote} Candidate remains unconfirmed in JBAE and requires identity/SKU review.`,
      }];
    },
  });
}

