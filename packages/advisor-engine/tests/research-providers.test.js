import test from "node:test";
import assert from "node:assert/strict";
import { DOMAINS } from "../src/core/domains.js";
import {
  createDefaultResearchProviders,
  createScentoResearchProvider,
  createTenMlResearchProvider,
  createOpenBeautyFactsResearchProvider,
  createWikidataResearchProvider,
  createTechApiResearchProvider,
  createCoreInfoResearchProvider,
  WIKIDATA_RESEARCH_FIELDS,
} from "../src/research/providers.js";

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}
const fixedClock = () => new Date("2026-11-07T20:00:00.000Z");

test("Scento provider resolves a perfume profile and maps note pyramid values", async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).includes("/search?")) return response({
      detail: { matches: [{ kind: "perfume", name: "Layton", page: "https://www.scento.com/perfumes/layton-parfums-de-marly" }] },
    });
    return response({
      detail: { name: "Layton", pyramid: { top: ["Apple"], heart: ["Lavender"], base: ["Vanilla"] } },
      scento_page: { url: "https://www.scento.com/perfumes/layton-parfums-de-marly" },
    });
  };
  const provider = createScentoResearchProvider({ fetchImpl, clock: fixedClock, minRequestIntervalMs: 0 });
  const records = await provider.search({ domain: DOMAINS.FRAGRANCE, query: "Layton", field: "notes", limit: 5 });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].value, { top: ["Apple"], heart: ["Lavender"], base: ["Vanilla"] });
  assert.equal(records[0].source.type, "database");
  assert.equal(calls.length, 2);
});

test("Scento uses bounded cache for repeated search and profile GETs", async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    if (String(url).includes("/search?")) return response({
      detail: { matches: [{ kind: "perfume", page: "https://www.scento.com/perfumes/layton-parfums-de-marly" }] },
    });
    return response({
      detail: { name: "Layton", concentration: "eau de parfum" },
      scento_page: { url: "https://www.scento.com/perfumes/layton-parfums-de-marly" },
    });
  };
  const provider = createScentoResearchProvider({ fetchImpl, clock: fixedClock, minRequestIntervalMs: 0 });
  await provider.search({ query: "Layton", field: "concentration" });
  await provider.search({ query: "Layton", field: "concentration" });
  assert.equal(calls, 2);
});

test("Scento rejects lookalike or non-HTTPS perfume URLs and ignores unsupported fields", async () => {
  const provider = createScentoResearchProvider({
    fetchImpl: async () => response({ detail: { matches: [
      { kind: "perfume", page: "https://evil.example/perfumes/x" },
      { kind: "house", page: "https://www.scento.com/perfumes/y" },
    ] } }),
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  assert.deepEqual(await provider.search({ query: "test", field: "notes" }), []);
});

test("Wikidata provider fetches search hits in one entity batch and resolves labels", async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).includes("wbsearchentities")) return response({ search: [{ id: "Q123", label: "Example phone" }] });
    if (String(url).includes("wbgetentities")) return response({ entities: {
      Q123: { labels: { en: { value: "Example phone" } }, claims: { P577: [
        { mainsnak: { snaktype: "value", datavalue: { value: { time: "+2024-01-02T00:00:00Z" } } } },
      ] } },
    } });
    throw new Error("unexpected request");
  };
  const provider = createWikidataResearchProvider({ fetchImpl, clock: fixedClock, minRequestIntervalMs: 0 });
  const records = await provider.search({ query: "Example phone", field: "release_date", limit: 4 });
  assert.equal(records[0].value, "2024-01-02");
  assert.equal(records[0].source.url, "https://www.wikidata.org/wiki/Q123");
  assert.equal(calls.length, 2);
  assert.match(calls[1], /props=claims%7Clabels/u);
});

test("Wikidata maps RAM and storage capacities without losing their unit identifiers", async () => {
  const propertyForField = {
    ram_capacity: "P13525",
    storage_capacity: "P2928",
  };
  for (const [field, property] of Object.entries(propertyForField)) {
    const fetchImpl = async url => {
      if (String(url).includes("wbsearchentities")) return response({ search: [{ id: "Q123", label: "Example device" }] });
      return response({ entities: { Q123: { claims: {
        [property]: [{ mainsnak: { snaktype: "value", datavalue: { value: {
          amount: "+16", unit: ["http:", "", "www.wikidata.org/entity/Q79765"].join("/"),
        } } } }],
      } } } });
    };
    const provider = createWikidataResearchProvider({ fetchImpl, clock: fixedClock, minRequestIntervalMs: 0 });
    const records = await provider.search({ query: "Example device", field });
    assert.equal(records[0].value.amount, 16);
    assert.equal(records[0].value.unit, ["http:", "", "www.wikidata.org/entity/Q79765"].join("/"));
  }
});

test("Wikidata maps CPU and GPU as labelled entity references", async () => {
  for (const [field, property, itemId] of [
    ["cpu", "P880", "Q999"],
    ["gpu", "P2560", "Q998"],
  ]) {
    const fetchImpl = async url => {
      if (String(url).includes("wbsearchentities")) return response({ search: [{ id: "Q123", label: "Example device" }] });
      if (String(url).includes("ids=Q123")) return response({ entities: {
        Q123: { claims: { [property]: [
          { mainsnak: { snaktype: "value", datavalue: { value: { id: itemId } } } },
        ] } },
      } });
      if (String(url).includes(`ids=${itemId}`)) return response({ entities: {
        [itemId]: { labels: { en: { value: field === "cpu" ? "Example CPU" : "Example GPU" } } },
      } });
      throw new Error("unexpected entity batch");
    };
    const provider = createWikidataResearchProvider({ fetchImpl, clock: fixedClock, minRequestIntervalMs: 0 });
    const records = await provider.search({ query: "Example device", field });
    assert.equal(records[0].value.entityId, itemId);
    assert.equal(records[0].value.label, field === "cpu" ? "Example CPU" : "Example GPU");
  }
});

