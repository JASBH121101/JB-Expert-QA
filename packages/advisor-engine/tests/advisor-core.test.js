import test from "node:test";
import assert from "node:assert/strict";
import { AdvisorCore, createAdvisorCore } from "../src/advisor/advisor-core.js";
import { KnowledgeStore, MemoryKnowledgeAdapter } from "../src/knowledge/knowledge-store.js";
import { EVIDENCE_STATUSES, SOURCE_TYPES } from "../src/core/evidence.js";
import { normalizeTechnologyProduct } from "../src/domains/technology/adapter.js";

const phones = [
  {
    id: "phone-a",
    name: "Phone A",
    deviceType: "smartphone",
    attributes: {
      cameraScore: 96,
      videoScore: 92,
      batteryLifeHours: 9,
      priceUSD: 850,
      storage: { value: 1, unit: "tb" },
    },
  },
  {
    id: "phone-b",
    name: "Phone B",
    deviceType: "smartphone",
    attributes: {
      cameraScore: 84,
      videoScore: 80,
      batteryLifeHours: 12,
      priceUSD: 700,
      storage: { value: 512, unit: "gb" },
    },
  },
];

const perfumes = [
  {
    id: "mist-a",
    name: "Fresh Mist",
    productType: "body_mist",
    attributes: {
      concentration: "not_applicable",
      climateSuitabilityScore: 94,
      versatilityScore: 90,
      projectionBalanceScore: 86,
      priceUSD: 18,
    },
  },
  {
    id: "mist-b",
    name: "Citrus Mist",
    productType: "body_mist",
    attributes: {
      concentration: "not_applicable",
      climateSuitabilityScore: 82,
      versatilityScore: 84,
      projectionBalanceScore: 82,
      priceUSD: 15,
    },
  },
];

const source = {
  name: "Independent test",
  url: "https://example.com/test",
  type: SOURCE_TYPES.INDEPENDENT_TEST,
};
const cameraEvidence = (id, value) => ({
  id,
  domain: "technology",
  subjectId: id === "ev-camera-a" ? "phone-a" : "phone-b",
  field: "cameraScore",
  value,
  status: EVIDENCE_STATUSES.VERIFIED,
  confidence: 0.93,
  source,
  observedAt: "2026-11-07T18:00:00.000Z",
});

test("orchestrates Technology Advisor normalization and recommendation", () => {
  const advisor = createAdvisorCore();
  const result = advisor.advise({
    domain: "technology",
    products: phones,
    profile: "photography_video",
  });
  assert.equal(result.engineId, "JBAE");
  assert.equal(result.domain, "technology");
  assert.equal(result.candidateCount, 2);
  assert.equal(result.recommendation.decision, "recommended");
  assert.equal(result.recommendation.winnerId, "phone-a");
  assert.equal(result.products[0].category, "smartphone");
  assert.equal(result.evidence.mode, "not_assessed");
});

test("normalizes storage units and keeps the original advisor request immutable", () => {
  const request = structuredClone({
    domain: "technology",
    products: phones,
    profile: "balanced",
  });
  const normalized = normalizeTechnologyProduct(request.products[0]);
  const advisor = new AdvisorCore();
  const result = advisor.advise({ ...request, profile: "photography_video" });
  assert.equal(normalized.attributes.storageGB, 1024);
  assert.equal(phones[0].attributes.storage.value, 1);
  assert.equal(result.recommendation.ranking[0].id, "phone-a");
  assert.equal(Object.isFrozen(result.products), true);
});

test("orchestrates Fragrance Advisor with product-type separation", () => {
  const advisor = new AdvisorCore();
  const result = advisor.advise({
    domain: "fragrance",
    products: perfumes,
    profile: "hot_humid_daily",
  });
  assert.equal(result.recommendation.winnerId, "mist-a");
  assert.equal(result.products[0].category, "body_mist");
  assert.equal(result.performance[0].longevity.status, "unavailable");
  assert.equal(result.performance[0].longevity.reason, "range_not_provided");
});

