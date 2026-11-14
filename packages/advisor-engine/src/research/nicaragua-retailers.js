import { DOMAINS } from "../core/domains.js";
import { SOURCE_TYPES } from "../core/evidence.js";
import { requireText, positiveInteger, isoNow, decodeHtml, stripHtml, readMeta, collectJsonLdProducts } from "./nicaragua-retailer-utils.js";

const SICSA_BASE = "https://sicsa.com.ni";
const DEFAULT_TIMEOUT_MS = 12_000;

function firstOffer(product) {
  const offers = product?.offers;
  return Array.isArray(offers) ? offers[0] : offers;
}

function parseSicsaPage(html) {
  if (typeof html !== "string" || !html.trim()) throw new TypeError("SICSA returned an empty product page");
  const products = collectJsonLdProducts(html);
  const product = products[0] ?? {};
  const offer = firstOffer(product) ?? {};
  const pageText = stripHtml(html);
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1];
  const name = product.name ?? readMeta(html, "og:title") ?? stripHtml(h1);
  const skuMatch = pageText.match(/\bSKU\b\s*:?\s*([A-Z0-9_-]+)/iu);
  const sku = product.sku ?? skuMatch?.[1] ?? null;

  const priceContainer = html.match(
    /<(p|div|span)\b(?=[^>]*class=["'][^"']*\bprice\b[^"']*["'])[^>]*>([\s\S]*?)<\/\1>/iu,
  )?.[2] ?? "";
  const priceText = stripHtml(priceContainer);
  const productSectionHtml = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>([\s\S]{0,3000})/iu)?.[1] ?? "";
  const productSectionText = stripHtml(productSectionHtml);
  const skuIndex = sku ? pageText.toLowerCase().indexOf(String(sku).toLowerCase()) : -1;
  const nameIndex = typeof name === "string"
    ? pageText.toLowerCase().indexOf(stripHtml(name).toLowerCase()) : -1;
  const productStart = skuIndex >= 0 ? skuIndex : nameIndex;
  const productText = productStart >= 0
    ? pageText.slice(productStart, productStart + 1800) : productSectionText;
  const visibleProductPrice = productText.match(
    /(?:C\$\s*[\d,]+(?:\.\d{1,2})?|NIO\s*[\d,]+(?:\.\d{1,2})?)(?:\s*\+\s*IVA)?/iu,
  )?.[0] ?? "";
  const effectivePriceText = visibleProductPrice || priceText;
  const metaAmount = readMeta(html, "product:price:amount") ?? readMeta(html, "og:price:amount");
  const visibleAmount = effectivePriceText.match(
    /(?:C\$|NIO\s*)\s*([\d,]+(?:\.\d{1,2})?)/iu,
  )?.[1] ?? null;
  const amountCandidates = [offer.price, metaAmount, visibleAmount];
  const amount = amountCandidates.map(candidate => {
    if (typeof candidate === "number") return candidate;
    if (typeof candidate !== "string" || !candidate.trim()) return NaN;
    return Number(candidate.replace(/(?:C\$|NIO)/giu, "").replace(/,/gu, "").trim());
  }).find(candidate => Number.isFinite(candidate) && candidate >= 0) ?? NaN;
  const explicitLocalCurrency = /C\$/iu.test(effectivePriceText) || /\bNIO\b/iu.test(effectivePriceText);
  const rawCurrency = explicitLocalCurrency
    ? "NIO"
    : offer.priceCurrency ?? readMeta(html, "product:price:currency");
  const currency = typeof rawCurrency === "string" && rawCurrency.trim()
    ? (rawCurrency.toUpperCase() === "C$" ? "NIO" : rawCurrency.toUpperCase()) : null;
  const displayPrice = effectivePriceText || (Number.isFinite(amount) ? currency + " " + String(amount) : "");
  const taxExclusive = /\+\s*IVA\b/iu.test(effectivePriceText);

  const stockText = stripHtml(
    html.match(/<(p|div|span)\b(?=[^>]*class=["'][^"']*\bstock\b[^"']*["'])[^>]*>([\s\S]*?)<\/\1>/iu)?.[2] ?? "",
  );
  const stockScope = stockText || productText;
  const quantityMatch = stockScope.match(/\b(\d+)\s*(?:disponibles?|available)\b/iu);
  const availabilityUrl = String(offer.availability ?? "").toLowerCase();
  let availability = null;
  if (quantityMatch) {
    availability = { status: "in_stock", quantity: Number(quantityMatch[1]) };
  } else if (/\b(?:outofstock|soldout)\b/u.test(availabilityUrl) ||
      /\b(?:agotado|sin existencias|out of stock)\b/iu.test(stockText)) {
    availability = { status: "out_of_stock" };
  } else if (/\binstock\b/u.test(availabilityUrl) ||
      /\b(?:hay existencias|en existencia|in stock)\b/iu.test(stockText)) {
    availability = { status: "in_stock" };
  }

  const shippingMatch = pageText.match(
    /Delivery gratis en Managua(?:\s*\([^)]*\))?\s*por compras mayores a\s*C\$\s*[\d,.]+\.?\s*Las entregas pueden tardar hasta\s*\d+\s*d[ií]as h[aá]biles\.?/iu,
  );

  return {
    name: typeof name === "string" && name.trim() ? stripHtml(name) : null,
    sku: typeof sku === "string" && sku.trim() ? sku.trim() : null,
    price: Number.isFinite(amount) && amount >= 0 && currency
      ? {
          amount,
          currency,
          taxIncluded: taxExclusive ? false : null,
          display: displayPrice,
          basis: "retailer_page",
        }
      : null,
    availability,
    shippingPolicy: shippingMatch?.[0] ?? null,
  };
}

function createHtmlReader(fetchImpl, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheTtlMs = 3 * 60_000,
  minRequestIntervalMs = 500,
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

  return async function readHtml(url) {
    const cached = cache.get(url);
    if (cached && cached.expiresAt > Date.now()) return cached.body;
    if (cached) cache.delete(url);

    const waitMs = Math.max(0, minRequestIntervalMs - (Date.now() - lastRequestAt));
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let rejectTimeout;
    const timeoutPromise = new Promise((resolve, reject) => { rejectTimeout = reject; });
    const timeoutError = new Error("SICSA product page timed out after " + timeoutMs + " ms");
    const timer = setTimeout(() => {
      controller?.abort();
      rejectTimeout(timeoutError);
    }, timeoutMs);
    try {
      const response = await Promise.race([fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "JB Advisor Engine/0.1 (+https://github.com/JASBH121101/TECH-PERFUMS-ADVISE)",
        },
        ...(controller ? { signal: controller.signal } : {}),
      }), timeoutPromise]);
      lastRequestAt = Date.now();
      if (!response || response.ok !== true) {
        throw new Error("SICSA product page request failed with HTTP " + (response?.status ?? "unknown"));
      }
      const body = await Promise.race([response.text(), timeoutPromise]);
      if (typeof body !== "string" || body.length === 0 || body.length > 3000_000) {
        throw new TypeError("SICSA returned an invalid product page");
      }
      if (cacheTtlMs > 0) cache.set(url, { body, expiresAt: Date.now() + cacheTtlMs });
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

/**
 * Read-only exact-product provider for SICSA Nicaragua.
 * Queries must be the product slug from sicsa.com.ni/producto/{slug}/.
 * It does not crawl/search the catalogue or infer warranty, landed price or shipping cost.
 */
export function createSicsaResearchProvider({
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheTtlMs = 3 * 60_000,
  minRequestIntervalMs = 500,
} = {}) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const readHtml = createHtmlReader(fetchImpl, { timeoutMs, cacheTtlMs, minRequestIntervalMs });

  return Object.freeze({
    id: "sicsa-nicaragua-retail",
    domains: Object.freeze([DOMAINS.TECHNOLOGY]),
    async search(request) {
      if (request?.domain && request.domain !== DOMAINS.TECHNOLOGY) {
        throw new TypeError("SICSA provider only supports the technology domain");
      }
      const query = requireText(request?.query, "query").replace(/^sicsa:/iu, "");
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(query)) {
        throw new TypeError("SICSA query must be an exact product slug from sicsa.com.ni/producto/{slug}/");
      }
      const field = requireText(request?.field, "field").toLowerCase();
      const supportedFields = new Set([
        "name", "identity", "sku", "price", "local_price", "retail_price",
        "availability", "stock", "shipping_policy", "delivery_policy",
      ]);
      if (!supportedFields.has(field)) throw new Error("SICSA provider does not support field: " + field);

      const url = SICSA_BASE + "/producto/" + encodeURIComponent(query) + "/";
      const product = parseSicsaPage(await readHtml(url));
      const fieldValues = {
        name: product.name,
        identity: product.name,
        sku: product.sku,
        price: product.price,
        local_price: product.price,
        retail_price: product.price,
        availability: product.availability,
        stock: product.availability,
        shipping_policy: product.shippingPolicy,
        delivery_policy: product.shippingPolicy,
      };
      const value = fieldValues[field];
      if (value === undefined || value === null || value === "") return [];

      const priceField = ["price", "local_price", "retail_price"].includes(field);
      const stockField = ["availability", "stock"].includes(field);
      const policyField = ["shipping_policy", "delivery_policy"].includes(field);
      return [{
        id: query,
        value,
        confidence: priceField || stockField ? 0.86 : 0.78,
        source: {
          name: "SICSA Nicaragua",
          url,
          type: SOURCE_TYPES.DISTRIBUTOR,
          retailer: "SICSA",
          market: "NI",
          references: [url],
        },
        observedAt: isoNow(clock),
        note: priceField
          ? "Local retailer page price in Nicaraguan córdobas. The displayed price is marked + IVA where shown; it is not a tax-inclusive landed price. Confirm taxes, shipping and payment conditions at checkout."
          : stockField
            ? "Stock is captured only when an explicit quantity or availability label is present on the product page. Inventory can change; confirm with SICSA before purchase."
            : policyField
              ? "This is the retailer's sitewide delivery banner, not a guaranteed shipping quote for this product or destination. Confirm delivery cost and eligibility at checkout."
              : "Exact retailer product identity from SICSA Nicaragua. Confirm SKU, product configuration and current listing before purchase.",
      }];
    },
  });
}