test("Wikidata ignores deprecated and no-value statements, preferring preferred rank", async () => {
  const fetchImpl = async url => {
    if (String(url).includes("wbsearchentities")) return response({ search: [{ id: "Q123", label: "Example phone" }] });
    return response({ entities: { Q123: { claims: { P2928: [
      { rank: "deprecated", mainsnak: { snaktype: "value", datavalue: { value: { amount: "+64", unit: "Q" } } } },
      { rank: "normal", mainsnak: { snaktype: "novalue" } },
      { rank: "normal", mainsnak: { snaktype: "value", datavalue: { value: { amount: "+128", unit: "Q" } } } },
      { rank: "preferred", mainsnak: { snaktype: "value", datavalue: { value: { amount: "+256", unit: "Q" } } } },
    ] } } } });
  };
  const provider = createWikidataResearchProvider({ fetchImpl, clock: fixedClock, minRequestIntervalMs: 0 });
  const records = await provider.search({ query: "Example phone", field: "storage_capacity" });
  assert.equal(records[0].value.amount, 256);
});

test("Wikidata rejects unsupported properties and non-item search IDs", async () => {
  const provider = createWikidataResearchProvider({
    fetchImpl: async () => response({ search: [{ id: "not-an-item" }] }),
    minRequestIntervalMs: 0,
  });
  await assert.rejects(() => provider.search({ query: "phone", field: "battery" }), /does not support/);
  assert.deepEqual(await provider.search({ query: "phone", field: "name" }), []);
});

test("Wikidata surfaces retry-after guidance on rate limiting", async () => {
  const provider = createWikidataResearchProvider({
    fetchImpl: async () => response({}, 429, { "retry-after": "30" }),
    minRequestIntervalMs: 0,
  });
  await assert.rejects(
    () => provider.search({ query: "Example phone", field: "name" }),
    /HTTP 429; retry after 30 seconds/u,
  );
});

test("default research provider registry contains isolated fragrance and technology sources", () => {
  const providers = createDefaultResearchProviders({
    scento: { fetchImpl: async () => response({}), minRequestIntervalMs: 0 },
    wikidata: { fetchImpl: async () => response({}), minRequestIntervalMs: 0 },
  });
  assert.deepEqual(providers.map(provider => provider.id), [
    "scento-perfume-api",
    "10ml-fragrance-index",
    "open-beauty-facts-cosmetics",
    "wikidata",
    "coreinfo-device-catalog",
    "sicsa-nicaragua-retail",
    "radioshack-nicaragua-retail",
    "la-curacao-nicaragua-retail",
    "el-gallo-mas-gallo-nicaragua-retail",
    "siman-nicaragua-retail",
    "el-verdugo-nicaragua-catalog",
  ]);
  assert.deepEqual(providers[0].domains, [DOMAINS.FRAGRANCE]);
  assert.deepEqual(providers[1].domains, [DOMAINS.FRAGRANCE]);
  assert.deepEqual(providers[2].domains, [DOMAINS.FRAGRANCE]);
  assert.deepEqual(providers[3].domains, [DOMAINS.TECHNOLOGY]);
  assert.deepEqual(providers[4].domains, [DOMAINS.TECHNOLOGY]);
  assert.deepEqual(providers[5].domains, [DOMAINS.TECHNOLOGY]);
  assert.ok(WIKIDATA_RESEARCH_FIELDS.includes("ram_capacity"));
  assert.ok(WIKIDATA_RESEARCH_FIELDS.includes("storage_capacity"));
  assert.ok(WIKIDATA_RESEARCH_FIELDS.includes("cpu"));
  assert.ok(WIKIDATA_RESEARCH_FIELDS.includes("gpu"));
});

