import test from "node:test";
import assert from "node:assert/strict";
import { DOMAINS } from "../src/core/domains.js";
import { CatalogIndex } from "../src/knowledge/catalog-index.js";

const perfume = (id, name, overrides = {}) => ({
  id, name, domain: DOMAINS.FRAGRANCE, productType: "perfume",
  brand: "Parfums de Marly", aliases: [],
  attributes: { concentration: "edp", topNotes: ["Apple", "Bergamot"], ...overrides.attributes },
  ...overrides,
});
const phone = (id, name, overrides = {}) => ({
  id, name, domain: DOMAINS.TECHNOLOGY, deviceType: "smartphone",
  brand: "Samsung", model: "Galaxy S24 Ultra",
  attributes: { chipset: "Snapdragon 8 Gen 3", ramGB: 12, ...overrides.attributes },
  ...overrides,
});

test("catalog search is case and diacritic insensitive", () => {
  const index = new CatalogIndex([perfume("layton", "Laytón")]);
  assert.equal(index.search({ query: "layton" })[0].product.id, "layton");
});
test("exact ID, model and name matches outrank partial token matches", () => {
  const index = new CatalogIndex([
    phone("phone-one", "Galaxy S24 Ultra"),
    phone("phone-two", "Galaxy S24", { model: "Galaxy S24" }),
  ]);
  assert.equal(index.search({ query: "phone-one" })[0].product.id, "phone-one");
  assert.equal(index.search({ query: "Galaxy S24 Ultra" })[0].product.id, "phone-one");
});
test("supports alias and allowlisted domain attributes without searching arbitrary fields", () => {
  const index = new CatalogIndex([
    perfume("p1", "Aroma One", { aliases: ["Oud King"] }),
    perfume("p2", "Aroma Two", { attributes: { internalSecret: "needle" } }),
  ]);
  assert.equal(index.search({ query: "oud king", domain: DOMAINS.FRAGRANCE })[0].product.id, "p1");
  assert.equal(index.search({ query: "needle" }).length, 0);
});
test("filters domain, brand and device type independently", () => {
  const index = new CatalogIndex([
    phone("samsung", "Galaxy S24", { brand: "Samsung" }),
    phone("other", "Galaxy S24", { brand: "Other", model: "Galaxy S24" }),
    perfume("perfume", "Galaxy S24"),
  ]);
  assert.equal(index.search({ query: "Galaxy S24", domain: DOMAINS.TECHNOLOGY, brand: "Samsung", deviceType: "smartphone" }).length, 1);
});
test("ranking and ties are deterministic and result limits are bounded", () => {
  const index = new CatalogIndex([phone("b", "Galaxy S24"), phone("a", "Galaxy S24")]);
  assert.deepEqual(index.search({ query: "Galaxy S24" }).map(x => x.product.id), ["a", "b"]);
  assert.throws(() => index.search({ query: "Galaxy", limit: 51 }), /between/);
});
test("reports likely duplicates without silently deleting or merging records", () => {
  const index = new CatalogIndex([
    phone("phone-a", "Galaxy S24 Ultra"),
    phone("phone-b", "Galaxy S24 Ultra"),
  ]);
  assert.deepEqual(index.findPotentialDuplicates()[0].productIds, ["phone-a", "phone-b"]);
  assert.equal(index.findPotentialDuplicates()[0].reviewRequired, true);
  assert.equal(index.size, 2);
});
test("rejects mixed-domain invalid products and duplicate IDs", () => {
  assert.throws(() => new CatalogIndex([phone("same", "Phone"), phone("same", "Other")]), /Duplicate/);
  assert.throws(() => new CatalogIndex([{ id: "x", name: "bad", domain: "other" }]), /domain/);
});


test("catalog index can find identity matches across entries without merging records", async () => {
  const { CatalogIndex } = await import("../src/knowledge/catalog-index.js");
  const products = [
    {
      id: "local-1", domain: "technology", name: "Samsung Galaxy S25 Ultra",
      brand: "Samsung", model: "Galaxy S25 Ultra", deviceType: "smartphone",
      attributes: { ramGB: 12, storageGB: 256 },
    },
    {
      id: "local-2", domain: "technology", name: "Samsung Galaxy S24 Ultra",
      brand: "Samsung", model: "Galaxy S24 Ultra", deviceType: "smartphone",
      attributes: { ramGB: 12, storageGB: 256 },
    },
  ];
  const index = new CatalogIndex(products);
  const incoming = {
    id: "incoming", domain: "technology", name: "Samsung S25 Ultra",
    brand: "Samsung", model: "Galaxy S25 Ultra", deviceType: "smartphone",
    attributes: { ramGB: 12, storageGB: 256 },
  };
  const matches = index.findMatches(incoming, { minScore: 45 });
  assert.equal(matches[0].rightId, "local-1");
  assert.equal(index.size, 2);
});
