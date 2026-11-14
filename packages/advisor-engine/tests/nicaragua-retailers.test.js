import test from "node:test";
import assert from "node:assert/strict";
import { DOMAINS } from "../src/core/domains.js";
import { SOURCE_TYPES } from "../src/core/evidence.js";
import { createSicsaResearchProvider } from "../src/research/nicaragua-retailers.js";

const fixedClock = () => new Date("2026-11-07T22:00:00.000Z");
const slug = "laptop-gaming-msi-crosshair-a16-hx-ingles-16-pulg-amd-ryzen-9-8940hx-16gb-ram-1tb-ssd-rtx-5060-8gb-win-11-d8wfkg-090us-c-gris";
const productHtml = [
  "<!doctype html>",
  "<html><head>",
  "<meta property='og:title' content='Laptop Gaming MSI Crosshair A16 HX | SICSA Nicaragua'>",
  "<meta property='product:price:amount' content='72666.89'>",
  "<meta property='product:price:currency' content='NIO'>",
  "<script type='application/ld+json'>",
  '{"@context":"https://schema.org","@type":"Product","name":"Laptop Gaming MSI Crosshair A16 HX","sku":"LAPT0185","offers":{"@type":"Offer","price":72666.89,"priceCurrency":"NIO","availability":"https://schema.org/InStock"}}',
  "</script></head><body>",
  "<div>Delivery gratis en Managua (casco urbano) por compras mayores a C$5,000. Las entregas pueden tardar hasta 3 días hábiles.</div>",
  "<h1>Laptop Gaming MSI Crosshair A16 HX</h1>",
  "<div class='summary entry-summary'>",
  "<p class='price'><span class='woocommerce-Price-amount'>C$72,666.89</span> + IVA</p>",
  "<p class='stock in-stock'>1 disponibles</p>",
  "<div>Producto SICSA SKU: LAPT0185</div>",
  "</div></body></html>",
].join("\n");

function htmlResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "text/html" },
    text: async () => body,
  };
}

test("SICSA local retailer provider maps exact SKU, NIO price and explicit stock without hiding tax", async () => {
  const calls = [];
  const provider = createSicsaResearchProvider({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return htmlResponse(productHtml);
    },
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });

  const price = await provider.search({ domain: DOMAINS.TECHNOLOGY, query: slug, field: "price" });
  const stock = await provider.search({ domain: DOMAINS.TECHNOLOGY, query: slug, field: "availability" });
  const sku = await provider.search({ domain: DOMAINS.TECHNOLOGY, query: slug, field: "sku" });

  assert.equal(price.length, 1);
  assert.deepEqual(price[0].value, {
    amount: 72666.89,
    currency: "NIO",
    taxIncluded: false,
    display: "C$72,666.89 + IVA",
    basis: "retailer_page",
  });
  assert.deepEqual(stock[0].value, { status: "in_stock", quantity: 1 });
  assert.equal(sku[0].value, "LAPT0185");
  assert.equal(price[0].source.type, SOURCE_TYPES.DISTRIBUTOR);
  assert.equal(price[0].source.market, "NI");
  assert.equal(price[0].source.name, "SICSA Nicaragua");
  assert.match(price[0].source.url, new RegExp(slug, "u"));
  assert.equal(price[0].observedAt, fixedClock().toISOString());
  assert.match(price[0].note, /not a tax-inclusive landed price/u);
  assert.equal(calls.length, 1, "same exact product page should be cached across field lookups");
  assert.equal(calls[0].init.method, "GET");
  assert.match(calls[0].init.headers.Accept, /text\/html/u);
});

