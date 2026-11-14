import { DOMAINS } from "../core/domains.js";
import { matchProducts } from "../core/product-matching.js";
import {
  createRadioShackResearchProvider,
  createLaCuracaoResearchProvider,
} from "./nicaragua-retailer-pages.js";
import { createSimanResearchProvider } from "./siman-vtex.js";

const FIELDS = Object.freeze([
  "name", "sku", "upc", "gtin", "mpn", "color", "price", "availability", "warranty",
]);

const FACTORIES = Object.freeze({
  radioshack: Object.freeze({
    name: "RadioShack Nicaragua",
    create: createRadioShackResearchProvider,
  }),
  laCuracao: Object.freeze({
    name: "La Curacao Nicaragua",
    create: createLaCuracaoResearchProvider,
  }),
  siman: Object.freeze({
    name: "Almacenes SIMAN Nicaragua",
    create: createSimanResearchProvider,
  }),
});

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(field + " must be an object");
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(field + " must be a non-empty string");
  }
  return value.trim();
}

function extractVariant(name) {
  const text = String(name ?? "");
  const ramMatch = text.match(/(\d+(?:\.\d+)?)\s*GB\s*(?:RAM|\+)/iu);
  const storageAfterPlus = text.match(/\+\s*(\d+(?:\.\d+)?)\s*GB\b/iu);
  const withoutRam = text.replace(/\d+(?:\.\d+)?\s*GB\s*RAM/giu, " ");
  const storageFallback = withoutRam.match(/(\d+(?:\.\d+)?)\s*GB\b/iu);
  const variant = {};
  if (ramMatch) variant.ramGB = Number(ramMatch[1]);
  const storageMatch = storageAfterPlus ?? storageFallback;
  if (storageMatch) {
    variant.storageGB = Number(storageMatch[1] ?? storageMatch[2]);
  }
  const colorMatch = text.match(/\b(negro|negra|black|gris|gray|grey|azul|blue|celeste|blanco|blanca|white|rojo|roja|red|verde|green|rosa|rosado|pink|morado|purpura|púrpura|violeta|silver|plata|dorado|gold)\b/iu);
  if (colorMatch) variant.color = colorMatch[1];
  return variant;
}

function buildMatchProduct(offer) {
  const data = offer.data;
  if (typeof data.name !== "string" || !data.name.trim()) return null;

  const identifiers = {};
  if (data.gtin) identifiers.gtin = String(data.gtin).trim();
  // Some Unicomer pages label their internal product SKU as "UPC".
  // Do not misclassify that value as a universal barcode when it duplicates SKU.
  if (data.upc && String(data.upc).trim() !== String(data.sku ?? "").trim()) {
    identifiers.upc = String(data.upc).trim();
  }
  if (data.mpn) identifiers.mpn = String(data.mpn).trim();

  const variant = extractVariant(data.name);
  if (typeof data.color === "string" && data.color.trim()) {
    variant.color = data.color.trim();
  }

  return {
    id: offer.retailer,
    domain: DOMAINS.TECHNOLOGY,
    name: data.name,
    identifiers,
    variant,
    market: "NI",
  };
}

function normalizeProviderResult(result) {
  if (!Array.isArray(result)) throw new TypeError("Retailer provider must return an array");
  if (result.length === 0) return null;
  const item = result[0];
  if (!item || typeof item !== "object" || !Object.hasOwn(item, "value")) {
    throw new TypeError("Retailer provider returned an invalid research record");
  }
  return item;
}

async function retrieveOffer({ retailer, url }, provider, subjectId) {
  const data = {};
  const evidence = {};
  try {
    for (const field of FIELDS) {
      const item = normalizeProviderResult(await provider.search({
        domain: DOMAINS.TECHNOLOGY,
        subjectId,
        field,
        query: url,
        limit: 1,
      }));
      data[field] = item?.value ?? null;
      evidence[field] = item ? Object.freeze({
        source: item.source ?? null,
        observedAt: item.observedAt ?? null,
        confidence: item.confidence ?? null,
        note: item.note ?? null,
      }) : null;
    }
  } catch (error) {
    return Object.freeze({
      retailer,
      retailerName: FACTORIES[retailer].name,
      url,
      status: "deferred",
      error: String(error?.message ?? error),
      data: Object.freeze(data),
      evidence: Object.freeze(evidence),
    });
  }

  const hasStableIdentifier = Boolean(data.gtin || data.mpn ||
    (data.upc && String(data.upc).trim() !== String(data.sku ?? "").trim()));
  const hasIdentity = typeof data.name === "string" && hasStableIdentifier;
  const observedAt = FIELDS.map(field => evidence[field]?.observedAt)
    .filter(Boolean).sort().at(-1) ?? null;

  return Object.freeze({
    retailer,
    retailerName: FACTORIES[retailer].name,
    url,
    status: hasIdentity ? "available" : "identity_incomplete",
    data: Object.freeze(data),
    evidence: Object.freeze(evidence),
    observedAt,
  });
}