test("Wikidata identifies the client and asks the API to defer under backend lag", async () => {
  let options;
  let requestUrl;
  const provider = createWikidataResearchProvider({
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      options = init;
      return response({ search: [] });
    },
    minRequestIntervalMs: 0,
  });
  await provider.search({ query: "Example device", field: "name" });
  const header = options.headers["User-Agent"] ?? options.headers["Api-User-Agent"];
  assert.match(header, /^JB Advisor Engine\/0\.1 \(https:\/\/github\.com\//u);
  assert.match(requestUrl, /maxlag=5/u);
});

test("Wikidata maps display size to the diagonal display-size property", async () => {
  const requested = [];
  const fetchImpl = async url => {
    requested.push(String(url));
    if (String(url).includes("wbsearchentities")) return response({ search: [{ id: "Q123", label: "Example tablet" }] });
    if (String(url).includes("wbgetentities")) return response({ entities: {
      Q123: { claims: { P13749: [{ mainsnak: { datavalue: { value: { amount: "+11", unit: ["http:", "", "www.wikidata.org/entity/Q174728"].join("/") } } } }] } },
    } });
    throw new Error("unexpected request");
  };
  const provider = createWikidataResearchProvider({ fetchImpl, clock: fixedClock, minRequestIntervalMs: 0 });
  const results = await provider.search({ query: "Example tablet", field: "display_size" });
  assert.equal(results[0].value.amount, 11);
  assert.match(requested[1], /wbgetentities/u);
});

test("TechAPI exact-slug provider maps real device fields and retains CC BY-SA attribution", async () => {
  const calls = [];
  const provider = createTechApiResearchProvider({
    fetchImpl: async url => {
      calls.push(String(url));
      return response({
        slug: "galaxy-s26-ultra",
        name: "Galaxy S26 Ultra",
        brand: { name: "Samsung", country: "KR" },
        soc: { name: "Snapdragon 8 Elite Gen 5", gpu_name: "Adreno 840" },
        ram_gb: 12,
        storage_options_gb: [256, 512, 1024],
        display: { size_inch: 6.9, resolution: "3120x1440", refresh_hz: 120 },
        cameras: [{ type: "main", mp: 200 }, { type: "ultrawide", mp: 50 }],
        battery_mah: 5000,
        source_urls: ["https://www.samsung.com/global/galaxy/galaxy-s26-ultra/specs/"],
        verified: true,
      });
    },
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const results = await provider.search({ query: "smartphones:galaxy-s26-ultra", field: "main_camera_mp" });
  assert.equal(results.length, 1);
  assert.equal(results[0].value, 200);
  assert.equal(results[0].confidence, 0.8);
  assert.equal(results[0].source.license, "CC-BY-SA-4.0");
  assert.equal(results[0].source.attribution, "Data from TechAPI");
  assert.equal(results[0].source.references[0], "https://www.samsung.com/global/galaxy/galaxy-s26-ultra/specs/");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/smartphones\/galaxy-s26-ultra\/index.json$/u);
});

test("TechAPI supports distinct laptop and monitor resources and refuses guessed slugs", async () => {
  const requested = [];
  const provider = createTechApiResearchProvider({
    fetchImpl: async url => {
      requested.push(String(url));
      const isLaptop = String(url).includes("/laptops/");
      return response(isLaptop
        ? { slug: "hp-omnibook-x-flip", name: "HP OmniBook X Flip", cpu: { cores: 8 }, source_urls: [] }
        : { slug: "samsung-g93sc", name: "Samsung Odyssey G9", display: { refresh_hz: 240 }, source_urls: [] });
    },
    minRequestIntervalMs: 0,
  });
  const laptop = await provider.search({ query: "laptops:hp-omnibook-x-flip", field: "name" });
  const monitor = await provider.search({ query: "monitors:samsung-g93sc", field: "name" });
  assert.equal(laptop[0].value, "HP OmniBook X Flip");
  assert.equal(monitor[0].value, "Samsung Odyssey G9");
  await assert.rejects(() => provider.search({ query: "HP OmniBook X Flip", field: "name" }), /exact resource:slug/);
  assert.equal(requested.length, 2);
});

test("TechAPI never trusts the upstream verified flag as JBAE verification", async () => {
  const provider = createTechApiResearchProvider({
    fetchImpl: async () => response({
      slug: "galaxy-s26-ultra", name: "Galaxy S26 Ultra", verified: true, ram_gb: 12,
      source_urls: [],
    }),
    minRequestIntervalMs: 0,
  });
  const record = (await provider.search({
    query: "smartphones:galaxy-s26-ultra", field: "ram_gb",
  }))[0];
  assert.match(record.note, /not JBAE verification/u);
});

test("TechAPI stays opt-in while the local Nicaragua retailer provider is enabled by default", () => {
  const providers = createDefaultResearchProviders({
    scento: { fetchImpl: async () => response({}), minRequestIntervalMs: 0 },
    wikidata: { fetchImpl: async () => response({}), minRequestIntervalMs: 0 },
  });
  assert.deepEqual(providers.map(provider => provider.id), [
    "scento-perfume-api",
    "10ml-fragrance-index",
    "open-beauty-facts-cosmetics",
    "wikidata",
    "coreinfo-device-catalog",
    "sicsa-nicaragua-retail",
    "radioshack-nicaragua-retail",
    "la-curacao-nicaragua-retail",
    "el-gallo-mas-gallo-nicaragua-retail",
    "siman-nicaragua-retail",
    "el-verdugo-nicaragua-catalog",
  ]);
  assert.ok(!providers.some(provider => provider.id === "techapi-static-specs"));
});

test("Wikidata retries maxlag responses only after the upstream-reported delay", async () => {
  let calls = 0;
  const waits = [];
  const provider = createWikidataResearchProvider({
    fetchImpl: async () => {
      calls += 1;
      return calls < 3
        ? response({ error: { code: "maxlag", info: "Waiting for replica lag", lag: 8 } })
        : response({ search: [] });
    },
    minRequestIntervalMs: 0,
    sleepImpl: async milliseconds => waits.push(milliseconds),
  });
  const results = await provider.search({ query: "example phone", field: "name" });
  assert.deepEqual(results, []);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [9_000, 9_000]);
});

test("Wikidata stops after the configured maximum maxlag retries", async () => {
  let calls = 0;
  const provider = createWikidataResearchProvider({
    fetchImpl: async () => {
      calls += 1;
      return response({ error: { code: "maxlag", info: "Replica remains behind", lag: 3 } });
    },
    minRequestIntervalMs: 0,
    sleepImpl: async () => {},
    maxlagRetries: 1,
  });
  await assert.rejects(
    () => provider.search({ query: "example phone", field: "name" }),
    /maxlag \(3s\) after 1 retries/u,
  );
  assert.equal(calls, 2);
});

test("TechAPI maps published laptop, monitor and smartphone schema variants", async () => {
  const records = [
    { slug: "iphone-18-pro-max", name: "iPhone 18 Pro Max", ram_gb: 12, soc: "apple-a20-pro", source_urls: [] },
    { slug: "hp-omnibook-3-14-ha0000au-abhinavflac-384", name: "HP OmniBook 3", cpu_name: "AMD Ryzen Ai 5 340", gpu_name: "AMD Radeon Radeon", storage_gb: 512, source_urls: [] },
    { slug: "acer-cb241y-amazonmon-603", name: "acer CB241Y", size_inch: 23.8, resolution: "1920x1080", source_urls: [] },
  ];
  const provider = createTechApiResearchProvider({ fetchImpl: async url => response(records.find(item => url.endsWith("/" + item.slug + "/index.json")) ?? {}), minRequestIntervalMs: 0 });
  const value = async (query, field) => (await provider.search({ query, field }))[0]?.value;
  assert.equal(await value("smartphones:iphone-18-pro-max", "ram_gb"), 12);
  assert.equal(await value("smartphones:iphone-18-pro-max", "soc"), "apple-a20-pro");
  assert.equal(await value("laptops:hp-omnibook-3-14-ha0000au-abhinavflac-384", "chipset"), "AMD Ryzen Ai 5 340");
  assert.equal(await value("laptops:hp-omnibook-3-14-ha0000au-abhinavflac-384", "gpu"), "AMD Radeon Radeon");
  assert.equal(await value("laptops:hp-omnibook-3-14-ha0000au-abhinavflac-384", "storage_gb"), 512);
  assert.equal(await value("monitors:acer-cb241y-amazonmon-603", "display_size"), 23.8);
  assert.equal(await value("monitors:acer-cb241y-amazonmon-603", "display_resolution"), "1920x1080");
});

test("TechAPI component resources return real record-shaped fields", async () => {
  const samples = [
    ["socs:snapdragon-8-elite", "Qualcomm Snapdragon 8 Elite"],
    ["gpus:geforce-rtx-5090", "NVIDIA GeForce RTX 5090"],
    ["cpus:core-i9-14900k", "Intel Core i9-14900K"],
  ];
  const provider = createTechApiResearchProvider({
    fetchImpl: async url => {
      const slug = String(url).split("/").at(-2);
      const sample = samples.find(([query]) => query.endsWith(slug));
      return response({
        slug,
        name: sample?.[1],
        source_urls: ["https://www.vendor.example/specs"],
      });
    },
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  for (const [query, expected] of samples) {
    const result = await provider.search({ query, field: "name" });
    assert.equal(result[0].value, expected);
  }
});


test("CoreInfo exact-slug provider maps device identity, specification labels and published price", async () => {
  const calls = [];
  const provider = createCoreInfoResearchProvider({
    fetchImpl: async url => {
      calls.push(String(url));
      return response({
        slug: "huawei-nova-16-se",
        name: "Huawei Nova 16 SE",
        brand: "Huawei",
        category: "smartphones",
        price: { amount: 39990, currency: "INR", display: "₹39,990" },
        specifications: [
          { category: "Memory", items: [
            { name: "RAM", value: "12 GB" },
            { name: "Internal Storage", value: "256 GB" },
          ] },
        ],
        source_urls: ["https://consumer.huawei.com/example/nova-16-se/specs/"],
      });
    },
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const base = {
    domain: DOMAINS.TECHNOLOGY,
    subjectId: "huawei-nova-16-se",
    query: "huawei-nova-16-se",
    limit: 1,
  };
  const name = await provider.search({ ...base, field: "name" });
  const ram = await provider.search({ ...base, field: "ram" });
  const price = await provider.search({ ...base, field: "price" });
  assert.equal(name[0].value, "Huawei Nova 16 SE");
  assert.equal(ram[0].value, "12 GB");
  assert.deepEqual(price[0].value, {
    amount: 39990, currency: "INR", indicative: true, basis: "published_reference",
  });
  assert.equal(price[0].source.attribution, "Data from CoreInfo");
  assert.ok(price[0].note.includes("not be current"));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api\/device\/huawei-nova-16-se\.json$/u);
});

test("CoreInfo exact-slug provider rejects broad search phrases and mismatched records", async () => {
  const provider = createCoreInfoResearchProvider({
    fetchImpl: async () => response({ slug: "different-device", name: "Different Device" }),
    minRequestIntervalMs: 0,
  });
  await assert.rejects(
    () => provider.search({ query: "Samsung Galaxy S25", field: "name" }),
    /exact device slug/u,
  );
  await assert.rejects(
    () => provider.search({ query: "huawei-nova-16-se", field: "name" }),
    /does not match the requested device slug/u,
  );
});


test("CoreInfo parses currency-prefixed prices and numeric strings only with an explicit currency", async () => {
  const records = [
    { slug: "price-prefix", name: "Price Prefix", price: "INR 39,990" },
    { slug: "price-numeric", name: "Price Numeric", price: "39990", currency: "INR" },
    { slug: "price-ambiguous", name: "Price Ambiguous", price: "39990" },
  ];
  const provider = createCoreInfoResearchProvider({
    fetchImpl: async url => response(records.find(item => url.endsWith(`/${item.slug}.json`))),
    minRequestIntervalMs: 0,
  });
  const getPrice = async slug => (await provider.search({
    query: slug, field: "price",
  }))[0]?.value;
  assert.deepEqual(await getPrice("price-prefix"), {
    amount: 39990, currency: "INR", indicative: true, basis: "published_reference",
  });
  assert.deepEqual(await getPrice("price-numeric"), {
    amount: 39990, currency: "INR", indicative: true, basis: "published_reference",
  });
  assert.equal(await getPrice("price-ambiguous"), undefined);
});

test("CoreInfo resolves tablet and smartwatch category-specific records without inventing absent fields", async () => {
  const records = {
    "xiaomi-pad-8": {
      slug: "xiaomi-pad-8", name: "Xiaomi Pad 8", brand: { name: "Xiaomi" },
      category: "tablets", specifications: [
        { category: "Display", items: [{ name: "Screen Size", value: "11.2 inches" }] },
        { category: "Memory", items: [{ name: "RAM", value: "8 GB" }, { name: "Storage", value: "128 GB" }] },
      ],
    },
    "redmi-watch-5": {
      slug: "redmi-watch-5", name: "Redmi Watch 5", brand: "Xiaomi",
      category: "smartwatches", specifications: [
        { category: "Display", items: [{ name: "Display Size", value: "2.07 inches" }] },
      ],
    },
  };
  const provider = createCoreInfoResearchProvider({
    fetchImpl: async url => response(records[url.split("/").at(-1).replace(".json", "")]),
    minRequestIntervalMs: 0,
  });
  const tablet = await provider.search({ query: "xiaomi-pad-8", field: "name" });
  const tabletRam = await provider.search({ query: "xiaomi-pad-8", field: "ram" });
  const watch = await provider.search({ query: "redmi-watch-5", field: "name" });
  const absent = await provider.search({ query: "redmi-watch-5", field: "battery_capacity" });
  assert.equal(tablet[0].value, "Xiaomi Pad 8");
  assert.equal(tabletRam[0].value, "8 GB");
  assert.equal(watch[0].value, "Redmi Watch 5");
  assert.deepEqual(absent, []);
});


test("JSON reader timeout covers response-body parsing, not only response headers", async () => {
  const provider = createCoreInfoResearchProvider({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => new Promise(() => {}),
    }),
    timeoutMs: 10,
    minRequestIntervalMs: 0,
  });
  await assert.rejects(
    () => provider.search({ query: "huawei-nova-16-se", field: "name" }),
    /timed out after 10 ms/u,
  );
});


test("CoreInfo maps display size and resolution label variants from display specification groups", async () => {
  const provider = createCoreInfoResearchProvider({
    fetchImpl: async () => response({
      slug: "display-label-variants",
      name: "Display Label Variants",
      specifications: [
        { category: "Display", items: [
          { name: "Size", value: "11.2 inches" },
          { name: "Resolution", value: "2136 x 3200 pixels" },
        ] },
      ],
    }),
    minRequestIntervalMs: 0,
  });
  const size = await provider.search({ query: "display-label-variants", field: "display_size" });
  const resolution = await provider.search({ query: "display-label-variants", field: "display_resolution" });
  assert.equal(size[0].value, "11.2 inches");
  assert.equal(resolution[0].value, "2136 x 3200 pixels");
});


test("TechAPI keeps fixed storage capacity separate from selectable storage options", async () => {
  const records = {
    "smartphones:example-phone": {
      slug: "example-phone", name: "Example Phone",
      brand: { name: "Example" }, ram_gb: 12,
      storage_options_gb: [256, 512, 1024], source_urls: [],
    },
    "laptops:example-laptop": {
      slug: "example-laptop", name: "Example Laptop",
      brand: { name: "Example" }, ram_gb: 16,
      storage_gb: 1024, source_urls: [],
    },
  };
  const provider = createTechApiResearchProvider({
    fetchImpl: async url => {
      const entry = Object.entries(records).find(([key]) => {
        const [resource, slug] = key.split(":");
        return String(url).endsWith(`/${resource}/${slug}/index.json`);
      });
      return response(entry?.[1] ?? {});
    },
    minRequestIntervalMs: 0,
  });
  assert.deepEqual(
    await provider.search({ query: "smartphones:example-phone", field: "storage_gb" }),
    [],
  );
  assert.deepEqual(
    (await provider.search({ query: "smartphones:example-phone", field: "storage_options_gb" }))[0].value,
    [256, 512, 1024],
  );
  assert.equal(
    (await provider.search({ query: "laptops:example-laptop", field: "storage_gb" }))[0].value,
    1024,
  );
});

test("TechAPI maps expanded SoC, CPU, GPU and monitor detail fields", async () => {
  const records = {
    "socs:example-soc": {
      slug: "example-soc", name: "Example SoC",
      manufacturer: { name: "Example Silicon" },
      process_nm: 3, cpu_config: { architecture: "Example Core", performance: 2, efficiency: 6 },
      gpu_name: "Example GPU", gpu_cores: 8, gpu_clock_mhz: 1100,
      npu_tops: 45, modem: "Example X80", source_urls: [],
    },
    "cpus:example-cpu": {
      slug: "example-cpu", name: "Example CPU",
      manufacturer: { name: "Example CPU Co." },
      architecture: "Example Lake", socket: "LGA-test", process_node: "5 nm",
      cores: 24, threads: 32, p_cores: 8, e_cores: 16,
      base_clock_ghz: 3.2, boost_clock_ghz: 6,
      l3_cache_mb: 36, tdp_w: 125, max_tdp_w: 253,
      integrated_graphics: "Example Graphics", memory_support: "DDR5",
      source_urls: [],
    },
    "gpus:example-gpu": {
      slug: "example-gpu", name: "Example GPU",
      manufacturer: { name: "Example Graphics Co." },
      architecture: "Example Arch", memory_gb: 24, memory_type: "GDDR7",
      memory_bus_bit: 384, memory_bandwidth_gbps: 1200,
      base_clock_mhz: 1800, boost_clock_mhz: 2500, tdp_w: 350,
      pcie_version: "PCIe 5.0", fp32_tflops: 80,
      cuda_cores: 12000, stream_processors: 7000, rt_cores: 90, tensor_cores: 360,
      source_urls: [],
    },
    "monitors:example-monitor": {
      slug: "example-monitor", name: "Example Monitor",
      brand: { name: "Example Displays" },
      size_inch: 27, resolution: "2560x1440", panel_type: "IPS",
      ppi: 109, curvature: "flat", hdr: "HDR10", rating: 4.5,
      features: { usbHub: true }, source_urls: [],
    },
  };
  const provider = createTechApiResearchProvider({
    fetchImpl: async url => {
      const entry = Object.entries(records).find(([key]) => {
        const [resource, slug] = key.split(":");
        return String(url).endsWith(`/${resource}/${slug}/index.json`);
      });
      return response(entry?.[1] ?? {});
    },
    minRequestIntervalMs: 0,
  });
  const get = async (query, field) => (await provider.search({ query, field }))[0]?.value;
  assert.equal(await get("socs:example-soc", "manufacturer"), "Example Silicon");
  assert.equal(await get("socs:example-soc", "soc"), "Example SoC");
  assert.deepEqual(await get("socs:example-soc", "cpu_config"), records["socs:example-soc"].cpu_config);
  assert.equal(await get("socs:example-soc", "npu_tops"), 45);
  assert.equal(await get("socs:example-soc", "gpu_clock_mhz"), 1100);
  assert.equal(await get("cpus:example-cpu", "manufacturer"), "Example CPU Co.");
  assert.equal(await get("cpus:example-cpu", "architecture"), "Example Lake");
  assert.equal(await get("cpus:example-cpu", "cpu_cores"), 24);
  assert.equal(await get("cpus:example-cpu", "boost_clock_ghz"), 6);
  assert.equal(await get("gpus:example-gpu", "manufacturer"), "Example Graphics Co.");
  assert.equal(await get("gpus:example-gpu", "gpu"), "Example GPU");
  assert.equal(await get("gpus:example-gpu", "memory_gb"), 24);
  assert.equal(await get("gpus:example-gpu", "memory_bandwidth_gbps"), 1200);
  assert.equal(await get("gpus:example-gpu", "tensor_cores"), 360);
  assert.equal(await get("monitors:example-monitor", "display_type"), "IPS");
  assert.equal(await get("monitors:example-monitor", "ppi"), 109);
  assert.deepEqual(await get("monitors:example-monitor", "features"), { usbHub: true });
});

test("TechAPI exposes PDA and identity-only device-catalog exact-slug resources", async () => {
  const requests = [];
  const provider = createTechApiResearchProvider({
    fetchImpl: async url => {
      requests.push(String(url));
      if (String(url).includes("/pdas/example-pda/")) {
        return response({ slug: "example-pda", name: "Example PDA", form_factor: "pda", model_numbers: ["A-1"], source_urls: [] });
      }
      return response({
        slug: "example-unlisted-device", name: "Example Unlisted Device",
        form_factor: "tablet", device_type_guess: "tablet",
        model_numbers: ["T-100"], screen_resolution: "1920x1200",
        source_urls: [],
      });
    },
    minRequestIntervalMs: 0,
  });
  const pda = await provider.search({ query: "pdas:example-pda", field: "name" });
  const catalog = await provider.search({
    query: "device-catalog:example-unlisted-device", field: "model_numbers",
  });
  assert.equal(pda[0].value, "Example PDA");
  assert.deepEqual(catalog[0].value, ["T-100"]);
  assert.equal(requests.length, 2);
  await assert.rejects(
    () => provider.search({ query: "device-catalog example", field: "name" }),
    /exact resource:slug/u,
  );
});


test("10ML provider maps detailed fragrance results and preserves its visible commercial-use attribution", async () => {
  const calls = [];
  const payload = {
    total: 2,
    results: [
      {
        id: "lattafa-khamrah-edp",
        name: "Khamrah",
        house: "Lattafa",
        year: 2022,
        gender: "unisex",
        concentration: "EDP",
        family: "Amber gourmand",
        accords: ["sweet", "warm spicy", "amber"],
        key_notes: ["cinnamon", "dates", "vanilla"],
        pyramid: {
          top: ["Cinnamon", "Nutmeg"],
          heart: ["Dates", "Praline"],
          base: ["Vanilla", "Tonka bean"],
        },
        seasons: ["autumn", "winter"],
        occasions: ["evening"],
        styles: ["sweet", "gourmand"],
        longevity: 5,
        projection: 4,
        perfumers: ["Perfumer One"],
        character: "Warm gourmand profile.",
        profile: "full",
      },
      {
        id: "al-haramain-laventure",
        name: "L'Aventure",
        house: "Al Haramain",
        family: "Chypre fruity",
        accords: ["fruity", "woody"],
        key_notes: ["bergamot", "pineapple"],
        pyramid: { top: ["Bergamot"], heart: ["Jasmine"], base: ["Musk"] },
        profile: "full",
      },
    ],
    source: "10ML Fragrance Index",
  };
  const provider = createTenMlResearchProvider({
    fetchImpl: async url => {
      calls.push(String(url));
      return response(payload);
    },
    clock: fixedClock,
    maxProfiles: 2,
    minRequestIntervalMs: 0,
  });
  const records = await provider.search({
    domain: DOMAINS.FRAGRANCE,
    query: "Lattafa",
    field: "notes",
    limit: 10,
  });
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].value, payload.results[0].pyramid);
  assert.equal(records[0].id, "lattafa-khamrah-edp");
  assert.equal(records[0].source.name, "10ML Fragrance Index");
  assert.equal(records[0].source.type, "database");
  assert.equal(records[0].source.attribution, "Data: 10ML Fragrance Index");
  assert.equal(records[0].source.references[0], "https://10ml.com/perfume-api");
  assert.match(records[0].source.url, /\/api\/v1\/perfumes\/lattafa-khamrah-edp$/u);
  assert.equal(records[0].source.license.includes("free commercial use"), true);
  assert.match(records[0].note, /remains unconfirmed in JBAE/u);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /q=Lattafa/u);
  assert.match(calls[0], /format=detailed/u);
  assert.match(calls[0], /limit=2/u);
});

