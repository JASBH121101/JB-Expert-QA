import test from "node:test";
import assert from "node:assert/strict";
import { compareProducts } from "../src/comparison/compare.js";
import { EvidenceStore } from "../src/core/evidence-store.js";

const phones = [
  { id: "a", name: "Phone A", domain: "technology", attributes: { performance: 90, battery: 80, price: 900 } },
  { id: "b", name: "Phone B", domain: "technology", attributes: { performance: 80, battery: 90, price: 600 } },
];

function evidenceInput({ id, subjectId, field = "performance", value, status = "verified", confidence = 0.9 }) {
  return {
    id,
    domain: "technology",
    subjectId,
    field,
    value,
    status,
    confidence,
    source: {
      name: `Source ${id}`,
      url: `https://example.com/${id}`,
      type: "independent_test",
    },
    observedAt: "2026-10-01T00:00:00.000Z",
  };
}

test("ranks products by explicit weighted criteria and direction", () => {
  const result = compareProducts({
    products: phones,
    criteria: [
      { field: "performance", weight: 4, direction: "higher" },
      { field: "battery", weight: 2, direction: "higher" },
      { field: "price", weight: 1, direction: "lower" },
    ],
  });
  assert.equal(result.decision, "ranked");
  assert.equal(result.ranking[0].id, "a");
  assert.equal(result.winnerId, "a");
  assert.equal(result.evidenceMode, "not_assessed");
  assert.equal(result.ranking[0].evidenceCoverage, null);
});

test("reports missing data and coverage instead of inventing values", () => {
  const result = compareProducts({
    products: [
      phones[0],
      { id: "c", name: "Phone C", domain: "technology", attributes: { performance: 70 } },
    ],
    criteria: [
      { field: "performance", weight: 1, direction: "higher" },
      { field: "battery", weight: 1, direction: "higher" },
    ],
  });
  const missing = result.ranking.find(item => item.id === "c");
  assert.deepEqual(missing.missingFields, ["battery"]);
  assert.equal(missing.coverage, 50);
  assert.equal(missing.scoredCoverage, 50);
});

test("does not compare fragrance and technology products together", () => {
  assert.throws(() => compareProducts({
    products: [phones[0], { id: "p", name: "Perfume", domain: "fragrance", attributes: { longevity: 8 } }],
    criteria: [{ field: "performance", weight: 1 }],
  }), /different domains/);
});

test("rejects more than four products, duplicate IDs and invalid weights", () => {
  const fiveProducts = [
    ...phones,
    ...["c", "d", "e"].map(id => ({
      id,
      name: `Phone ${id.toUpperCase()}`,
      domain: "technology",
      attributes: { performance: 70, battery: 70, price: 700 },
    })),
  ];
  assert.equal(fiveProducts.length, 5);
  assert.throws(() => compareProducts({ products: fiveProducts, criteria: [{ field: "performance", weight: 1 }] }), /between 2 and 4/);
  assert.throws(() => compareProducts({ products: phones, criteria: [{ field: "performance", weight: 0 }] }), /positive/);
  assert.throws(() => compareProducts({ products: [phones[0], phones[0]], criteria: [{ field: "performance", weight: 1 }] }), /unique/);
});

test("returns tie or insufficient data instead of inventing a winner", () => {
  const tied = compareProducts({
    products: phones.map(product => ({ ...product, attributes: { ...product.attributes, performance: 85 } })),
    criteria: [{ field: "performance", weight: 1 }],
  });
  assert.equal(tied.decision, "tie");
  const empty = compareProducts({
    products: [
      { id: "x", name: "X", domain: "technology", attributes: {} },
      { id: "y", name: "Y", domain: "technology", attributes: {} },
    ],
    criteria: [{ field: "battery", weight: 1 }],
  });
  assert.equal(empty.decision, "insufficient_data");
  assert.equal(empty.winnerId, null);
});

test("match criteria require and honor an explicit preference", () => {
  const result = compareProducts({
    products: [
      { id: "dark", name: "Dark", domain: "fragrance", attributes: { profile: "woody" } },
      { id: "fresh", name: "Fresh", domain: "fragrance", attributes: { profile: "fresh" } },
    ],
    criteria: [{ field: "profile", weight: 1, direction: "match", target: "fresh" }],
  });
  assert.equal(result.winnerId, "fresh");
  assert.throws(() => compareProducts({
    products: [
      { id: "a", name: "A", domain: "fragrance", attributes: { profile: "woody" } },
      { id: "b", name: "B", domain: "fragrance", attributes: { profile: "fresh" } },
    ],
    criteria: [{ field: "profile", weight: 1, direction: "match" }],
  }), /target/);
});

test("ranks fragrance intensity, projection and sillage as explicit ordinal levels", () => {
  const result = compareProducts({
    products: [
      { id: "soft", name: "Soft", domain: "fragrance", productType: "perfume",
        attributes: { intensityLevel: "soft" } },
      { id: "moderate", name: "Moderate", domain: "fragrance", productType: "perfume",
        attributes: { intensityLevel: "moderate" } },
      { id: "strong", name: "Strong", domain: "fragrance", productType: "perfume",
        attributes: { intensityLevel: "strong" } },
    ],
    criteria: [{ field: "intensityLevel", weight: 1, direction: "lower" }],
  });
  assert.equal(result.ranking[0].id, "soft");
  assert.equal(result.ranking[1].id, "moderate");
  assert.equal(result.ranking[2].id, "strong");
  assert.equal(result.ranking[0].score, 100);
  assert.equal(result.ranking[2].score, 0);
});