function compareIdentity(offers) {
  const available = offers.filter(offer => offer.status === "available");
  const unresolvedRetailers = offers
    .filter(offer => offer.status !== "available")
    .map(offer => offer.retailer);
  if (available.length < 2) {
    return Object.freeze({
      status: "incomplete",
      matchedIdentifier: null,
      confirmedRetailers: Object.freeze(available.map(offer => offer.retailer)),
      unresolvedRetailers: Object.freeze(unresolvedRetailers),
      pairwise: Object.freeze([]),
      note: "Fewer than two retailers returned an identity with a stable manufacturer identifier.",
    });
  }

  const pairwise = [];
  for (let leftIndex = 0; leftIndex < available.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < available.length; rightIndex += 1) {
      const left = buildMatchProduct(available[leftIndex]);
      const right = buildMatchProduct(available[rightIndex]);
      const result = matchProducts(left, right);
      pairwise.push(Object.freeze({
        leftRetailer: available[leftIndex].retailer,
        rightRetailer: available[rightIndex].retailer,
        matchType: result.matchType,
        sameVariant: result.sameVariant,
        matchedIdentifier: result.matchedIdentifier,
        variantConflicts: result.variantConflicts,
        conflicts: result.conflicts,
        reasons: result.reasons,
        reviewRequired: result.reviewRequired,
      }));
    }
  }

  const allExact = pairwise.length > 0 && pairwise.every(match => match.sameVariant);
  const hasIdentifierConflict = pairwise.some(match =>
    match.conflicts.some(conflict =>
      conflict === "universal_identifier" ||
      conflict.endsWith(".universal_identifier") ||
      conflict === "mpn" ||
      conflict === "brand"
    )
  );
  const status = hasIdentifierConflict ? "mismatch" :
    !allExact ? "review_required" :
      unresolvedRetailers.length > 0 ? "partial_exact_variant" : "exact_variant";
  const identifiers = pairwise.map(match => match.matchedIdentifier).filter(Boolean);
  const matchedIdentifier = allExact && identifiers.length > 0 &&
    identifiers.every(value => value === identifiers[0]) ? identifiers[0] : null;

  return Object.freeze({
    status,
    matchedIdentifier,
    confirmedRetailers: Object.freeze(available.map(offer => offer.retailer)),
    unresolvedRetailers: Object.freeze(unresolvedRetailers),
    pairwise: Object.freeze(pairwise),
    note: status === "exact_variant"
      ? "All requested retailer listings match as the same variant using the deterministic product identity matcher."
      : status === "partial_exact_variant"
        ? "The available retailer subset matches as the same exact variant. Unresolved retailers are excluded from the partial comparison."
        : status === "mismatch"
          ? "At least one stable product identifier conflicts. Prices must not be ranked as the same product."
          : "The available listings are not proven to be the same exact variant. Human review is required before comparing prices.",
  });
}

