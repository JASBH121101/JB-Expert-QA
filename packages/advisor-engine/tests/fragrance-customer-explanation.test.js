import test from "node:test";
import assert from "node:assert/strict";
import { buildFragranceCustomerExplanation } from "../src/domains/fragrance/customer-explanation.js";

const preferenceMatch = {
  decision: "matched",
  ranking: [{
    id: "perfume-1",
    name: "Citrus Example",
    score: 92,
    coverage: 100,
    eligibility: "eligible",
    explanation: {
      reasons: ["Coincide con la familia olfativa que pidió el cliente."],
    },
  }],
};

test("customer copy includes only evidence-approved performance ranges", () => {
  const result = buildFragranceCustomerExplanation({
    preferenceMatch,
    performance: [{
      productId: "perfume-1",
      longevity: { status: "estimated", display: "5–7 hours (estimated)" },
      projectionDuration: { status: "estimated", display: "1–3 hours (estimated)" },
      intensity: { status: "estimated", label: "soft / suave" },
      projection: { status: "estimated", label: "cercana a la piel" },
    }],
  });
  assert.equal(result.decision, "recommended");
  assert.match(result.text, /5–7 hours/u);
  assert.match(result.text, /1–3 hours/u);
  assert.match(result.text, /no garantías/u);
});

test("customer copy never invents missing duration or projection ranges", () => {
  const result = buildFragranceCustomerExplanation({
    preferenceMatch,
    performance: [{
      productId: "perfume-1",
      longevity: { status: "unavailable", reason: "evidence_store_missing" },
      projectionDuration: { status: "unavailable", reason: "incomplete_evidence" },
    }],
  });
  assert.match(result.text, /no tengo un rango de rendimiento respaldado/iu);
  assert.doesNotMatch(result.text, /[0-9]+–[0-9]+ hours/u);
});

test("customer copy abstains when no candidate is eligible", () => {
  const result = buildFragranceCustomerExplanation({
    preferenceMatch: { decision: "no_eligible_match", ranking: [] },
  });
  assert.equal(result.decision, "no_eligible_match");
  assert.match(result.text, /no puedo justificar una recomendación fiable/u);
});
