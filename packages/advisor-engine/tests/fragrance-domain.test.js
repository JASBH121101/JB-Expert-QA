import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFragranceProduct } from "../src/domains/fragrance/adapter.js";

const base = { id: "fr-1", name: "Fragrance", productType: "perfume", attributes: {} };

test("keeps fragrance product types and concentration independent", () => {
  const mist = normalizeFragranceProduct({
    ...base, productType: "body_mist",
    attributes: { volume: { value: 0.25, unit: "L" }, concentration: "not_applicable" },
  });
  assert.equal(mist.attributes.volumeMl, 250);
  assert.equal(mist.attributes.concentration, "not_applicable");
  assert.throws(() => normalizeFragranceProduct({
    ...base, productType: "body_mist", attributes: { concentration: "edp" },
  }), /must not inherit/);
});

test("preserves longevity ranges without inventing a midpoint", () => {
  const result = normalizeFragranceProduct({
    ...base, attributes: { longevityRange: { min: 4, max: 8 }, topNotes: ["Bergamot", " Bergamot ", "Lemon"] },
  });
  assert.equal(result.attributes.longevityMinHours, 4);
  assert.equal(result.attributes.longevityMaxHours, 8);
  assert.equal(result.attributes.longevityHours, undefined);
  assert.deepEqual(result.attributes.topNotes, ["Bergamot", "Lemon"]);
});

test("rejects invalid longevity ranges, concentrations and evidence IDs", () => {
  assert.throws(() => normalizeFragranceProduct({ ...base, attributes: { longevityRange: { min: 8, max: 4 } } }), /max >= min/);
  assert.throws(() => normalizeFragranceProduct({ ...base, attributes: { concentration: "super-edp" } }), /concentration/);
  assert.throws(() => normalizeFragranceProduct({ ...base, attributes: {}, evidenceIds: { notes: ["id", "id"] } }), /duplicate/);
});

test("deep-freezes copied nested attributes without mutating caller data", () => {
  const source = { accords: ["woody", "amber"] };
  const result = normalizeFragranceProduct({ ...base, attributes: source });
  source.accords.push("smoky");
  assert.deepEqual(result.attributes.accords, ["woody", "amber"]);
  assert.ok(Object.isFrozen(result.attributes.accords));
});
