import test from "node:test";
import assert from "node:assert/strict";

const values = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) { values.set(key, String(value)); }
};
await import("../assets/js/store.js");
const store = globalThis.NexoraStore;

test("HTML escaping encodes markup-sensitive characters", () => {
  assert.equal(store.escapeHTML(`<script a="b">&'x'</script>`), "&lt;script a=&quot;b&quot;&gt;&amp;&#39;x&#39;&lt;/script&gt;");
});

test("product data is copied and can be stored by business", () => {
  const business = { id: "test-business", products: [{ id: "p1", name: "Sample" }] };
  const products = store.getProducts(business);
  products.push({ id: "p2", name: "Second" });
  assert.equal(store.getProducts(business).length, 1);
  assert.equal(store.saveProducts(business.id, products), true);
  assert.equal(store.getProducts(business).length, 2);
});

test("WhatsApp links normalize numbers and encode message text", () => {
  const link = store.whatsappURL("+505 0000-0000", "Hola NEXORA & demo");
  assert.ok(link.startsWith("https://wa.me/50500000000?text="));
  assert.ok(link.includes("Hola%20NEXORA%20%26%20demo"));
  assert.equal(store.whatsappURL("123", "Hola"), "");
});
