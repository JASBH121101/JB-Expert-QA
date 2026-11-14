import { DOMAINS } from "../core/domains.js";
import { SOURCE_TYPES } from "../core/evidence.js";
import { createJsonReader } from "./provider-utils.js";
import { requireText, isoNow } from "./nicaragua-retailer-utils.js";

const RETAILER_TIMEOUT_MS = 12_000;
const SIMAN_CONFIG = Object.freeze({
  id: "siman-nicaragua-retail",
  pathPattern: /^\/[a-z0-9-]+\/p\/?$/u,
});

function uniqueVtexSpecification(product, labelPattern) {
  const values = [];
  const owners = [product, ...(Array.isArray(product?.items) ? product.items : [])];
  for (const owner of owners) {
    const specifications = [
      ...(Array.isArray(owner?.productSpecifications) ? owner.productSpecifications : []),
      ...(Array.isArray(owner?.specifications) ? owner.specifications : []),
      ...(Array.isArray(owner?.variations) ? owner.variations : []),
      ...(Array.isArray(owner?.specificationGroups)
        ? owner.specificationGroups.flatMap(group =>
            Array.isArray(group?.specifications) ? group.specifications : [])
        : []),
    ];
    for (const specification of specifications) {
      const names = [specification?.name, specification?.originalName,
        specification?.Key, specification?.Name].filter(value => typeof value === "string");
      if (!names.some(name => labelPattern.test(name.trim()))) continue;
      const raw = specification?.values ?? specification?.value ??
        specification?.Value ?? specification?.ValueName;
      for (const candidate of (Array.isArray(raw) ? raw : [raw])) {
        if (typeof candidate === "string" || typeof candidate === "number") {
          const value = String(candidate).trim();
          if (value) values.push(value);
        }
      }
    }
  }
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : null;
}

function normalizeVtexVariantDimensions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.freeze(Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => typeof key === "string" &&
        (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"))
      .map(([key, entry]) => [key.trim(), String(entry).trim()])
      .filter(([key, entry]) => key && entry),
  ));
}

