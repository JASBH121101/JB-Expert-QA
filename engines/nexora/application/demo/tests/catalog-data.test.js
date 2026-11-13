import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
await import("../assets/js/data.js");
const demos = globalThis.NEXORA_DEMOS;

test("three distinct business demonstrations are configured", () => {
  assert.equal(demos.length, 3);
  assert.deepEqual(new Set(demos.map((item) => item.id)).size, 3);
  assert.deepEqual(new Set(demos.map((item) => item.name)).size, 3);
});

test("each sample product has valid category, price and image URL", () => {
  for (const business of demos) {
    assert.ok(business.name);
    assert.ok(Array.isArray(business.categories) && business.categories.length > 0);
    assert.ok(Array.isArray(business.products) && business.products.length > 0);
    for (const product of business.products) {
      assert.ok(product.id && product.name && product.description);
      assert.ok(business.categories.includes(product.category), product.name + " has an unknown category");
      assert.ok(Number.isFinite(product.price) && product.price >= 0, product.name + " has an invalid price");
      if (product.oldPrice !== null && product.oldPrice !== undefined) {
        assert.ok(Number.isFinite(product.oldPrice) && product.oldPrice > product.price);
      }
      assert.equal(new URL(product.image).protocol, "https:");
    }
  }
});

test("product identifiers are unique within each business", () => {
  for (const business of demos) {
    const ids = business.products.map((product) => product.id);
    assert.equal(new Set(ids).size, ids.length, business.name + " has duplicate product identifiers");
  }
});