test("SICSA delivery policy is retained as a sitewide notice, not a product shipping quote", async () => {
  const provider = createSicsaResearchProvider({
    fetchImpl: async () => htmlResponse(productHtml),
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const result = await provider.search({ domain: DOMAINS.TECHNOLOGY, query: slug, field: "shipping_policy" });
  assert.equal(result.length, 1);
  assert.match(result[0].value, /Delivery gratis en Managua/u);
  assert.match(result[0].value, /C\$5,000/u);
  assert.match(result[0].value, /3 días hábiles/u);
  assert.match(result[0].note, /sitewide delivery banner/u);
});

test("SICSA does not infer missing product price or stock and rejects unsafe lookup input", async () => {
  const provider = createSicsaResearchProvider({
    fetchImpl: async () => htmlResponse("<html><body><h1>Example product</h1></body></html>"),
    minRequestIntervalMs: 0,
  });
  assert.deepEqual(await provider.search({ query: slug, field: "price" }), []);
  assert.deepEqual(await provider.search({ query: slug, field: "availability" }), []);
  await assert.rejects(
    () => provider.search({ query: "https://evil.example/product", field: "price" }),
    /exact product slug/u,
  );
  await assert.rejects(
    () => provider.search({ query: slug, field: "warranty" }),
    /does not support field/u,
  );
  await assert.rejects(
    () => provider.search({ domain: DOMAINS.FRAGRANCE, query: slug, field: "price" }),
    /technology domain/u,
  );
});

test("SICSA HTML reader times out while waiting for the response body", async () => {
  const provider = createSicsaResearchProvider({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: () => new Promise(() => {}),
    }),
    timeoutMs: 10,
    minRequestIntervalMs: 0,
  });
  await assert.rejects(
    () => provider.search({ query: slug, field: "name" }),
    /timed out after 10 ms/u,
  );
});


test("SICSA fallback extracts a visible NIO price from the primary product section without price CSS classes", async () => {
  const html = [
    "<html><body>",
    "<h1>Example laptop</h1>",
    "<div>C$12,345.67 + IVA</div>",
    "<div>2 disponibles</div>",
    "</body></html>",
  ].join("");
  const provider = createSicsaResearchProvider({
    fetchImpl: async () => htmlResponse(html),
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const price = await provider.search({ query: slug, field: "price" });
  const stock = await provider.search({ query: slug, field: "availability" });
  assert.deepEqual(price[0].value, {
    amount: 12345.67,
    currency: "NIO",
    taxIncluded: false,
    display: "C$12,345.67 + IVA",
    basis: "retailer_page",
  });
  assert.deepEqual(stock[0].value, { status: "in_stock", quantity: 2 });
});


test("SICSA falls back to the visible local price when structured price text is malformed", async () => {
  const html = [
    "<html><head>",
    "<script type='application/ld+json'>",
    '{"@type":"Product","name":"Example laptop","sku":"LAPT0185","offers":{"price":"C$72,666.89","priceCurrency":"NIO"}}',
    "</script></head><body>",
    "<h1>Example laptop</h1>",
    "<p>C$72,666.89 + IVA</p>",
    "</body></html>",
  ].join("");
  const provider = createSicsaResearchProvider({
    fetchImpl: async () => htmlResponse(html),
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const result = await provider.search({ query: slug, field: "price" });
  assert.equal(result.length, 1);
  assert.equal(result[0].value.amount, 72666.89);
  assert.equal(result[0].value.currency, "NIO");
  assert.equal(result[0].value.taxIncluded, false);
});


test("SICSA extracts SKU labels with or without a colon", async () => {
  const html = [
    "<html><body>",
    "<h1>Example laptop</h1>",
    "<p>Producto SICSA SKU LAPT0185</p>",
    "<p>C$72,666.89 + IVA</p>",
    "</body></html>",
  ].join("");
  const provider = createSicsaResearchProvider({
    fetchImpl: async () => htmlResponse(html),
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const result = await provider.search({ query: slug, field: "sku" });
  assert.equal(result[0].value, "LAPT0185");
});


test("SICSA prefers the price scoped to the exact SKU over an unrelated page price widget", async () => {
  const html = [
    "<html><body>",
    "<p class='price'>C$999.00</p>",
    "<p>Producto SICSA SKU: LAPT0185</p>",
    "<h1>Example laptop</h1>",
    "<p>C$72,666.89 + IVA</p>",
    "</body></html>",
  ].join("");
  const provider = createSicsaResearchProvider({
    fetchImpl: async () => htmlResponse(html),
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const result = await provider.search({ query: slug, field: "price" });
  assert.equal(result[0].value.amount, 72666.89);
  assert.equal(result[0].value.taxIncluded, false);
});
