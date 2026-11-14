import { DOMAINS } from "../core/domains.js";
import { SOURCE_TYPES } from "../core/evidence.js";
import { requireText, positiveInteger, isoNow, stripHtml, readMeta, collectJsonLdProducts } from "./nicaragua-retailer-utils.js";

const RETAILER_TIMEOUT_MS = 12_000;

/**
 * Nicaragua retailer pages are read-only evidence sources, not official APIs.
 * Each lookup requires the exact product URL from the retailer's own domain.
 */
const RETAILER_CONFIGS = Object.freeze({
  radioshack: Object.freeze({
    id: "radioshack-nicaragua-retail",
    name: "RadioShack Nicaragua",
    retailer: "RadioShack",
    hostname: "www.radioshackla.com",
    pathPattern: /^\/nicaragua\/[a-z0-9-]+\/p\/?$/u,
    fields: Object.freeze([
      "name", "identity", "sku", "upc", "gtin", "mpn", "color",
      "price", "local_price", "retail_price", "availability", "stock", "warranty",
    ]),
  }),
  laCuracao: Object.freeze({
    id: "la-curacao-nicaragua-retail",
    name: "La Curacao Nicaragua",
    retailer: "La Curacao",
    hostname: "www.lacuracaonline.com",
    pathPattern: /^\/nicaragua\/[a-z0-9-]+\/p\/?$/u,
    fields: Object.freeze([
      "name", "identity", "sku", "upc", "gtin", "mpn", "color",
      "price", "local_price", "retail_price", "availability", "stock", "warranty",
    ]),
  }),
  elGallo: Object.freeze({
    id: "el-gallo-mas-gallo-nicaragua-retail",
    name: "El Gallo Más Gallo Nicaragua",
    retailer: "El Gallo Más Gallo",
    hostname: "www.elgallomasgallo.com.ni",
    pathPattern: /^\/[a-z0-9-]+-\d+\/?$/u,
    fields: Object.freeze([
      "name", "identity", "sku", "upc", "gtin", "mpn", "color",
      "price", "local_price", "retail_price", "availability", "stock", "warranty",
    ]),
  }),
  siman: Object.freeze({
    id: "siman-nicaragua-retail",
    name: "Almacenes SIMAN Nicaragua",
    retailer: "Almacenes SIMAN",
    hostname: "ni.siman.com",
    pathPattern: /^\/[a-z0-9-]+\/p\/?$/u,
    fields: Object.freeze([
      "name", "identity", "sku", "upc", "gtin", "mpn", "color",
      "price", "local_price", "retail_price", "availability", "stock", "warranty",
    ]),
  }),
  elVerdugo: Object.freeze({
    id: "el-verdugo-nicaragua-catalog",
    name: "El Verdugo Nicaragua",
    retailer: "El Verdugo",
    hostname: "catalogoni.elverdugo.net",
    pathPattern: /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/u,
    fields: Object.freeze(["name", "identity", "sku", "warranty"]),
  }),
});



function retailerJsonLdProducts(html) {
  return collectJsonLdProducts(html);
}

function firstProductOffer(product) {
  const offers = product?.offers;
  if (Array.isArray(offers)) return offers.find(offer => offer && offer.price !== undefined) ?? offers[0] ?? {};
  return offers ?? {};
}

function parseRetailerCurrency(text, offer, product) {
  if (/(?:C\$|\bNIO\b)/iu.test(text)) return "NIO";
  if (/\bUS\$\s*|\bUSD\b/iu.test(text)) return "USD";
  const currency = offer?.priceCurrency ?? product?.priceCurrency ?? null;
  return typeof currency === "string" && /^[A-Z]{3}$/u.test(currency.toUpperCase())
    ? currency.toUpperCase() : null;
}

function detectRetailerColor(value) {
  const match = String(value ?? "").match(/\b(negro|negra|black|gris|gray|grey|azul|blue|celeste|blanco|blanca|white|rojo|roja|red|verde|green|rosa|rosado|pink|morado|purpura|púrpura|violeta|silver|plata|dorado|gold)\b/iu);
  return match?.[1] ?? null;
}

function parseRetailerAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[^\d,.]/gu, "").replace(/,/gu, "");
  if (!normalized || !/^\d+(?:\.\d{1,2})?$/u.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function parseRetailerProductPage(html) {
  if (typeof html !== "string" || !html.trim()) {
    throw new TypeError("Retailer returned an empty product page");
  }
  const products = retailerJsonLdProducts(html);
  const product = products[0] ?? {};
  const offer = firstProductOffer(product);
  const pageText = stripHtml(html);
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1];
  const h1Text = stripHtml(h1);
  const titleMeta = readMeta(html, "og:title") ?? readMeta(html, "twitter:title");
  const name = product.name || h1Text || titleMeta || null;
  const nameText = typeof name === "string" ? stripHtml(name) : "";
  const titleIndex = h1Text ? pageText.toLowerCase().indexOf(h1Text.toLowerCase()) : -1;
  const nameIndex = nameText ? pageText.toLowerCase().indexOf(nameText.toLowerCase()) : -1;
  const start = titleIndex >= 0 ? titleIndex : nameIndex;
  const productText = start >= 0 ? pageText.slice(start, start + 20_000) : pageText.slice(0, 5_000);
  // Retailers such as El Gallo publish SKU/availability badges immediately before the H1.
  // Include only a bounded pre-title context when extracting labelled identifiers.
  const identityText = start >= 0
    ? pageText.slice(Math.max(0, start - 1_200), start + 20_000)
    : productText;

  const identifier = label => identityText.match(
    new RegExp("\\b" + label + "\\b\\s*(?::|\\|)?\\s*([A-Z0-9_-]+)", "iu"),
  )?.[1] ?? null;
  const sku = product.sku ?? product.productID ?? identifier("SKU");
  const upc = product.gtin12 ?? identifier("UPC");
  const gtin = product.gtin13 ?? product.gtin14 ?? product.gtin12 ??
    identifier("GTIN") ?? identifier("EAN");
  const mpn = product.mpn ?? identifier("MPN") ?? identifier("Modelo") ?? identifier("Model");
  const color = product.color ?? identifier("Color") ?? detectRetailerColor(nameText);

  const saleMatch = productText.match(
    /precio\s+(?:especial|promocional|de\s+oferta)\s*:?\s*((?:C\$|NIO|US\$|USD)\s*[\d,.]+)/iu,
  );
  const visiblePriceMatch = productText.match(
    /((?:C\$|NIO|US\$|USD)\s*[\d,]+(?:\.\d{1,2})?)/iu,
  );
  const visiblePrice = saleMatch?.[1] ?? visiblePriceMatch?.[1] ?? "";
  const metaAmount = readMeta(html, "product:price:amount") ??
    readMeta(html, "og:price:amount") ??
    readMeta(html, "price");
  const amount = parseRetailerAmount(visiblePrice) ??
    parseRetailerAmount(metaAmount) ??
    parseRetailerAmount(offer.price);
  const currency = parseRetailerCurrency(visiblePrice || productText, offer, product);
  const taxIncluded = /\+\s*IVA\b/iu.test(productText)
    ? false
    : /\bIVA\s+incluido\b/iu.test(productText) ? true : null;
  const price = amount !== null && currency
    ? {
        amount,
        currency,
        taxIncluded,
        display: visiblePrice || (currency + " " + String(amount)),
        basis: "retailer_product_page",
      }
    : null;

  const availabilityValue = String(offer.availability ?? "").toLowerCase();
  const quantityMatch = productText.match(/\b(\d+)\s*(?:unidades?\s*)?disponibles?\b/iu);
  let availability = null;
  if (quantityMatch) {
    availability = { status: "in_stock", quantity: Number(quantityMatch[1]) };
  } else {
    const productContext = pageText.slice(
      Math.max(0, start >= 0 ? start - 500 : 0),
      Math.min(pageText.length, (start >= 0 ? start : 0) + 1_500),
    );
    if (/schema\.org\/(?:outofstock|soldout|discontinued)|\b(?:agotado|sin existencias|out of stock)\b/iu.test(
      availabilityValue + " " + productContext,
    )) {
      availability = { status: "out_of_stock" };
    } else if (/schema\.org\/(?:instock|limitedavailability)|\b(?:en stock|disponible|hay existencias|in stock)\b/iu.test(
      availabilityValue + " " + productContext,
    )) {
      availability = { status: "in_stock" };
    }
  }

  const warrantyMatch = productText.match(
    /garant[ií]a(?:\s+del\s+proveedor)?\s*(?::|\|)?\s*(\d+\s*(?:mes(?:es)?|a[nñ]os?))/iu,
  );

  return {
    name: nameText || null,
    sku: typeof sku === "string" && sku.trim() ? sku.trim() : null,
    upc: typeof upc === "string" ? upc : null,
    gtin: typeof gtin === "string" ? gtin : null,
    mpn: typeof mpn === "string" ? mpn : null,
    color: typeof color === "string" ? color.trim() : null,
    price,
    availability,
    warranty: warrantyMatch?.[1]?.trim() ?? null,
  };
}

