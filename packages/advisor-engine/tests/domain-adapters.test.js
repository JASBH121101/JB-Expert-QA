import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTechnologyProduct } from "../src/domains/technology/adapter.js";
import { normalizeFragranceProduct } from "../src/domains/fragrance/adapter.js";

test("technology adapter supports the expanded device categories without crossing domains", () => {
  assert.equal(normalizeTechnologyProduct({
    id: "phone-1", name: "Phone One", deviceType: "smartphone", attributes: {},
  }).domain, "technology");
  assert.equal(normalizeTechnologyProduct({
    id: "watch", name: "Watch", deviceType: "smartwatch", attributes: {},
  }).deviceType, "smartwatch");
  assert.throws(() => normalizeTechnologyProduct({
    id: "unknown", name: "Unknown", deviceType: "spaceship", attributes: {},
  }), /deviceType/);
});

test("technology adapter normalizes explicit storage, display and weight units", () => {
  const product = normalizeTechnologyProduct({
    id: "laptop-1", name: "Laptop One", deviceType: "laptop",
    attributes: {
      ram: { value: 16, unit: "GB" },
      storage: { value: 1, unit: "TB" },
      displaySize: { value: 40.64, unit: "cm" },
      weight: { value: 1.5, unit: "kg" },
      brightness: { value: 400, unit: "nits" },
    },
  });
  assert.equal(product.attributes.ramGB, 16);
  assert.equal(product.attributes.storageGB, 1024);
  assert.equal(Number(product.attributes.displaySizeInches.toFixed(2)), 16);
  assert.equal(product.attributes.weightGrams, 1500);
  assert.equal(product.attributes.displayBrightnessNits, 400);
});

test("technology adapter rejects ambiguous units and out-of-range scores", () => {
  assert.throws(() => normalizeTechnologyProduct({
    id: "a", name: "A", deviceType: "smartphone",
    attributes: { storage: { value: 1, unit: "TB" }, storageGB: 512 },
  }), /either/);
  assert.throws(() => normalizeTechnologyProduct({
    id: "a", name: "A", deviceType: "smartphone",
    attributes: { cameraScore: 120 },
  }), /between 0 and 100/);
});

test("fragrance adapter keeps product type and perfume concentration separate", () => {
  const mist = normalizeFragranceProduct({
    id: "mist-1", name: "Body Mist", productType: "body_mist",
    attributes: { volume: { value: 0.25, unit: "L" } },
  });
  assert.equal(mist.attributes.volumeMl, 250);
  assert.equal(mist.productType, "body_mist");
  assert.throws(() => normalizeFragranceProduct({
    id: "mist-2", name: "Body Mist", productType: "body_mist",
    attributes: { concentration: "edp" },
  }), /must not inherit perfume concentration/);
});

test("fragrance adapter preserves performance ranges without inventing a single value", () => {
  const product = normalizeFragranceProduct({
    id: "perfume-1", name: "Perfume One", productType: "perfume",
    attributes: {
      concentration: "edp",
      longevityRange: { min: 5, max: 8 },
      topNotes: ["Bergamot", "Citrus", "Bergamot"],
    },
  });
  assert.equal(product.attributes.longevityMinHours, 5);
  assert.equal(product.attributes.longevityMaxHours, 8);
  assert.equal(product.attributes.longevityHours, undefined);
  assert.deepEqual(product.attributes.topNotes, ["Bergamot", "Citrus"]);
});

test("fragrance adapter normalizes projection-duration intervals and discrete performance levels", () => {
  const product = normalizeFragranceProduct({
    id: "perfume-performance", name: "Performance Test", productType: "perfume",
    attributes: {
      projectionDurationRange: { min: 1, max: 3 },
      intensityLevel: "soft",
      projectionLevel: "close",
      sillageLevel: "low",
    },
  });
  assert.equal(product.attributes.projectionDurationMinHours, 1);
  assert.equal(product.attributes.projectionDurationMaxHours, 3);
  assert.equal(product.attributes.intensityLevel, "soft");
  assert.equal(product.attributes.projectionLevel, "close");
  assert.equal(product.attributes.sillageLevel, "low");
  assert.throws(() => normalizeFragranceProduct({
    id: "incomplete", name: "Incomplete", productType: "perfume",
    attributes: { longevityMinHours: 4 },
  }), /requires both minimum and maximum/);
  assert.throws(() => normalizeFragranceProduct({
    id: "invalid-level", name: "Invalid", productType: "perfume",
    attributes: { intensityLevel: "nuclear" },
  }), /intensityLevel/);
});

test("fragrance taxonomy keeps decants and traditional attars distinct", () => {
  assert.throws(() => normalizeFragranceProduct({
    id: "decant-missing-parent", name: "Decant", productType: "decant",
    attributes: { volumeMl: 5 },
  }), /canonical parentFragranceId/);
  const decant = normalizeFragranceProduct({
    id: "decant-5ml", name: "Decant 5 ml", productType: "decant",
    attributes: { volumeMl: 5, parentFragranceId: "canonical:perfume-1", concentration: "edp" },
  });
  const attar = normalizeFragranceProduct({
    id: "attar-1", name: "Traditional Attar", productType: "traditional_attar",
    attributes: {},
  });
  assert.equal(decant.productType, "decant");
  assert.equal(decant.attributes.parentFragranceId, "canonical:perfume-1");
  assert.equal(decant.attributes.concentration, "edp");
  assert.equal(attar.productType, "traditional_attar");
});

test("fragrance adapter validates measured values and scent scoring fields", () => {
  assert.throws(() => normalizeFragranceProduct({
    id: "bad", name: "Bad", productType: "perfume",
    attributes: { longevityRange: { min: 8, max: 3 } },
  }), /longevityRange/);
  assert.throws(() => normalizeFragranceProduct({
    id: "bad", name: "Bad", productType: "perfume",
    attributes: { versatilityScore: 120 },
  }), /between 0 and 100/);
});

test("both domain adapters reject malformed evidence ID containers", () => {
  assert.throws(() => normalizeTechnologyProduct({
    id: "phone-x", name: "Phone X", deviceType: "smartphone",
    attributes: {}, evidenceIds: ["not", "an", "object"],
  }), /evidenceIds must be an object/);
  assert.throws(() => normalizeFragranceProduct({
    id: "perfume-x", name: "Perfume X", productType: "perfume",
    attributes: {}, evidenceIds: "bad",
  }), /evidenceIds must be an object/);
});

test("fragrance adapter keeps body products separate from perfume product types", () => {
  const perfume = normalizeFragranceProduct({
    id: "p", name: "Perfume", productType: "perfume", attributes: { concentration: "edp" },
  });
  const mist = normalizeFragranceProduct({
    id: "m", name: "Mist", productType: "body_mist", attributes: {},
  });
  assert.notEqual(perfume.productType, mist.productType);
});