test("evidence-linked orchestration uses KnowledgeStore records in strict mode", async () => {
  const knowledgeStore = await KnowledgeStore.open({
    adapter: new MemoryKnowledgeAdapter(),
    clock: () => new Date("2026-11-07T18:00:00.000Z"),
  });
  await knowledgeStore.addEvidence(cameraEvidence("ev-camera-a", 96));
  await knowledgeStore.addEvidence(cameraEvidence("ev-camera-b", 84));

  const advisor = new AdvisorCore({ knowledgeStore });
  const result = advisor.advise({
    domain: "technology",
    products: phones.map((product, index) => ({
      ...product,
      evidenceIds: { cameraScore: [index === 0 ? "ev-camera-a" : "ev-camera-b"] },
    })),
    priorities: [{ field: "cameraScore", weight: 1 }],
  });

  assert.equal(result.evidence.mode, "strict");
  assert.equal(result.evidence.recordCount, 2);
  assert.equal(result.recommendation.winnerId, "phone-a");
  assert.equal(result.recommendation.ranking[0].verifiedCoverage, 100);
});

test("does not mix technology or fragrance product categories", () => {
  const advisor = new AdvisorCore();
  assert.throws(() => advisor.advise({
    domain: "technology",
    products: [
      phones[0],
      { ...phones[1], deviceType: "laptop" },
    ],
    priorities: [{ field: "performanceScore", weight: 1 }],
  }), /different device types/);

  assert.throws(() => advisor.advise({
    domain: "fragrance",
    products: [
      perfumes[0],
      { ...perfumes[1], productType: "perfume", attributes: { longevityHours: 7 } },
    ],
    priorities: [{ field: "climateSuitabilityScore", weight: 1 }],
  }), /different fragrance product types/);
});

test("rejects cross-domain, duplicate and malformed requests", () => {
  const advisor = new AdvisorCore();
  assert.throws(() => advisor.advise({ domain: "finance", products: phones }), /domain/);
  assert.throws(() => advisor.advise({ domain: "technology", products: [phones[0]] }), /between 2 and 4/);
  assert.throws(() => advisor.advise({
    domain: "technology",
    products: [phones[0], { ...phones[1], id: phones[0].id }],
    profile: "balanced",
  }), /IDs must be unique/);
  assert.throws(() => advisor.advise(null), /must be an object/);
});

test("refuses ambiguous evidence-store configuration", () => {
  assert.throws(() => new AdvisorCore({
    knowledgeStore: { getEvidenceStore: () => null },
    evidenceStore: { getById: () => null, conflicts: () => [] },
  }), /either knowledgeStore or evidenceStore/);
  assert.throws(() => new AdvisorCore({ minimumScoredCoverage: 101 }), /between 0 and 100/);
});

test("reports insufficient coverage instead of inventing a winner", () => {
  const advisor = new AdvisorCore({ minimumScoredCoverage: 80 });
  const result = advisor.advise({
    domain: "technology",
    products: [
      { id: "a", name: "A", deviceType: "smartphone", attributes: { cameraScore: 98 } },
      { id: "b", name: "B", deviceType: "smartphone", attributes: { cameraScore: 80 } },
    ],
    priorities: [
      { field: "cameraScore", weight: 1 },
      { field: "batteryLifeHours", weight: 1 },
    ],
  });
  assert.equal(result.recommendation.decision, "insufficient_coverage");
  assert.equal(result.recommendation.winnerId, null);
});


test("integrates explainable fragrance preference matching into Fragrance Advisor", () => {
  const advisor = new AdvisorCore();
  const candidates = [
    {
      id: "soft-citrus", name: "Soft Citrus", productType: "perfume",
      attributes: {
        scentFamilies: ["citrus"], allNotes: ["bergamot", "lemon", "musk"],
        intensityLevel: "soft", projectionLevel: "close",
        timesOfDay: ["day"], climateTags: ["hot_humid"],
      },
    },
    {
      id: "sweet-evening", name: "Sweet Evening", productType: "perfume",
      attributes: {
        scentFamilies: ["gourmand"], allNotes: ["vanilla", "caramel", "amber"],
        intensityLevel: "strong", projectionLevel: "strong",
        timesOfDay: ["evening"], climateTags: ["cold"],
      },
    },
  ];
  const result = advisor.advise({
    domain: "fragrance",
    products: candidates,
    profile: "hot_humid_daily",
    preferences: {
      preferredFamilies: ["citrus"],
      preferredNotes: ["bergamot"],
      avoidNotes: ["vanilla"],
      occasion: "day",
      climate: "hot_humid",
      intensity: "soft",
      projection: "close",
    },
  });
  assert.equal(result.preferenceMatch.decision, "matched");
  assert.equal(result.preferenceMatch.ranking[0].id, "soft-citrus");
  assert.equal(result.preferenceMatch.ranking[0].eligibility, "eligible");
  assert.equal(result.performance[0].longevity.status, "unavailable");
});

