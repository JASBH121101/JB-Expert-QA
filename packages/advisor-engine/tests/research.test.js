import test from "node:test";
import assert from "node:assert/strict";
import { getSourcePolicy, assessSource } from "../src/research/source-policy.js";
import { createResearchCandidate } from "../src/research/research-candidate.js";
import { EVIDENCE_STATUSES, SOURCE_TYPES } from "../src/core/evidence.js";

test("source policy is domain and field aware", () => {
  const perfume = getSourcePolicy({ domain: "fragrance", field: "longevity" });
  const phone = getSourcePolicy({ domain: "technology", field: "price" });
  assert.ok(perfume.preferredTypes.includes(SOURCE_TYPES.INDEPENDENT_TEST));
  assert.ok(phone.preferredTypes.includes(SOURCE_TYPES.DISTRIBUTOR));
  assert.equal(phone.freshnessDays, 30);
  const ram = getSourcePolicy({ domain: "technology", field: "ram_capacity" });
  const storage = getSourcePolicy({ domain: "technology", field: "storage_capacity" });
  const cpu = getSourcePolicy({ domain: "technology", field: "cpu" });
  const gpu = getSourcePolicy({ domain: "technology", field: "gpu" });
  assert.ok(ram.preferredTypes.includes(SOURCE_TYPES.DATABASE));
  assert.ok(storage.preferredTypes.includes(SOURCE_TYPES.OFFICIAL));
  assert.ok(cpu.preferredTypes.includes(SOURCE_TYPES.INDEPENDENT_TEST));
  assert.ok(gpu.preferredTypes.includes(SOURCE_TYPES.DATABASE));
  assert.equal(ram.freshnessDays, 3650);
});

test("source assessment discounts non-preferred and stale sources", () => {
  const officialPrice = assessSource({
    domain: "technology", field: "price", sourceType: SOURCE_TYPES.OFFICIAL,
    observedAt: "2026-11-06T00:00:00.000Z", now: "2026-11-07T00:00:00.000Z",
  });
  const communityPrice = assessSource({
    domain: "technology", field: "price", sourceType: SOURCE_TYPES.COMMUNITY,
    observedAt: "2026-11-06T00:00:00.000Z", now: "2026-11-07T00:00:00.000Z",
  });
  assert.ok(officialPrice.reliability > communityPrice.reliability);
  assert.equal(officialPrice.preferred, true);
});

test("candidate is staged for review and never overwrites verified data", () => {
  const candidate = createResearchCandidate({
    id: "ev-price-1", domain: "technology", subjectId: "phone-x", field: "price",
    value: "$799", status: EVIDENCE_STATUSES.REPORTED, confidence: 0.7,
    source: { name: "Retailer", url: "https://example.com/phone", type: SOURCE_TYPES.DISTRIBUTOR },
    observedAt: "2026-11-07T10:00:00.000Z",
  }, { now: "2026-11-07T12:00:00.000Z" });
  assert.equal(candidate.decision, "pending_review");
  assert.equal(candidate.changesVerifiedData, false);
  assert.equal(candidate.evidence.value, "$799");
});

test("rejects candidates without source and invalid domain", () => {
  assert.throws(() => createResearchCandidate({
    id: "ev-1", domain: "technology", subjectId: "phone", field: "price",
    value: "$10", status: EVIDENCE_STATUSES.NOT_FOUND, confidence: 0,
    source: null, observedAt: "2026-11-07T10:00:00.000Z",
  }), /require a source/);
  assert.throws(() => getSourcePolicy({ domain: "unknown", field: "price" }), /Unsupported/);
});
