import test from "node:test";
import assert from "node:assert/strict";
import { compareNicaraguaRetailerOffers } from "../src/research/nicaragua-retailer-comparison.js";

const fixedTime = "2026-11-08T01:00:00.000Z";
const gtin = "8806097667995";
const mpn = "SMA175FZAFGTO";

function result(value, retailer) {
  return [{
    id: retailer + "-product",
    value,
    confidence: 0.9,
    source: {
      name: retailer,
      url: "https://example.com/" + retailer,
      type: "distributor",
      market: "NI",
    },
    observedAt: fixedTime,
    note: "Fixture only",
  }];
}

function fakeProvider({ name, identifiers = {}, price, availability = { status: "in_stock" }, color = null }) {
  const values = {
    name,
    sku: identifiers.sku ?? "470890800019",
    upc: identifiers.upc ?? null,
    gtin: Object.hasOwn(identifiers, "gtin") ? identifiers.gtin : gtin,
    mpn: Object.hasOwn(identifiers, "mpn") ? identifiers.mpn : mpn,
    color,
    price: price ?? { amount: 7399, currency: "NIO", taxIncluded: null, display: "C$7,399.00" },
    availability,
    warranty: "12 meses",
  };
  return {
    async search({ field }) {
      return values[field] === null || values[field] === undefined
        ? [] : result(values[field], "Fixture retailer");
    },
  };
}

const offers = [
  { retailer: "radioshack", url: "https://www.radioshackla.com/nicaragua/phone/p" },
  { retailer: "laCuracao", url: "https://www.lacuracaonline.com/nicaragua/phone/p" },
  { retailer: "siman", url: "https://ni.siman.com/phone/p" },
];

test("compares price only after every listing matches the exact same GTIN and variant", async () => {
  const provider = fakeProvider({
    name: "Samsung A17 4GB + 128GB Gris",
  });
  const resultValue = await compareNicaraguaRetailerOffers({
    offers,
    providers: { radioshack: provider, laCuracao: provider, siman: provider },
  });
  assert.equal(resultValue.identity.status, "exact_variant");
  assert.equal(resultValue.identity.matchedIdentifier, "gtin");
  assert.equal(resultValue.identity.pairwise.length, 3);
  assert.equal(resultValue.priceComparison.status, "comparable");
  assert.equal(resultValue.priceComparison.lowestPrice.amount, 7399);
  assert.equal(resultValue.decision, "pending_review");
  assert.equal(resultValue.changesVerifiedData, false);
});

test("blocks price ranking when a retailer returns a conflicting GTIN", async () => {
  const common = fakeProvider({ name: "Samsung A17 4GB + 128GB Gris" });
  const different = fakeProvider({
    name: "Samsung A17 4GB + 128GB Gris",
    identifiers: { gtin: "8806097668046" },
    price: { amount: 6999, currency: "NIO", taxIncluded: null },
  });
  const resultValue = await compareNicaraguaRetailerOffers({
    offers: offers.slice(0, 2),
    providers: { radioshack: common, laCuracao: different },
  });
  assert.equal(resultValue.identity.status, "mismatch");
  assert.equal(resultValue.priceComparison.status, "blocked_identity");
  assert.equal(resultValue.priceComparison.lowestPrice, null);
});

test("same barcode cannot conceal a conflicting RAM or storage configuration", async () => {
  const fourGb = fakeProvider({ name: "Samsung A17 4GB + 128GB Gris" });
  const eightGb = fakeProvider({ name: "Samsung A17 8GB + 128GB Gris" });
  const resultValue = await compareNicaraguaRetailerOffers({
    offers: offers.slice(0, 2),
    providers: { radioshack: fourGb, laCuracao: eightGb },
  });
  assert.equal(resultValue.identity.status, "review_required");
  assert.deepEqual(resultValue.identity.pairwise[0].variantConflicts, ["ramGB"]);
  assert.equal(resultValue.priceComparison.status, "blocked_identity");
});

test("retailer internal SKU mislabeled as UPC is not treated as a universal barcode", async () => {
  const skuOnly = fakeProvider({
    name: "Samsung A17 4GB + 128GB Gris",
    identifiers: { gtin: null, upc: "470890800019", mpn: null },
  });
  const withGtin = fakeProvider({
    name: "Samsung A17 4GB + 128GB Gris",
    identifiers: { gtin: null, upc: "470890800019", mpn: null },
  });
  const resultValue = await compareNicaraguaRetailerOffers({
    offers: offers.slice(0, 2),
    providers: { radioshack: skuOnly, laCuracao: withGtin },
  });
  assert.equal(resultValue.offers[0].status, "identity_incomplete");
  assert.equal(resultValue.identity.status, "incomplete");
  assert.equal(resultValue.priceComparison.status, "blocked_identity");
});

