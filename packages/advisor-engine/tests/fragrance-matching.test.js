import test from "node:test";
import assert from "node:assert/strict";
import { matchFragrances } from "../src/domains/fragrance/matching.js";

const products = [
  {
    id: "soft-fresh", name: "Soft Fresh", domain: "fragrance", productType: "perfume",
    attributes: {
      scentFamilies: ["Cítrica", "Aromática"], topNotes: ["Bergamot", "Lemon"],
      middleNotes: ["Lavender"], baseNotes: ["Musk"], characterTraits: ["clean", "fresh"],
      timesOfDay: ["day"], climateTags: ["hot_humid"],
      intensityLevel: "soft", projectionLevel: "close",
    },
  },
  {
    id: "sweet-heavy", name: "Sweet Heavy", domain: "fragrance", productType: "perfume",
    attributes: {
      scentFamilies: ["Oriental", "Gourmand"], topNotes: ["Vanilla", "Caramel"],
      baseNotes: ["Amber"], characterTraits: ["sweet", "warm"],
      timesOfDay: ["evening"], climateTags: ["cold"],
      intensityLevel: "strong", projectionLevel: "strong",
    },
  },
];

test("matches preferences with an explainable weighted breakdown", () => {
  const result = matchFragrances({
    products,
    preferences: {
      preferredFamilies: ["citrica"],
      preferredNotes: ["bergamot", "lavender"],
      preferredCharacters: ["fresh"],
      occasion: "day",
      climate: "hot_humid",
      intensity: "soft",
      projection: "close",
    },
  });
  assert.equal(result.decision, "matched");
  assert.equal(result.ranking[0].id, "soft-fresh");
  assert.equal(result.ranking[0].eligibility, "eligible");
  assert.ok(result.ranking[0].breakdown.length >= 6);
  assert.ok(result.ranking[0].matchedCriteria.includes("scentFamilies"));
  assert.ok(result.ranking[0].explanation.reasons.length >= 4);
  assert.match(result.ranking[0].explanation.headline, /coincide/u);
  assert.match(result.ranking[0].explanation.evidenceNote, /no certifica/u);
});

test("does not penalize customers who specify only one preference dimension", () => {
  const result = matchFragrances({
    products,
    preferences: { preferredFamilies: ["citrica"] },
  });
  assert.equal(result.ranking[0].id, "soft-fresh");
  assert.equal(result.ranking[0].coverage, 100);
  assert.equal(result.ranking[0].eligibility, "eligible");
});

test("hard-excludes avoided notes and products with unverified exclusions", () => {
  const result = matchFragrances({
    products: [
      products[0],
      { id: "unknown", name: "Unknown Notes", domain: "fragrance", productType: "perfume", attributes: { intensityLevel: "soft" } },
    ],
    preferences: { avoidNotes: ["vanilla"], preferredFamilies: ["citrica"] },
  });
  assert.equal(result.ranking.find(item => item.id === "unknown").eligibility, "excluded");
  assert.ok(result.ranking.find(item => item.id === "unknown").exclusions.includes("avoidance_not_verifiable"));
});

test("does not claim an avoided note is absent when only a partial note pyramid exists", () => {
  const partial = {
    id: "partial", name: "Partial Notes", domain: "fragrance", productType: "perfume",
    attributes: { topNotes: ["citrus"], scentFamilies: ["citrica"] },
  };
  const result = matchFragrances({
    products: [partial],
    preferences: { avoidNotes: ["vanilla"], preferredFamilies: ["citrica"] },
  });
  assert.equal(result.ranking[0].eligibility, "excluded");
  assert.ok(result.ranking[0].exclusions.includes("avoidance_not_verifiable"));
});

test("filters product types and does not turn missing fields into matches", () => {
  const result = matchFragrances({
    products,
    preferences: { productTypes: ["body_mist"], preferredFamilies: ["citrica"] },
  });
  assert.equal(result.decision, "no_eligible_match");
  assert.ok(result.ranking.every(item => item.eligibility === "excluded"));
});

test("returns no eligible match when requested attributes are unavailable", () => {
  const result = matchFragrances({
    products: [{ id: "blank", name: "Blank", domain: "fragrance", productType: "perfume", attributes: {} }],
    preferences: { preferredNotes: ["rose"], climate: "hot_humid" },
  });
  assert.equal(result.decision, "no_eligible_match");
  assert.equal(result.ranking[0].eligibility, "insufficient_data");
  assert.equal(result.ranking[0].score, null);
});

test("validates preference input, product identity and coverage threshold", () => {
  assert.throws(() => matchFragrances({ products: [], preferences: {} }), /at least one/u);
  assert.throws(() => matchFragrances({ products, minimumMatchCoverage: 101 }), /between 0 and 100/u);
  assert.throws(() => matchFragrances({ products, preferences: { avoidNotes: "vanilla" } }), /array of non-empty strings/u);
  assert.throws(() => matchFragrances({ products: [products[0], products[0]] }), /unique/u);
});