test("10ML provider caches fetched pages and does not invent missing pyramid tiers", async () => {
  let calls = 0;
  const provider = createTenMlResearchProvider({
    fetchImpl: async () => {
      calls += 1;
      return response({
        results: [{
          id: "house-sample",
          name: "House Sample",
          house: "Sample House",
          family: "Woody",
          key_notes: ["cedar", "musk"],
          pyramid: {},
        }],
      });
    },
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const base = { domain: DOMAINS.FRAGRANCE, query: "Sample House" };
  const notes = await provider.search({ ...base, field: "notes" });
  const top = await provider.search({ ...base, field: "top_notes" });
  assert.deepEqual(notes[0].value, { keyNotes: ["cedar", "musk"] });
  assert.deepEqual(top, []);
  assert.equal(calls, 1);
});

test("10ML provider rejects excessive query lengths and malformed upstream search payloads", async () => {
  const provider = createTenMlResearchProvider({
    fetchImpl: async () => response({ result: [] }),
    minRequestIntervalMs: 0,
  });
  await assert.rejects(
    () => provider.search({ query: "x".repeat(201), field: "name" }),
    /200 characters or fewer/u,
  );
  await assert.rejects(
    () => provider.search({ query: "Lattafa", field: "name" }),
    /missing results/u,
  );
});


test("Open Beauty Facts looks up one cosmetics GTIN and preserves ODbL attribution without importing images", async () => {
  let requestedUrl;
  let requestedHeaders;
  const provider = createOpenBeautyFactsResearchProvider({
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      requestedHeaders = init.headers;
      return response({
        status: 1,
        product: {
          code: "3560070791460",
          product_name: "Example Body Mist",
          product_name_en: "Example Body Mist",
          brands: "Example Brand",
          categories: "Body mists",
          categories_tags: ["en:body-mists"],
          ingredients_text: "Aqua, parfum",
          ingredients: [{ id: "aqua", text: "Aqua" }],
          image_url: "https://images.example/product.jpg",
          image_front_url: "https://images.example/front.jpg",
        },
      });
    },
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });
  const result = await provider.search({
    domain: DOMAINS.FRAGRANCE,
    query: "3560070791460",
    field: "category_tags",
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].value, ["en:body-mists"]);
  assert.equal(result[0].source.name, "Open Beauty Facts");
  assert.equal(result[0].source.attribution.includes("ODbL"), true);
  assert.equal(result[0].source.references.includes("https://opendatacommons.org/licenses/odbl/1-0/"), true);
  assert.equal(result[0].source.license.includes("individual contents"), true);
  assert.match(result[0].note, /not an approved JBAE productType/u);
  assert.match(requestedUrl, /api\/v3\/product\/3560070791460\.json/u);
  assert.match(requestedUrl, /fields=/u);
  assert.match(requestedUrl, /product_type=beauty/u);
  assert.match(requestedHeaders["User-Agent"] ?? requestedHeaders["Api-User-Agent"], /^JB Advisor Engine/u);
  assert.equal(Object.hasOwn(result[0], "image_url"), false);
});

test("Open Beauty Facts discovers bounded category candidates without assigning a JBAE product type", async () => {
  const requested = [];
  const provider = createOpenBeautyFactsResearchProvider({
    fetchImpl: async url => {
      requested.push(new URL(String(url)));
      return response({
        count: 1,
        products: [{
          code: "3560070791460",
          product_name: "Example Body Mist",
          brands: "Example Brand",
          categories: "Body mists",
          categories_tags: ["en:body-mists"],
          ingredients_text: "Aqua, parfum",
          product_quantity: "150",
          product_quantity_unit: "ml",
        }],
      });
    },
    clock: fixedClock,
    minRequestIntervalMs: 0,
  });

  const records = await provider.search({
    domain: DOMAINS.FRAGRANCE,
    query: "category:body-mists",
    field: "name",
    limit: 2,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].value, "Example Body Mist");
  assert.equal(records[0].id, "3560070791460");
  assert.equal(records[0].confidence, 0.55);
  assert.match(records[0].note, /not an approved JBAE productType/u);
  assert.equal(records[0].source.name, "Open Beauty Facts");
  assert.match(records[0].source.license, /ODbL 1\.0/u);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].pathname, "/api/v2/search");
  assert.equal(requested[0].searchParams.get("categories_tags_en"), "body-mists");
  assert.equal(requested[0].searchParams.get("page"), "1");
  assert.equal(requested[0].searchParams.get("page_size"), "2");
  assert.match(requested[0].searchParams.get("fields"), /categories_tags/u);
  assert.equal(Object.hasOwn(records[0], "image_url"), false);
});

