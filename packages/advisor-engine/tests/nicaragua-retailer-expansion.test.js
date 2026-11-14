import test from "node:test";
import assert from "node:assert/strict";
import { DOMAINS } from "../src/core/domains.js";
import { SOURCE_TYPES } from "../src/core/evidence.js";
import {
  createRadioShackResearchProvider,
  createLaCuracaoResearchProvider,
  createElGalloMasGalloResearchProvider,
  createElVerdugoResearchProvider,
  NICARAGUA_RETAILER_INTEGRATION_STATUS,
} from "../src/research/nicaragua-retailer-pages.js";
import { createSimanResearchProvider } from "../src/research/siman-vtex.js";

const fixedClock = () => new Date("2026-11-08T00:00:00.000Z");

function productPage({
  name = "Samsung A17 4GB + 128GB Gris",
  sku = "470890800019",
  price = "C$7,399.00",
  stock = "En stock",
  warranty = "Garantía del proveedor: 12 Meses",
  availability = "https://schema.org/InStock",
} = {}) {
  const record = {
    "@context": "https://schema.org",
    "@type": "Product",
    name,
    sku,
    offers: { "@type": "Offer", price: Number(price.replace(/[^\d.]/gu, "")), priceCurrency: "NIO", availability },
  };
  return [
    "<!doctype html><html><head>",
    "<meta property='og:title' content='" + name + "'>",
    "<script type='application/ld+json'>" + JSON.stringify(record) + "</script>",
    "</head><body>",
    "<h1>" + name + "</h1>",
    "<div>Precio habitual C$11,000.00 Precio especial " + price + "</div>",
    "<div>" + stock + "</div>",
    "<div>SKU: " + sku + "</div>",
    "<div>" + warranty + "</div>",
    "</body></html>",
  ].join("");
}

function htmlResponse(body, url, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => "text/html" },
    text: async () => body,
  };
}

const cases = [
  {
    label: "RadioShack",
    factory: createRadioShackResearchProvider,
    url: "https://www.radioshackla.com/nicaragua/celular-samsung-a17-128-gb-6-7-470890800019-gris/p",
  },
  {
    label: "La Curacao",
    factory: createLaCuracaoResearchProvider,
    url: "https://www.lacuracaonline.com/nicaragua/samsung-galaxy-a17-128gb/p",
  },
  {
    label: "El Gallo Más Gallo",
    factory: createElGalloMasGalloResearchProvider,
    url: "https://www.elgallomasgallo.com.ni/laptop-dell-core-i5-1334u-dc15250-x5nh3-201116",
  },
];

for (const item of cases) {
  test(item.label + " exact product-page adapter extracts source-backed identity, NIO price and stock", async () => {
    const calls = [];
    const provider = item.factory({
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return htmlResponse(productPage(), String(url));
      },
      clock: fixedClock,
      minRequestIntervalMs: 0,
    });
    const base = { domain: DOMAINS.TECHNOLOGY, query: item.url, limit: 1 };
    const name = await provider.search({ ...base, field: "name" });
    const sku = await provider.search({ ...base, field: "sku" });
    const price = await provider.search({ ...base, field: "price" });
    const stock = await provider.search({ ...base, field: "availability" });
    assert.equal(name[0].value, "Samsung A17 4GB + 128GB Gris");
    assert.equal(sku[0].value, "470890800019");
    assert.deepEqual(price[0].value, {
      amount: 7399,
      currency: "NIO",
      taxIncluded: null,
      display: "C$7,399.00",
      basis: "retailer_product_page",
    });
    assert.deepEqual(stock[0].value, { status: "in_stock" });
    assert.equal(price[0].source.type, SOURCE_TYPES.DISTRIBUTOR);
    assert.equal(price[0].source.market, "NI");
    assert.equal(price[0].source.url, item.url);
    assert.equal(price[0].observedAt, fixedClock().toISOString());
    assert.equal(calls.length, 1, "same product page is cached across field reads");
    assert.equal(calls[0].init.method, "GET");
  });
}