test("keeps preference matching absent for technology requests", () => {
  const result = new AdvisorCore().advise({
    domain: "technology",
    products: phones,
    profile: "balanced",
  });
  assert.equal(result.preferenceMatch, null);
});


test("parses a Spanish customer request into explicit fragrance preferences", () => {
  const candidates = [
    {
      id: "soft-citrus", name: "Soft Citrus", productType: "perfume",
      attributes: {
        scentFamilies: ["citrus"], allNotes: ["bergamot", "lemon", "musk"],
        characterTraits: ["fresh", "clean"], intensityLevel: "soft", projectionLevel: "close", sillageLevel: "moderate",
        timesOfDay: ["day", "office"], climateTags: ["hot_humid"],
      },
    },
    {
      id: "sweet-heavy", name: "Sweet Heavy", productType: "perfume",
      attributes: {
        scentFamilies: ["gourmand"], allNotes: ["vanilla", "caramel", "amber"],
        characterTraits: ["sweet", "warm"], intensityLevel: "strong", projectionLevel: "strong",
        timesOfDay: ["evening"], climateTags: ["cold"],
      },
    },
  ];
  const result = new AdvisorCore().advise({
    domain: "fragrance",
    products: candidates,
    customerMessage: "Busco algo fresco y suave para el día a día, para trabajar, que no sea hostigoso y que dure bastante.",
  });
  assert.equal(result.customerIntent.needsClarification, false);
  assert.equal(result.customerIntent.preferences.intensity, "soft");
  assert.equal(result.customerIntent.preferences.projection, "close");
  assert.equal(result.customerIntent.preferences.occasion, "day");
  assert.equal(result.customerIntent.preferences.performancePriority, "long_lasting");
  assert.equal(result.preferenceMatch.decision, "matched");
  assert.equal(result.preferenceMatch.ranking[0].id, "soft-citrus");
  assert.equal(result.recommendation.profile, "long_lasting");
  assert.equal(result.customerExplanation.decision, "recommended");
  assert.match(result.customerExplanation.text, /Soft Citrus/u);
  assert.match(result.customerExplanation.text, /no tengo un rango de rendimiento respaldado/iu);
});

test("explicit structured preferences override inferred customer-message preferences", () => {
  const candidates = [
    {
      id: "soft", name: "Soft", productType: "perfume",
      attributes: { intensityLevel: "soft", projectionLevel: "close", scentFamilies: ["citrus"] },
    },
    {
      id: "strong", name: "Strong", productType: "perfume",
      attributes: { intensityLevel: "strong", projectionLevel: "strong", scentFamilies: ["woody"] },
    },
  ];
  const result = new AdvisorCore().advise({
    domain: "fragrance",
    products: candidates,
    customerMessage: "Quiero algo suave y discreto.",
    preferences: { intensity: "strong", projection: "strong" },
  });
  assert.equal(result.preferenceMatch.requestedPreferences.intensity, "strong");
  assert.equal(result.preferenceMatch.requestedPreferences.projection, "strong");
});

test("reports clarification when a customer message contains no recognized fragrance intent", () => {
  const result = new AdvisorCore().advise({
    domain: "fragrance",
    products: perfumes,
    customerMessage: "Quiero algo especial.",
  });
  assert.equal(result.customerIntent.needsClarification, true);
  assert.equal(result.preferenceMatch, null);
  assert.equal(result.customerExplanation.decision, "needs_clarification");
});