test("Open Beauty Facts supports bounded page 3 and rejects page 4 without a request", async () => {
  const requested = [];
  const provider = createOpenBeautyFactsResearchProvider({
    fetchImpl: async url => {
      requested.push(new URL(String(url)));
      return response({ products: [] });
    },
    minRequestIntervalMs: 0,
  });
  await provider.search({
    query: "category:body-mists",
    field: "name",
    page: 3,
    limit: 10,
  });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].searchParams.get("page"), "3");
  assert.equal(requested[0].searchParams.get("page_size"), "10");
  await assert.rejects(
    () => provider.search({
      query: "category:body-mists",
      field: "name",
      page: 4,
    }),
    /page must be an integer between 1 and 3/u,
  );
  assert.equal(requested.length, 1);
});

test("Open Beauty Facts category discovery rejects free text, malformed tags and out-of-scope categories", async () => {
  let calls = 0;
  const provider = createOpenBeautyFactsResearchProvider({
    fetchImpl: async () => {
      calls += 1;
      return response({ products: [] });
    },
    minRequestIntervalMs: 0,
  });
  await assert.rejects(
    () => provider.search({ query: "body mist", field: "name" }),
    /category:<taxonomy-slug>/u,
  );
  await assert.rejects(
    () => provider.search({ query: "category:body mists", field: "name" }),
    /category:<taxonomy-slug>/u,
  );
  await assert.rejects(
    () => provider.search({ query: "category:body-sprays", field: "name" }),
    /Only category:body-mists/u,
  );
  await assert.rejects(
    () => provider.search({ query: "category:body-creams", field: "name" }),
    /Only category:body-mists/u,
  );
  assert.equal(calls, 0);
});