test("evidence-linked comparison scores only claims supported by verified evidence", () => {
  const store = new EvidenceStore();
  store.add(evidenceInput({ id: "a-performance", subjectId: "a", value: 90, confidence: 0.96 }));
  store.add(evidenceInput({ id: "b-performance", subjectId: "b", value: 80, confidence: 0.88 }));

  const result = compareProducts({
    products: [
      { ...phones[0], evidenceIds: { performance: ["a-performance"] } },
      { ...phones[1], evidenceIds: { performance: ["b-performance"] } },
    ],
    criteria: [{ field: "performance", weight: 1, direction: "higher" }],
    evidenceStore: store,
  });

  assert.equal(result.evidenceMode, "strict");
  assert.equal(result.winnerId, "a");
  assert.equal(result.ranking[0].evidenceCoverage, 100);
  assert.equal(result.ranking[0].verifiedCoverage, 100);
  assert.equal(result.ranking[0].evidenceConfidence, 0.96);
  assert.deepEqual(result.ranking[0].breakdown[0].evidence.evidenceIds, ["a-performance"]);
});

test("excludes reported-only claims by default and allows them only by explicit policy", () => {
  const store = new EvidenceStore();
  store.add(evidenceInput({ id: "a-reported", subjectId: "a", value: 90, status: "reported", confidence: 0.7 }));
  store.add(evidenceInput({ id: "b-verified", subjectId: "b", value: 80, confidence: 0.9 }));
  const products = [
    { ...phones[0], evidenceIds: { performance: ["a-reported"] } },
    { ...phones[1], evidenceIds: { performance: ["b-verified"] } },
  ];
  const criteria = [{ field: "performance", weight: 1, direction: "higher" }];

  const strict = compareProducts({ products, criteria, evidenceStore: store });
  assert.equal(strict.winnerId, "b");
  assert.equal(strict.ranking.find(item => item.id === "a").score, null);
  assert.equal(strict.ranking.find(item => item.id === "a").excludedFields[0].reason, "reported_only");

  const permissive = compareProducts({
    products,
    criteria,
    evidenceStore: store,
    evidencePolicy: { allowReported: true },
  });
  assert.equal(permissive.ranking.find(item => item.id === "a").score, 100);
  assert.equal(permissive.ranking.find(item => item.id === "a").evidenceCoverage, 100);
  assert.equal(permissive.ranking.find(item => item.id === "a").verifiedCoverage, 0);
});

test("rejects evidence references that do not match subject, field or value", () => {
  const store = new EvidenceStore();
  store.add(evidenceInput({ id: "wrong-subject", subjectId: "b", value: 80 }));
  assert.throws(() => compareProducts({
    products: [
      { ...phones[0], evidenceIds: { performance: ["wrong-subject"] } },
      { ...phones[1] },
    ],
    criteria: [{ field: "performance", weight: 1 }],
    evidenceStore: store,
  }), /does not match product/);

  store.add(evidenceInput({ id: "wrong-value", subjectId: "a", value: 89 }));
  assert.throws(() => compareProducts({
    products: [
      { ...phones[0], evidenceIds: { performance: ["wrong-value"] } },
      { ...phones[1] },
    ],
    criteria: [{ field: "performance", weight: 1 }],
    evidenceStore: store,
  }), /does not support the supplied value/);
});

test("does not score unresolved conflicting evidence", () => {
  const store = new EvidenceStore();
  store.add(evidenceInput({ id: "a-claim-1", subjectId: "a", value: 90, confidence: 0.9 }));
  store.add(evidenceInput({ id: "a-claim-2", subjectId: "a", value: 75, confidence: 0.8 }));
  store.add(evidenceInput({ id: "b-claim", subjectId: "b", value: 80, confidence: 0.9 }));
  const result = compareProducts({
    products: [
      { ...phones[0], evidenceIds: { performance: ["a-claim-1"] } },
      { ...phones[1], evidenceIds: { performance: ["b-claim"] } },
    ],
    criteria: [{ field: "performance", weight: 1 }],
    evidenceStore: store,
  });
  const phoneA = result.ranking.find(item => item.id === "a");
  assert.equal(phoneA.score, null);
  assert.equal(phoneA.excludedFields[0].reason, "conflict");
  assert.equal(phoneA.evidenceCoverage, 0);
  assert.equal(result.winnerId, "b");
});

test("validates evidence policy and evidence ID collections", () => {
  assert.throws(() => compareProducts({
    products: [
      { ...phones[0], evidenceIds: { performance: "not-an-array" } },
      phones[1],
    ],
    criteria: [{ field: "performance", weight: 1 }],
    evidenceStore: new EvidenceStore(),
  }), /must be an array/);
  assert.throws(() => compareProducts({
    products: phones,
    criteria: [{ field: "performance", weight: 1 }],
    evidencePolicy: { allowReported: "yes" },
  }), /must be a boolean/);
});

test("unverified values cannot distort relative normalization of verified products", () => {
  const store = new EvidenceStore();
  const productC = {
    id: "c",
    name: "Phone C",
    domain: "technology",
    attributes: { performance: 60 },
    evidenceIds: { performance: ["c-performance"] },
  };
  store.add(evidenceInput({ id: "b-performance", subjectId: "b", value: 80, confidence: 0.9 }));
  store.add(evidenceInput({ id: "c-performance", subjectId: "c", value: 60, confidence: 0.9 }));

  const result = compareProducts({
    products: [
      { ...phones[0], attributes: { performance: 100 } },
      { ...phones[1], attributes: { performance: 80 }, evidenceIds: { performance: ["b-performance"] } },
      productC,
    ],
    criteria: [{ field: "performance", weight: 1 }],
    evidenceStore: store,
  });

  assert.equal(result.ranking.find(item => item.id === "a").score, null);
  assert.equal(result.ranking.find(item => item.id === "b").score, 100);
  assert.equal(result.ranking.find(item => item.id === "c").score, 0);
  assert.equal(result.winnerId, "b");
});