test("does not hide a conflicting second universal barcode when GTIN is present", async () => {
  const conflicting = fakeProvider({
    name: "Samsung A17 4GB + 128GB Gris",
    identifiers: { gtin, upc: "8806097668046" },
  });
  const clean = fakeProvider({ name: "Samsung A17 4GB + 128GB Gris" });
  const resultValue = await compareNicaraguaRetailerOffers({
    offers: offers.slice(0, 2),
    providers: { radioshack: conflicting, laCuracao: clean },
  });
  assert.equal(resultValue.identity.status, "mismatch");
  assert.equal(resultValue.priceComparison.status, "blocked_identity");
});

test("does not compare different currencies or tax-inclusion states", async () => {
  const nio = fakeProvider({
    name: "Samsung A17 4GB + 128GB Gris",
    price: { amount: 7399, currency: "NIO", taxIncluded: null },
  });
  const usd = fakeProvider({
    name: "Samsung A17 4GB + 128GB Gris",
    price: { amount: 200, currency: "USD", taxIncluded: null },
  });
  const resultValue = await compareNicaraguaRetailerOffers({
    offers: offers.slice(0, 2),
    providers: { radioshack: nio, laCuracao: usd },
  });
  assert.equal(resultValue.identity.status, "exact_variant");
  assert.equal(resultValue.priceComparison.status, "not_comparable");
  assert.equal(resultValue.priceComparison.lowestPrice, null);
});

test("returns deferred retailer status and refuses full-set certification", async () => {
  const good = fakeProvider({ name: "Samsung A17 4GB + 128GB Gris" });
  const broken = {
    async search() { throw new Error("fetch failed"); },
  };
  const resultValue = await compareNicaraguaRetailerOffers({
    offers,
    providers: { radioshack: good, laCuracao: good, siman: broken },
  });
  assert.equal(resultValue.offers[2].status, "deferred");
  assert.equal(resultValue.identity.status, "partial_exact_variant");
  assert.deepEqual(resultValue.identity.unresolvedRetailers, ["siman"]);
  assert.equal(resultValue.priceComparison.status, "partial_comparable");
  assert.equal(resultValue.priceComparison.scope, "matching_subset");
});


test("same phone family with different manufacturer model and color is rejected as a variant mismatch", async () => {
  const grey = fakeProvider({
    name: "Samsung Galaxy A17 4GB RAM 128GB Gris",
    identifiers: { gtin: null, mpn: "SMA175FZAFGTO" },
    color: "Gris",
  });
  const blue = fakeProvider({
    name: "Samsung Galaxy A17 4GB RAM 128GB",
    identifiers: { gtin: null, mpn: "SM-A175FZKFGTO" },
    color: "Azul",
    price: { amount: 7999.13, currency: "NIO", taxIncluded: null },
  });
  const resultValue = await compareNicaraguaRetailerOffers({
    offers: offers.slice(0, 2),
    providers: { radioshack: grey, laCuracao: blue },
  });
  assert.equal(resultValue.identity.status, "mismatch");
  assert.ok(resultValue.identity.pairwise[0].conflicts.includes("mpn"));
  assert.equal(resultValue.priceComparison.status, "blocked_identity");
});


test("same manufacturer identity with different explicit product colors requires review", async () => {
  const grey = fakeProvider({
    name: "Samsung Galaxy A17 4GB RAM 128GB",
    identifiers: { gtin: "8806097667995", mpn: "SMA175FZAFGTO" },
    color: "Gris",
  });
  const blue = fakeProvider({
    name: "Samsung Galaxy A17 4GB RAM 128GB",
    identifiers: { gtin: "8806097667995", mpn: "SMA175FZAFGTO" },
    color: "Azul",
    price: { amount: 7999.13, currency: "NIO", taxIncluded: null },
  });
  const resultValue = await compareNicaraguaRetailerOffers({
    offers: offers.slice(0, 2),
    providers: { radioshack: grey, laCuracao: blue },
  });
  assert.equal(resultValue.identity.status, "review_required");
  assert.deepEqual(resultValue.identity.pairwise[0].variantConflicts, ["color"]);
  assert.equal(resultValue.priceComparison.status, "blocked_identity");
});

test("validates retailer list, duplicates and supported IDs", async () => {
  await assert.rejects(
    () => compareNicaraguaRetailerOffers({ offers: [offers[0]] }),
    /between 2 and 3/u,
  );
  await assert.rejects(
    () => compareNicaraguaRetailerOffers({
      offers: [offers[0], { ...offers[1], retailer: "radioshack" }],
    }),
    /only once/u,
  );
  await assert.rejects(
    () => compareNicaraguaRetailerOffers({
      offers: [offers[0], { retailer: "conico", url: "https://example.com/product" }],
    }),
    /Unsupported retailer/u,
  );
});