function createRetailerPageReader(fetchImpl, {
  timeoutMs = RETAILER_TIMEOUT_MS,
  cacheTtlMs = 2 * 60_000,
  minRequestIntervalMs = 750,
  hostname,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  positiveInteger(timeoutMs, "timeoutMs", 60_000);
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0) {
    throw new TypeError("cacheTtlMs must be a non-negative integer");
  }
  if (!Number.isSafeInteger(minRequestIntervalMs) || minRequestIntervalMs < 0 || minRequestIntervalMs > 10_000) {
    throw new TypeError("minRequestIntervalMs must be between 0 and 10000");
  }
  const cache = new Map();
  let lastRequestAt = 0;

  return async function readPage(url) {
    const key = url.toString();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.body;
    if (cached) cache.delete(key);

    const waitMs = Math.max(0, minRequestIntervalMs - (Date.now() - lastRequestAt));
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let rejectTimeout;
    const timeoutPromise = new Promise((resolve, reject) => { rejectTimeout = reject; });
    const timeoutError = new Error("Retailer product page timed out after " + timeoutMs + " ms");
    const timer = setTimeout(() => {
      controller?.abort();
      rejectTimeout(timeoutError);
    }, timeoutMs);

    try {
      const requestOptions = {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "JB Advisor Engine/0.1 (+https://github.com/JASBH121101/TECH-PERFUMS-ADVISE)",
        },
        ...(controller ? { signal: controller.signal } : {}),
      };
      let response;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await Promise.race([fetchImpl(key, requestOptions), timeoutPromise]);
          break;
        } catch (error) {
          const diagnostic = [
            error?.message,
            error?.cause?.code,
            error?.cause?.message,
          ].filter(Boolean).join(" ");
          const transientNetworkFailure = /fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/iu.test(diagnostic);
          if (attempt !== 0 || !transientNetworkFailure || controller?.signal.aborted) throw error;
          await new Promise(resolve => setTimeout(resolve, 350));
        }
      }
      lastRequestAt = Date.now();
      if (!response || response.ok !== true) {
        throw new Error("Retailer product page request failed with HTTP " + (response?.status ?? "unknown"));
      }
      if (response.url) {
        const finalUrl = new URL(response.url);
        if (finalUrl.protocol !== "https:" || finalUrl.hostname !== hostname) {
          throw new Error("Retailer product page redirected outside its approved host");
        }
      }
      const body = await Promise.race([response.text(), timeoutPromise]);
      if (typeof body !== "string" || body.length === 0 || body.length > 3_000_000) {
        throw new TypeError("Retailer returned an invalid product page");
      }
      if (cacheTtlMs > 0) cache.set(key, { body, expiresAt: Date.now() + cacheTtlMs });
      while (cache.size > 20) cache.delete(cache.keys().next().value);
      return body;
    } catch (error) {
      if (controller?.signal.aborted || error === timeoutError) throw timeoutError;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

function createNicaraguaRetailerProductProvider(config, {
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  timeoutMs = RETAILER_TIMEOUT_MS,
  cacheTtlMs = 2 * 60_000,
  minRequestIntervalMs = 750,
} = {}) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const readPage = createRetailerPageReader(fetchImpl, {
    timeoutMs, cacheTtlMs, minRequestIntervalMs, hostname: config.hostname,
  });
  const supportedFields = new Set(config.fields);

  return Object.freeze({
    id: config.id,
    domains: Object.freeze([DOMAINS.TECHNOLOGY]),
    async search(request) {
      if (request?.domain && request.domain !== DOMAINS.TECHNOLOGY) {
        throw new TypeError(config.name + " provider only supports the technology domain");
      }
      const rawQuery = requireText(request?.query, "query");
      let url;
      try { url = new URL(rawQuery); } catch {
        throw new TypeError(config.name + " query must be the exact HTTPS product URL");
      }
      if (url.protocol !== "https:" || url.hostname !== config.hostname ||
          url.username || url.password || url.port || url.hash ||
          !config.pathPattern.test(url.pathname)) {
        throw new TypeError(config.name + " query must be an exact product URL on its approved Nicaragua storefront");
      }
      const field = requireText(request?.field, "field").toLowerCase();
      if (!supportedFields.has(field)) {
        throw new Error(config.name + " provider does not support field: " + field);
      }

      const product = parseRetailerProductPage(await readPage(url));
      const value = ({
        name: product.name,
        identity: product.name,
        sku: product.sku,
        upc: product.upc,
        gtin: product.gtin,
        mpn: product.mpn,
        color: product.color,
        price: product.price,
        local_price: product.price,
        retail_price: product.price,
        availability: product.availability,
        stock: product.availability,
        warranty: product.warranty,
      })[field];
      if (value === undefined || value === null || value === "") return [];

      const priceField = ["price", "local_price", "retail_price"].includes(field);
      const stockField = ["availability", "stock"].includes(field);
      return [{
        id: url.pathname.replace(/\/+$/u, "").split("/").at(-1),
        value,
        confidence: priceField || stockField ? 0.86 : 0.8,
        source: {
          name: config.name,
          url: url.toString(),
          type: SOURCE_TYPES.DISTRIBUTOR,
          retailer: config.retailer,
          market: "NI",
          references: [url.toString()],
        },
        observedAt: isoNow(clock),
        note: priceField
          ? "Price extracted from the retailer's exact product page in the displayed currency. Tax inclusion is marked only when the page states it explicitly; confirm the final amount at checkout."
          : stockField
            ? "Availability is included only when the exact product page explicitly publishes a stock label or quantity. Inventory may change; confirm before purchase."
            : field === "warranty"
              ? "Warranty duration is copied only when explicitly displayed on the exact product page; coverage conditions and exclusions are not inferred."
              : "Product identity comes from the retailer's exact product page. Confirm the exact model, configuration and listing before purchase.",
      }];
    },
  });
}