function comparePrices(offers, identity) {
  const exactIdentity = identity.status === "exact_variant" ||
    identity.status === "partial_exact_variant";
  if (!exactIdentity) {
    return Object.freeze({
      status: "blocked_identity",
      scope: "none",
      unresolvedRetailers: identity.unresolvedRetailers ?? Object.freeze([]),
      currency: null,
      taxIncluded: null,
      lowestPrice: null,
      highestPrice: null,
      spread: null,
      note: "Price ranking is blocked until at least two retailer listings are confirmed to be the same exact variant.",
    });
  }

  const eligibleOffers = offers.filter(offer =>
    identity.confirmedRetailers.includes(offer.retailer)
  );
  const partial = identity.status === "partial_exact_variant";
  const prices = eligibleOffers.map(offer => ({
    retailer: offer.retailer,
    retailerName: offer.retailerName,
    price: offer.data.price,
  }));
  if (prices.some(item => !item.price ||
      !Number.isFinite(item.price.amount) || item.price.amount < 0 ||
      typeof item.price.currency !== "string")) {
    return Object.freeze({
      status: "incomplete",
      scope: partial ? "matching_subset" : "all_requested_retailers",
      unresolvedRetailers: identity.unresolvedRetailers ?? Object.freeze([]),
      currency: null,
      taxIncluded: null,
      lowestPrice: null,
      highestPrice: null,
      spread: null,
      note: "At least one retailer in the confirmed identity set has no explicit current price; no complete price ranking is produced.",
    });
  }

  const currencies = new Set(prices.map(item => item.price.currency));
  const taxStates = new Set(prices.map(item => item.price.taxIncluded));
  if (currencies.size !== 1 || taxStates.size !== 1) {
    return Object.freeze({
      status: "not_comparable",
      scope: partial ? "matching_subset" : "all_requested_retailers",
      unresolvedRetailers: identity.unresolvedRetailers ?? Object.freeze([]),
      currency: null,
      taxIncluded: null,
      lowestPrice: null,
      highestPrice: null,
      spread: null,
      note: "Currency or tax-inclusion treatment differs or is unknown; JBAE does not convert currencies or estimate tax.",
    });
  }

  const sorted = [...prices].sort((a, b) =>
    a.price.amount - b.price.amount || a.retailer.localeCompare(b.retailer, "en")
  );
  const first = sorted[0];
  const last = sorted.at(-1);
  return Object.freeze({
    status: partial ? "partial_comparable" : "comparable",
    scope: partial ? "matching_subset" : "all_requested_retailers",
    unresolvedRetailers: identity.unresolvedRetailers ?? Object.freeze([]),
    currency: first.price.currency,
    taxIncluded: first.price.taxIncluded,
    lowestPrice: Object.freeze({
      retailer: first.retailer,
      retailerName: first.retailerName,
      amount: first.price.amount,
      display: first.price.display ?? null,
    }),
    highestPrice: Object.freeze({
      retailer: last.retailer,
      retailerName: last.retailerName,
      amount: last.price.amount,
      display: last.price.display ?? null,
    }),
    spread: Object.freeze({
      amount: Number((last.price.amount - first.price.amount).toFixed(2)),
      currency: first.price.currency,
    }),
    note: partial
      ? "Prices compare only the subset of retailers with a confirmed exact-variant match. This is not a winner across all requested stores."
      : "Prices use the same explicit currency and tax-inclusion state. Delivery, financing and checkout fees are not included.",
  });
}

/**
 * Compare exact, user-supplied Nicaragua product URLs across the supported
 * retailer adapters. Retrieval is read-only; all results remain unconfirmed.
 */
export async function compareNicaraguaRetailerOffers({
  offers,
  providerOptions = {},
  providers = {},
  subjectId = "nicaragua-retailer-comparison",
} = {}) {
  if (!Array.isArray(offers) || offers.length < 2 || offers.length > 3) {
    throw new TypeError("offers must contain between 2 and 3 retailer product URLs");
  }
  requireText(subjectId, "subjectId");
  requireObject(providerOptions, "providerOptions");
  requireObject(providers, "providers");

  const seen = new Set();
  const normalizedOffers = offers.map((item, index) => {
    requireObject(item, `offers[${index}]`);
    const retailer = requireText(item.retailer, `offers[${index}].retailer`);
    requireText(item.url, `offers[${index}].url`);
    if (!Object.hasOwn(FACTORIES, retailer)) {
      throw new TypeError("Unsupported retailer: " + retailer);
    }
    if (seen.has(retailer)) throw new TypeError("Each retailer may appear only once");
    seen.add(retailer);
    return Object.freeze({ retailer, url: item.url.trim() });
  });

  const retrieved = await Promise.all(normalizedOffers.map(offer => {
    const provider = providers[offer.retailer] ??
      FACTORIES[offer.retailer].create(providerOptions[offer.retailer] ?? {});
    if (!provider || typeof provider.search !== "function") {
      throw new TypeError("Provider for " + offer.retailer + " must implement search()");
    }
    return retrieveOffer(offer, provider, subjectId);
  }));

  const identity = compareIdentity(retrieved);
  const prices = comparePrices(retrieved, identity);
  return Object.freeze({
    domain: DOMAINS.TECHNOLOGY,
    subjectId,
    market: "NI",
    requestedRetailers: Object.freeze(normalizedOffers.map(offer => offer.retailer)),
    identity,
    priceComparison: prices,
    offers: Object.freeze(retrieved),
    decision: "pending_review",
    changesVerifiedData: false,
    caveat: "Retailer data is an unconfirmed, timestamped research snapshot. Confirm the exact listing, stock, tax, delivery and final checkout amount before purchase.",
  });
}