function jsonResponse(body, url, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => "application/json" },
    json: async () => body,
  };
}

test("SIMAN uses the documented public VTEX exact-product search and extracts NIO price and SKU stock", async () => {
  const url = "https://ni.siman.com/celular-samsung-galaxy-a17-128gb-4gb-ram-pantalla-6-7---17-02-cm--octa-core-camara-trasera-triple-50mp-/p";
  const slug = new URL(url).pathname.replace(/\/p\/?$/u, "").split("/").at(-1);
  const calls = [];
  const provider = createSimanResearchProvider({
    fetchImpl: async (requestUrl, init) => {
      calls.push({ url: String(requestUrl), init });
      return jsonResponse([{
        productId: "105067545",
        productName: "Celular Samsung Galaxy A17 128GB 4GB RAM",
        productReference: "105067545",
        linkText: slug,
        items: [{
          itemId: "8806097667995",
          name: "Celular Samsung Galaxy A17 128GB",
          ean: "8806097667995",
          referenceId: [{ Key: "RefId", Value: "105067545" }],
          sellers: [{
            sellerId: "1",
            commertialOffer: { Price: 7999, ListPrice: 9999, AvailableQuantity: 3, IsAvailable: true },
          }],
        }],
        specificationGroups: [{
          specifications: [
            { name: "Garantía del proveedor", values: ["12 meses"] },
            { name: "Modelo", values: ["SM-A175FZKFGTO"] },
            { name: "Color", values: ["Azul"] },
          ],
        }],
      }], String(requestUrl));
    },
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const base = { domain: DOMAINS.TECHNOLOGY, query: url, limit: 1 };
  const name = await provider.search({ ...base, field: "name" });
  const sku = await provider.search({ ...base, field: "sku" });
  const price = await provider.search({ ...base, field: "price" });
  const stock = await provider.search({ ...base, field: "availability" });
  const warranty = await provider.search({ ...base, field: "warranty" });
  const mpn = await provider.search({ ...base, field: "mpn" });
  const color = await provider.search({ ...base, field: "color" });
  assert.equal(name[0].value, "Celular Samsung Galaxy A17 128GB 4GB RAM");
  assert.equal(sku[0].value, "105067545");
  assert.equal(mpn[0].value, "SM-A175FZKFGTO");
  assert.equal(color[0].value, "Azul");
  assert.deepEqual(price[0].value, {
    amount: 7999,
    currency: "NIO",
    taxIncluded: null,
    display: "C$7999.00",
    basis: "vtex_public_catalog",
  });
  assert.deepEqual(stock[0].value, { status: "in_stock", quantity: 3 });
  assert.equal(warranty[0].value, "12 meses");
  assert.equal(price[0].source.market, "NI");
  assert.equal(price[0].source.type, SOURCE_TYPES.DISTRIBUTOR);
  assert.equal(calls.length, 1, "VTEX response is cached across product fields");
  assert.match(calls[0].url, /\/api\/catalog_system\/pub\/products\/search\//u);
  assert.match(calls[0].url, /\/p$/u);
  assert.equal(calls[0].init.method, "GET");
});


test("El Gallo extracts model, SKU, price and availability even when stock label precedes the title", async () => {
  const url = "https://www.elgallomasgallo.com.ni/laptop-dell-core-i5-1334u-dc15250-x5nh3-201116";
  const html = [
    "<html><body>",
    "<div>18% DESCUENTO Disponible SKU 201116</div>",
    "<h1>Laptop Dell Core i5-1334U DC15250 X5NH3</h1>",
    "<div>Precio especial C$26,999 Precio habitual C$32,999</div>",
    "<div>Marca | DELL Modelo | X5NH3 Memoria RAM | 16GB Capacidad de almacenamiento | 512GB</div>",
    "</body></html>",
  ].join("");
  const provider = createElGalloMasGalloResearchProvider({
    fetchImpl: async requestUrl => htmlResponse(html, String(requestUrl)),
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const base = { query: url, domain: DOMAINS.TECHNOLOGY, limit: 1 };
  const [name] = await provider.search({ ...base, field: "name" });
  const [sku] = await provider.search({ ...base, field: "sku" });
  const [mpn] = await provider.search({ ...base, field: "mpn" });
  const [price] = await provider.search({ ...base, field: "price" });
  const [stock] = await provider.search({ ...base, field: "availability" });
  assert.equal(name.value, "Laptop Dell Core i5-1334U DC15250 X5NH3");
  assert.equal(sku.value, "201116");
  assert.equal(mpn.value, "X5NH3");
  assert.deepEqual(price.value, {
    amount: 26999,
    currency: "NIO",
    taxIncluded: null,
    display: "C$26,999",
    basis: "retailer_product_page",
  });
  assert.deepEqual(stock.value, { status: "in_stock" });
});

test("SIMAN with multiple differently priced variants does not publish an aggregate price", async () => {
  const url = "https://ni.siman.com/example-phone/p";
  const provider = createSimanResearchProvider({
    fetchImpl: async requestUrl => jsonResponse([{
      productId: "300",
      productName: "Example Phone",
      linkText: "example-phone",
      items: [
        { itemId: "sku-1", sellers: [{ commertialOffer: { Price: 7999, AvailableQuantity: 2, IsAvailable: true } }] },
        { itemId: "sku-2", sellers: [{ commertialOffer: { Price: 8999, AvailableQuantity: 0, IsAvailable: false } }] },
      ],
    }], String(requestUrl)),
    minRequestIntervalMs: 0,
  });
  assert.deepEqual(await provider.search({ query: url, field: "price" }), []);
  const [availability] = await provider.search({ query: url, field: "availability" });
  assert.deepEqual(availability.value, { status: "in_stock" });
});

test("SIMAN with ambiguous model/color and references across variants withholds variant-level identity", async () => {
  const url = "https://ni.siman.com/example-phone/p";
  const provider = createSimanResearchProvider({
    fetchImpl: async requestUrl => jsonResponse([{
      productId: "300",
      productName: "Example Phone 128GB 8GB RAM",
      linkText: "example-phone",
      items: [
        {
          itemId: "sku-blue",
          ean: "1111111111111",
          referenceId: [{ Key: "RefId", Value: "sku-blue" }],
          specificationGroups: [{ specifications: [
            { name: "Modelo", values: ["SM-X100BLUE"] },
            { name: "Color", values: ["Azul"] },
          ] }],
          sellers: [{ commertialOffer: { Price: 7999, AvailableQuantity: 2, IsAvailable: true } }],
        },
        {
          itemId: "sku-gray",
          ean: "2222222222222",
          referenceId: [{ Key: "RefId", Value: "sku-gray" }],
          specificationGroups: [{ specifications: [
            { name: "Modelo", values: ["SM-X100GRAY"] },
            { name: "Color", values: ["Gris"] },
          ] }],
          sellers: [{ commertialOffer: { Price: 7999, AvailableQuantity: 2, IsAvailable: true } }],
        },
      ],
    }], String(requestUrl)),
    minRequestIntervalMs: 0,
  });
  assert.deepEqual(await provider.search({ query: url, field: "sku" }), []);
  assert.deepEqual(await provider.search({ query: url, field: "gtin" }), []);
  assert.deepEqual(await provider.search({ query: url, field: "mpn" }), []);
  assert.deepEqual(await provider.search({ query: url, field: "color" }), []);
});

test("SIMAN does not accept mismatched VTEX product records or an external API redirect", async () => {
  const url = "https://ni.siman.com/example-phone/p";
  const mismatch = createSimanResearchProvider({
    fetchImpl: async requestUrl => jsonResponse([{
      productId: "other", productName: "Different phone", linkText: "different-phone",
    }], String(requestUrl)),
    minRequestIntervalMs: 0,
  });
  assert.deepEqual(await mismatch.search({ query: url, field: "name" }), []);

  const redirect = createSimanResearchProvider({
    fetchImpl: async requestUrl => jsonResponse([], "https://evil.example/redirected"),
    minRequestIntervalMs: 0,
  });
  await assert.rejects(
    () => redirect.search({ query: url, field: "name" }),
    /redirected outside its exact public endpoint allowlist/u,
  );
});

test("retailer parser reads identifiers beyond the first five thousand characters of product detail", async () => {
  const url = cases[0].url;
  const html = [
    "<html><body><h1>Samsung A17 4GB + 128GB Gris</h1>",
    "<p>" + "detail ".repeat(900) + "</p>",
    "<p>GTIN: 8806097667995</p><p>MPN: SMA175FZAFGTO</p>",
    "<p>SKU: 470890800019</p><p>Precio especial C$7,399.00</p><p>En stock</p>",
    "</body></html>",
  ].join("");
  const provider = createRadioShackResearchProvider({
    fetchImpl: async requestUrl => htmlResponse(html, String(requestUrl)),
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const [gtin] = await provider.search({ query: url, field: "gtin" });
  const [mpn] = await provider.search({ query: url, field: "mpn" });
  assert.equal(gtin.value, "8806097667995");
  assert.equal(mpn.value, "SMA175FZAFGTO");
});

test("retailer parser prefers an explicit promotional price and preserves + IVA as tax-exclusive", async () => {
  const url = cases[0].url;
  const provider = createRadioShackResearchProvider({
    fetchImpl: async requestUrl => htmlResponse(
      productPage({ price: "C$7,399.00 + IVA" }),
      String(requestUrl),
    ),
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const [price] = await provider.search({ query: url, field: "price" });
  assert.equal(price.value.amount, 7399);
  assert.equal(price.value.taxIncluded, false);
});

test("retailer adapters do not infer price or stock when the exact page omits them", async () => {
  const url = cases[1].url;
  const provider = createLaCuracaoResearchProvider({
    fetchImpl: async requestUrl => htmlResponse(
      "<html><body><h1>Example phone</h1><p>SKU: LC-100</p></body></html>",
      String(requestUrl),
    ),
    minRequestIntervalMs: 0,
  });
  assert.deepEqual(await provider.search({ query: url, field: "price" }), []);
  assert.deepEqual(await provider.search({ query: url, field: "availability" }), []);
});

test("El Verdugo adapter is identity and warranty only; price and stock stay disabled", async () => {
  const url = "https://catalogoni.elverdugo.net/laptop-hp-14-bs007la";
  const provider = createElVerdugoResearchProvider({
    fetchImpl: async requestUrl => htmlResponse(
      "<html><body><h1>Laptop HP 14-BS007LA</h1><p>SKU: 155280</p><p>Garantía del proveedor: 12 meses</p></body></html>",
      String(requestUrl),
    ),
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const [name] = await provider.search({ query: url, field: "name" });
  const [sku] = await provider.search({ query: url, field: "sku" });
  const [warranty] = await provider.search({ query: url, field: "warranty" });
  assert.equal(name.value, "Laptop HP 14-BS007LA");
  assert.equal(sku.value, "155280");
  assert.equal(warranty.value, "12 meses");
  await assert.rejects(() => provider.search({ query: url, field: "price" }), /does not support field/u);
  await assert.rejects(() => provider.search({ query: url, field: "availability" }), /does not support field/u);
});

test("retailer adapters enforce exact HTTPS product URLs, host allowlists and technology scope", async () => {
  const provider = createRadioShackResearchProvider({
    fetchImpl: async requestUrl => htmlResponse(productPage(), String(requestUrl)),
    minRequestIntervalMs: 0,
  });
  await assert.rejects(
    () => provider.search({ query: ["http:", "", "www.radioshackla.com/nicaragua/product/p"].join("/"), field: "name" }),
    /exact product URL/u,
  );
  await assert.rejects(
    () => provider.search({ query: "https://evil.example/nicaragua/product/p", field: "name" }),
    /approved Nicaragua storefront/u,
  );
  await assert.rejects(
    () => provider.search({ query: "https://www.radioshackla.com/nicaragua/c/telefonia", field: "name" }),
    /approved Nicaragua storefront/u,
  );
  await assert.rejects(
    () => provider.search({ domain: DOMAINS.FRAGRANCE, query: cases[0].url, field: "name" }),
    /technology domain/u,
  );
});

test("retailer adapter rejects redirects outside the approved merchant host", async () => {
  const provider = createRadioShackResearchProvider({
    fetchImpl: async requestUrl => htmlResponse(
      productPage(),
      "https://evil.example/phishing",
    ),
    minRequestIntervalMs: 0,
  });
  await assert.rejects(
    () => provider.search({ query: cases[0].url, field: "name" }),
    /redirected outside its approved host/u,
  );
});

test("retailer page reader times out while consuming the response body", async () => {
  const provider = createRadioShackResearchProvider({
    fetchImpl: async requestUrl => ({
      ok: true,
      status: 200,
      url: String(requestUrl),
      text: () => new Promise(() => {}),
    }),
    timeoutMs: 10,
    minRequestIntervalMs: 0,
  });
  await assert.rejects(
    () => provider.search({ query: cases[0].url, field: "name" }),
    /timed out after 10 ms/u,
  );
});

test("retailer integration registry keeps CONICO manual and El Verdugo price/stock unsupported", () => {
  const conico = NICARAGUA_RETAILER_INTEGRATION_STATUS.find(item => item.id === "conico");
  const elVerdugo = NICARAGUA_RETAILER_INTEGRATION_STATUS.find(item => item.id === "el-verdugo");
  assert.equal(conico.status, "no-automated-catalog-verified");
  assert.equal(conico.officialApi, null);
  assert.equal(elVerdugo.status, "identity-and-warranty-only");
  assert.match(elVerdugo.note, /Price and stock are deliberately unsupported/u);
  assert.equal(NICARAGUA_RETAILER_INTEGRATION_STATUS.length, 6);
});


test("SIMAN exposes exact public SKU variants without promoting internal SKU IDs to manufacturer identity", async () => {
  const url = "https://ni.siman.com/example-phone/p";
  const calls = [];
  const provider = createSimanResearchProvider({
    fetchImpl: async (requestUrl, init) => {
      const request = String(requestUrl);
      calls.push({ url: request, init });
      if (request.includes("/search/")) {
        return jsonResponse([{
          productId: "300",
          productName: "Example Phone 4GB 128GB",
          linkText: "example-phone",
          items: [
            {
              itemId: "3001",
              ean: "",
              sellers: [{ sellerId: "1", commertialOffer: {
                Price: 7999.13, AvailableQuantity: 3, IsAvailable: true,
              } }],
            },
            {
              itemId: "3002",
              ean: "",
              sellers: [{ sellerId: "1", commertialOffer: {
                Price: 8999.13, AvailableQuantity: 0, IsAvailable: false,
              } }],
            },
            {
              itemId: "3003",
              ean: "",
              sellers: [{ sellerId: "1", commertialOffer: {
                Price: 4999.13, AvailableQuantity: 2, IsAvailable: true,
              } }],
            },
            {
              itemId: "3004",
              ean: "",
              sellers: [{ sellerId: "1", commertialOffer: {
                Price: 5999.13, AvailableQuantity: null, IsAvailable: false,
              } }],
            },
          ],
        }], request);
      }
      if (request.endsWith("/variations/300")) {
        return jsonResponse({
          dimensions: ["Capacidad (ROM)", "Color"],
          skus: [
            {
              sku: 3001,
              skuname: "Example Phone 4GB 128GB Grey",
              dimensions: { "Capacidad (ROM)": "128GB", Color: "Gris" },
              available: true,
              availablequantity: 3,
              bestPrice: 799913,
            },
            {
              sku: 3002,
              skuname: "Example Phone 4GB 128GB Blue",
              dimensions: { "Capacidad (ROM)": "128GB", Color: "Azul" },
              available: false,
              availablequantity: 0,
              bestPrice: 899913,
            },
            {
              sku: 3003,
              skuname: "Example Phone 4GB 128GB Black",
              dimensions: { "Capacidad (ROM)": "128GB", Color: "Negro" },
              available: false,
              availablequantity: 0,
              bestPrice: 499913,
            },
            {
              sku: 3004,
              skuname: "Example Phone 4GB 128GB White",
              dimensions: { "Capacidad (ROM)": "128GB", Color: "Blanco" },
              available: false,
              bestPrice: 599913,
            },
          ],
        }, request);
      }
      throw new Error("Unexpected SIMAN endpoint: " + request);
    },
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });

  const [record] = await provider.search({
    domain: DOMAINS.TECHNOLOGY,
    query: url,
    field: "variants",
    limit: 1,
  });

  assert.equal(record.value.length, 4);
  assert.deepEqual(record.value[0], {
    retailerSku: "3001",
    name: "Example Phone 4GB 128GB Grey",
    dimensions: { "Capacidad (ROM)": "128GB", Color: "Gris" },
    color: "Gris",
    capacity: "128GB",
    price: {
      amount: 7999.13,
      currency: "NIO",
      taxIncluded: null,
      display: "C$7999.13",
      basis: "vtex_public_sku_offer",
    },
    availability: { status: "in_stock", quantity: 3 },
    manufacturerIdentifiers: { gtin: null, mpn: null },
  });
  assert.equal(record.value[1].availability.status, "out_of_stock");
  assert.equal(record.value[1].price.amount, 8999.13);
  assert.equal(record.value[2].availability, null, "conflicting seller and SKU status is withheld");
  assert.equal(record.value[3].availability.status, "out_of_stock");
  assert.equal(Object.hasOwn(record.value[3].availability, "quantity"), false,
    "a missing quantity must not be converted to zero");
  assert.equal(record.source.market, "NI");
  assert.equal(record.observedAt, fixedClock().toISOString());
  assert.ok(record.source.references.some(reference => reference.endsWith("/search/example-phone/p")));
  assert.ok(record.source.references.some(reference => reference.endsWith("/variations/300")));
  assert.equal(calls.length, 2, "exact product response and its SKU-variations response are fetched once each");
  assert.ok(calls.every(call => call.init.method === "GET"));
  assert.ok(calls.every(call => call.init.headers.Accept === "application/json"));
  assert.ok(calls.every(call => !Object.keys(call.init.headers).some(key => /authorization/iu.test(key))));
  assert.match(calls[0].url, /\/api\/catalog_system\/pub\/products\/search\/example-phone\/p$/u);
  assert.match(calls[1].url, /\/api\/catalog_system\/pub\/products\/variations\/300$/u);
});


test("SIMAN SKU-variations request rejects redirects to non-allowlisted paths on the same host", async () => {
  const url = "https://ni.siman.com/example-phone/p";
  const provider = createSimanResearchProvider({
    fetchImpl: async requestUrl => {
      const request = String(requestUrl);
      if (request.includes("/search/")) {
        return jsonResponse([{
          productId: "300",
          productName: "Example Phone",
          linkText: "example-phone",
          items: [{ itemId: "3001", sellers: [] }],
        }], request);
      }
      return jsonResponse(
        { skus: [] },
        "https://ni.siman.com/api/catalog_system/private/products/300",
      );
    },
    minRequestIntervalMs: 0,
  });
  await assert.rejects(
    () => provider.search({
      domain: DOMAINS.TECHNOLOGY,
      query: url,
      field: "variants",
    }),
    /redirected outside its exact public endpoint allowlist/u,
  );
});