export function createRadioShackResearchProvider(options = {}) {
  return createNicaraguaRetailerProductProvider(RETAILER_CONFIGS.radioshack, options);
}

export function createLaCuracaoResearchProvider(options = {}) {
  return createNicaraguaRetailerProductProvider(RETAILER_CONFIGS.laCuracao, options);
}

export function createElGalloMasGalloResearchProvider(options = {}) {
  return createNicaraguaRetailerProductProvider(RETAILER_CONFIGS.elGallo, options);
}

export function createElVerdugoResearchProvider(options = {}) {
  return createNicaraguaRetailerProductProvider(RETAILER_CONFIGS.elVerdugo, options);
}

/**
 * Public implementation status for the six requested Nicaragua retailers.
 * This is capability metadata, not a claim that every site's live endpoint
 * passed its latest smoke run.
 */
export const NICARAGUA_RETAILER_INTEGRATION_STATUS = Object.freeze([
  Object.freeze({
    id: "radioshack",
    name: "RadioShack Nicaragua",
    mode: "exact-product-page",
    status: "page-adapter-implemented",
    officialApi: false,
    note: "Read-only extraction from exact product pages; no official API is assumed.",
  }),
  Object.freeze({
    id: "la-curacao",
    name: "La Curacao Nicaragua",
    mode: "exact-product-page",
    status: "page-adapter-implemented",
    officialApi: false,
    note: "Read-only extraction from the Nicaragua storefront; no official API is assumed.",
  }),
  Object.freeze({
    id: "el-gallo-mas-gallo",
    name: "El Gallo Más Gallo Nicaragua",
    mode: "exact-product-page",
    status: "page-adapter-implemented",
    officialApi: false,
    note: "Read-only extraction from exact product pages; no official API is assumed.",
  }),
  Object.freeze({
    id: "siman",
    name: "Almacenes SIMAN Nicaragua",
    mode: "exact-product-page",
    status: "page-adapter-implemented",
    officialApi: false,
    note: "Uses VTEX public exact-product Search API plus the documented public product-variations endpoint for SKU-level dimensions; no private credentials or private Catalog endpoints.",
  }),
  Object.freeze({
    id: "el-verdugo",
    name: "El Verdugo Nicaragua",
    mode: "catalog-product-page",
    status: "identity-and-warranty-only",
    officialApi: false,
    note: "Price and stock are deliberately unsupported until current local price and inventory can be verified.",
  }),
  Object.freeze({
    id: "conico",
    name: "CONICO Nicaragua",
    mode: "manual-quote-pending",
    status: "no-automated-catalog-verified",
    officialApi: null,
    note: "No stable public product catalogue or API was verified. Vendor quotation/proforma must be reviewed manually.",
  }),
]);