test("Open Beauty Facts returns a review-ready body-mist record without images or an inferred product type", async () => {
  const provider = createOpenBeautyFactsResearchProvider({
    fetchImpl: async () => response({
      count: 1,
      products: [{
        code: "12345678",
        product_name: "Example Body Mist",
        brands: "Example",
        categories: "Body mists",
        categories_tags: ["en:body-mists"],
        ingredients_text: "Aqua, parfum",
        product_quantity: "250",
        product_quantity_unit: "ml",
        last_modified_t: 1794163200,
        image_url: "https://images.example/product.jpg",
      }],
    }),
    minRequestIntervalMs: 0,
  });
  const records = await provider.search({
    query: "category:body-mists",
    field: "product_record",
  });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].value, {
    barcode: "12345678",
    name: "Example Body Mist",
    brand: "Example",
    categories: "Body mists",
    categoryTags: ["en:body-mists"],
    ingredientsText: "Aqua, parfum",
    quantity: "250",
    quantityUnit: "ml",
    lastModifiedAt: 1794163200,
  });
  assert.match(records[0].note, /not an approved JBAE productType/u);
  assert.equal(Object.hasOwn(records[0], "image_url"), false);
});

test("Open Beauty Facts rejects a sun-care mist even when OBF also tags it as a body mist", async () => {
  const provider = createOpenBeautyFactsResearchProvider({
    fetchImpl: async () => response({
      count: 1,
      products: [{
        code: "8850029003177",
        product_name: "Nivea refreshing mist suncare",
        brands: "Beiersdorf, Nivea",
        categories: "Suncare, Body mists",
        categories_tags: ["en:suncare", "en:perfumes", "en:body-mists"],
        product_quantity: "200",
        product_quantity_unit: "ml",
      }],
    }),
    minRequestIntervalMs: 0,
  });
  assert.deepEqual(await provider.search({
    query: "category:body-mists",
    field: "product_record",
  }), []);
});