function summarizeVtexVariantOffers(item, variation) {
  const offers = (Array.isArray(item?.sellers) ? item.sellers : [])
    .map(seller => seller?.commertialOffer ?? seller?.commercialOffer)
    .filter(offer => offer && typeof offer === "object");

  const prices = [...new Set(offers
    .map(offer => Number(offer.Price))
    .filter(value => Number.isFinite(value) && value > 0)
    .map(value => value.toFixed(2)))];
  const price = prices.length === 1 ? {
    amount: Number(prices[0]),
    currency: "NIO",
    taxIncluded: null,
    display: "C$" + Number(prices[0]).toFixed(2),
    basis: "vtex_public_sku_offer",
  } : null;

  const quantities = offers
    .map(offer => offer.AvailableQuantity)
    .filter(value => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter(value => Number.isFinite(value) && value >= 0);
  const flags = offers.map(offer => offer.IsAvailable)
    .filter(value => typeof value === "boolean");
  const quantityValue = variation?.availablequantity;
  const publishedQuantity = quantityValue === null || quantityValue === undefined || quantityValue === ""
    ? null : Number(quantityValue);
  const hasPublishedQuantity = publishedQuantity !== null &&
    Number.isFinite(publishedQuantity) && publishedQuantity >= 0;

  const sellerHasAvailableOffer =
    quantities.some(value => value > 0) || flags.some(value => value === true);
  const allSellerOffersUnavailable = offers.length > 0 && (
    (quantities.length === offers.length && quantities.every(value => value === 0)) ||
    (flags.length === offers.length && flags.every(value => value === false))
  );
  const sellerStatus = sellerHasAvailableOffer
    ? true
    : allSellerOffersUnavailable ? false : null;
  const variationStatus = typeof variation?.available === "boolean"
    ? variation.available
    : hasPublishedQuantity ? publishedQuantity > 0 : null;
  const statusConflict = sellerStatus !== null && variationStatus !== null &&
    sellerStatus !== variationStatus;
  let availability = null;
  if (!statusConflict) {
    const resolvedStatus = variationStatus ?? sellerStatus;
    if (resolvedStatus === true) availability = { status: "in_stock" };
    if (resolvedStatus === false) availability = { status: "out_of_stock" };
  }

  const quantityCandidates = [
    ...(hasPublishedQuantity ? [publishedQuantity] : []),
    ...quantities,
  ];
  const uniqueQuantities = [...new Set(quantityCandidates)];
  if (availability && uniqueQuantities.length === 1 && uniqueQuantities[0] >= 0) {
    availability.quantity = uniqueQuantities[0];
  }

  return Object.freeze({ price, availability });
}

function buildVtexSkuVariants(product, variations) {
  if (!Array.isArray(variations?.skus)) {
    throw new TypeError("SIMAN VTEX variations response is missing skus");
  }
  const itemsById = new Map((Array.isArray(product?.items) ? product.items : [])
    .filter(item => item?.itemId !== undefined && item?.itemId !== null)
    .map(item => [String(item.itemId), item]));

  return Object.freeze(variations.skus.map(variation => {
    const skuId = variation?.sku;
    if ((typeof skuId !== "string" && typeof skuId !== "number") ||
        !String(skuId).trim()) return null;
    const sku = String(skuId).trim();
    const item = itemsById.get(sku) ?? null;
    const dimensions = normalizeVtexVariantDimensions(variation.dimensions);
    const colorEntry = Object.entries(dimensions)
      .find(([key]) => /^(?:color|colour)$/iu.test(key.trim()));
    const capacityEntry = Object.entries(dimensions)
      .find(([key]) => /(?:capacidad|rom|storage)/iu.test(key));
    const offerSummary = summarizeVtexVariantOffers(item, variation);
    const name = typeof variation.skuname === "string" && variation.skuname.trim()
      ? variation.skuname.trim() : null;

    return Object.freeze({
      retailerSku: sku,
      name,
      dimensions,
      color: colorEntry?.[1] ?? null,
      capacity: capacityEntry?.[1] ?? null,
      price: offerSummary.price,
      availability: offerSummary.availability,
      // VTEX's SKU ID is a merchant-internal identifier, not a GTIN or MPN.
      manufacturerIdentifiers: Object.freeze({ gtin: null, mpn: null }),
    });
  }).filter(Boolean));
}

/**
 * SIMAN uses a VTEX storefront. The public Legacy Search API documents
 * exact product-text-link lookup at /api/catalog_system/pub/products/search/{linkText}/p.
 * This adapter queries only the exact slug from an allowlisted Nicaragua product URL.
 * It does not use private Catalog API endpoints or credentials.
 */
export function createSimanResearchProvider({
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  timeoutMs = RETAILER_TIMEOUT_MS,
  cacheTtlMs = 2 * 60_000,
  minRequestIntervalMs = 750,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const safeFetch = async (input, init) => {
    const requested = new URL(String(input));
    const exactSearchPath =
      /^\/api\/catalog_system\/pub\/products\/search\/[a-z0-9-]+\/p$/u.test(requested.pathname);
    const exactVariantsPath =
      /^\/api\/catalog_system\/pub\/products\/variations\/\d+$/u.test(requested.pathname);
    if (requested.origin !== "https://ni.siman.com" ||
        (!exactSearchPath && !exactVariantsPath)) {
      throw new TypeError("SIMAN VTEX reader rejected a non-public or non-exact storefront endpoint");
    }
    const response = await fetchImpl(input, init);
    if (response?.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.origin !== requested.origin ||
          finalUrl.pathname !== requested.pathname ||
          finalUrl.search !== requested.search) {
        throw new Error("SIMAN VTEX request redirected outside its exact public endpoint allowlist");
      }
    }
    if (!response || response.ok !== true) return response;
    const payload = await response.json();
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      headers: response.headers,
      json: async () => Array.isArray(payload) ? { products: payload } : payload,
    };
  };
  const readJson = createJsonReader(safeFetch, {
    timeoutMs,
    cacheTtlMs,
    maxCacheEntries: 20,
    minRequestIntervalMs,
    requestHeaders: { Accept: "application/json" },
  });

  return Object.freeze({
    id: SIMAN_CONFIG.id,
    domains: Object.freeze([DOMAINS.TECHNOLOGY]),
    async search(request) {
      if (request?.domain && request.domain !== DOMAINS.TECHNOLOGY) {
        throw new TypeError("Almacenes SIMAN provider only supports the technology domain");
      }
      const rawQuery = requireText(request?.query, "query");
      let productUrl;
      try { productUrl = new URL(rawQuery); } catch {
        throw new TypeError("SIMAN query must be the exact HTTPS Nicaragua product URL");
      }
      if (productUrl.protocol !== "https:" || productUrl.hostname !== "ni.siman.com" ||
          productUrl.username || productUrl.password || productUrl.port || productUrl.hash ||
          !SIMAN_CONFIG.pathPattern.test(productUrl.pathname)) {
        throw new TypeError("SIMAN query must be an exact product URL on its approved Nicaragua storefront");
      }

      const field = requireText(request?.field, "field").toLowerCase();
      const supportedFields = new Set([
        "name", "identity", "sku", "upc", "gtin", "mpn", "color", "variants",
        "price", "local_price", "retail_price", "availability", "stock", "warranty",
      ]);
      if (!supportedFields.has(field)) throw new Error("SIMAN provider does not support field: " + field);

      const slug = productUrl.pathname.replace(/\/p\/?$/u, "").split("/").at(-1);
      const endpoint = "https://ni.siman.com/api/catalog_system/pub/products/search/" +
        encodeURIComponent(slug) + "/p";
      const body = await readJson(endpoint, "SIMAN VTEX public product search");
      if (!Array.isArray(body.products)) throw new TypeError("SIMAN VTEX search returned an invalid product list");
      const product = body.products.find(item =>
        typeof item?.linkText === "string" && item.linkText.toLowerCase() === slug.toLowerCase()
      ) ?? (body.products.length === 1 && typeof body.products[0]?.linkText !== "string" ? body.products[0] : null);
      if (!product) return [];

      const items = Array.isArray(product.items) ? product.items : [];
      const offers = items.flatMap(item =>
        (Array.isArray(item?.sellers) ? item.sellers : [])
          .map(seller => seller?.commertialOffer ?? seller?.commercialOffer)
          .filter(offer => offer && typeof offer === "object")
      );
      const prices = [...new Set(offers
        .map(offer => Number(offer.Price))
        .filter(value => Number.isFinite(value) && value > 0)
        .map(value => value.toFixed(2)))];
      const price = prices.length === 1 ? {
        amount: Number(prices[0]),
        currency: "NIO",
        taxIncluded: null,
        display: "C$" + Number(prices[0]).toFixed(2),
        basis: "vtex_public_catalog",
      } : null;

      const quantities = offers.map(offer => Number(offer.AvailableQuantity))
        .filter(value => Number.isFinite(value) && value >= 0);
      const availabilityFlags = offers.map(offer => offer.IsAvailable).filter(value => typeof value === "boolean");
      let availability = null;
      if (quantities.some(value => value > 0) || availabilityFlags.some(value => value === true)) {
        availability = { status: "in_stock" };
        if (quantities.length === offers.length && quantities.every(value => value === quantities[0])) {
          availability.quantity = quantities[0];
        }
      } else if (offers.length > 0 &&
          (quantities.length === offers.length && quantities.every(value => value === 0) ||
           availabilityFlags.length === offers.length && availabilityFlags.every(value => value === false))) {
        availability = { status: "out_of_stock" };
      }

      const singleItem = items.length === 1 ? items[0] : null;
      const references = items.flatMap(item =>
        Array.isArray(item?.referenceId) ? item.referenceId : []);
      const productReferences = [...new Set(references
        .filter(entry => /^(?:refid|sku|c[oó]digo)$/iu.test(String(entry?.Key ?? entry?.Name ?? "")))
        .map(entry => entry?.Value)
        .filter(value => typeof value === "string" && value.trim())
        .map(value => value.trim()))];
      const reference = productReferences.length === 1 ? productReferences[0] : null;
      const sku = reference ?? (typeof singleItem?.itemId === "string" ? singleItem.itemId : null);
      const upc = typeof singleItem?.ean === "string" && singleItem.ean.trim()
        ? singleItem.ean.trim() : null;
      const gtin = upc;
      const modelReferences = references
        .filter(entry => /^(?:mpn|modelo|model)$/iu.test(String(entry?.Key ?? entry?.Name ?? "")))
        .map(entry => entry?.Value)
        .filter(value => typeof value === "string" && value.trim())
        .map(value => value.trim());
      const modelSpecification = uniqueVtexSpecification(
        product, /^(?:modelo|model|n[uú]mero de modelo|model number)$/iu,
      );
      if (modelSpecification) modelReferences.push(modelSpecification);
      const uniqueModels = [...new Set(modelReferences)];
      const mpn = uniqueModels.length === 1 ? uniqueModels[0] : null;
      const color = uniqueVtexSpecification(product, /^(?:color|colour)$/iu);

      let warranty = null;
      for (const group of product.specificationGroups ?? []) {
        for (const specification of group.specifications ?? []) {
          const label = String(specification.name ?? specification.originalName ?? "");
          if (!/garant[ií]a/iu.test(label)) continue;
          const value = Array.isArray(specification.values) ? specification.values.join(" ") : "";
          const match = value.match(/\d+\s*(?:mes(?:es)?|a[nñ]os?)/iu);
          if (match) warranty = match[0];
        }
      }

      let variants = null;
      let variationsEndpoint = null;
      if (field === "variants") {
        const productId = String(product.productId ?? "");
        if (!/^\d+$/u.test(productId) || !Number.isSafeInteger(Number(productId)) ||
            Number(productId) < 1) {
          return [];
        }
        variationsEndpoint =
          "https://ni.siman.com/api/catalog_system/pub/products/variations/" +
          encodeURIComponent(productId);
        const variationData = await readJson(variationsEndpoint, "SIMAN VTEX public SKU variations");
        variants = buildVtexSkuVariants(product, variationData);
      }

      const values = {
        name: product.productName ?? null,
        identity: product.productName ?? null,
        sku,
        upc,
        gtin,
        mpn: typeof mpn === "string" ? mpn : null,
        color,
        variants,
        price,
        local_price: price,
        retail_price: price,
        availability,
        stock: availability,
        warranty,
      };
      const value = values[field];
      if (value === undefined || value === null || value === "") return [];

      const priceField = ["price", "local_price", "retail_price"].includes(field);
      const stockField = ["availability", "stock"].includes(field);
      return [{
        id: typeof product.productId === "string" || typeof product.productId === "number"
          ? String(product.productId) : slug,
        value,
        confidence: priceField || stockField ? 0.86 : 0.8,
        source: {
          name: "Almacenes SIMAN Nicaragua — VTEX public catalog",
          url: productUrl.toString(),
          type: SOURCE_TYPES.DISTRIBUTOR,
          retailer: "Almacenes SIMAN",
          market: "NI",
          references: [
            productUrl.toString(),
            endpoint,
            ...(variationsEndpoint ? [variationsEndpoint] : []),
          ],
        },
        observedAt: isoNow(clock),
        note: priceField
          ? "Price from SIMAN's public VTEX product catalogue, scoped to the Nicaragua storefront. Currency is NIO based on the ni.siman.com market; tax inclusion is not inferred."
          : stockField
            ? "Availability is reported only when VTEX publishes SKU offer quantity or availability. When a product has differently priced variants, aggregate price is withheld rather than guessed."
            : field === "warranty"
              ? "Warranty duration is included only when explicitly published in the VTEX product specification groups."
              : field === "mpn"
                ? "Manufacturer model number is included only when SIMAN explicitly publishes one unique Modelo/Model specification across the exact product record."
                : field === "color"
                  ? "Color is included only when the exact VTEX product record exposes one unambiguous color value across its SKU variants."
                  : field === "variants"
                    ? "Variant records are read from SIMAN's documented public VTEX product-variations endpoint and joined only to exact SKU item IDs from the product response. Merchant SKU IDs are not treated as manufacturer identifiers; missing GTIN/MPN remains missing."
                    : "Product identity and identifiers are read from the exact SIMAN product text-link through the documented public VTEX Search API. Research output remains unconfirmed.",
      }];
    },
  });
}