test("Open Beauty Facts rejects exact barcode records that are not tagged as body mists", async () => {
  const provider = createOpenBeautyFactsResearchProvider({
    fetchImpl: async () => response({
      status: 1,
      product: {
        code: "12345678",
        product_name: "Example Deodorant",
        categories_tags: ["en:deodorants"],
      },
    }),
    minRequestIntervalMs: 0,
  });
  assert.deepEqual(await provider.search({ query: "12345678", field: "name" }), []);
});

test("Open Beauty Facts validates barcode lookups and treats absent products or fields as empty", async () => {
  let calls = 0;
  const provider = createOpenBeautyFactsResearchProvider({
    fetchImpl: async () => {
      calls += 1;
      return response({ status: 0, product: null });
    },
    minRequestIntervalMs: 0,
  });
  await assert.rejects(
    () => provider.search({ query: "not-a-barcode", field: "name" }),
    /8-to-14 digit/u,
  );
  assert.deepEqual(
    await provider.search({ query: "3560070791460", field: "name" }),
    [],
  );
  assert.equal(calls, 1);
});

test("Open Beauty Facts exact barcode requests use a bounded response cache", async () => {
  let calls = 0;
  const provider = createOpenBeautyFactsResearchProvider({
    fetchImpl: async () => {
      calls += 1;
      return response({ status: 1, product: {
        code: "3560070791460",
        product_name: "Example Body Mist",
        categories_tags: ["en:body-mists"],
      } });
    },
    minRequestIntervalMs: 0,
  });
  const request = { query: "3560070791460", field: "name" };
  assert.equal((await provider.search(request))[0].value, "Example Body Mist");
  assert.equal((await provider.search(request))[0].value, "Example Body Mist");
  assert.equal(calls, 1);
});
