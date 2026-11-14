import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceStore } from "../src/core/evidence-store.js";
import { normalizeFragranceProduct } from "../src/domains/fragrance/adapter.js";
import { buildFragrancePerformanceProfile } from "../src/domains/fragrance/performance.js";

function createProduct(evidenceIds = {}) {
  return normalizeFragranceProduct({
    id: "perfume-1",
    name: "Evidence Test Perfume",
    productType: "perfume",
    attributes: {
      longevityRange: { min: 5, max: 7 },
      projectionDurationRange: { min: 1, max: 3 },
      intensityLevel: "soft",
      projectionLevel: "close",
      sillageLevel: "low",
    },
    evidenceIds,
  });
}

function addEvidence(store, {
  id,
  field,
  value,
  status = "verified",
  sourceType = "independent_test",
  sourceUrl = "https://example.com/" + id,
}) {
  return store.add({
    id,
    domain: "fragrance",
    subjectId: "perfume-1",
    field,
    value,
    status,
    confidence: 0.9,
    source: {
      name: "Performance evidence",
      url: sourceUrl,
      type: sourceType,
    },
    observedAt: "2026-11-08T10:00:00.000Z",
  });
}

function createFullySupportedFixture() {
  const store = new EvidenceStore();
  const fields = {
    longevityMinHours: 5,
    longevityMaxHours: 7,
    projectionDurationMinHours: 1,
    projectionDurationMaxHours: 3,
    intensityLevel: "soft",
    projectionLevel: "close",
    sillageLevel: "low",
  };
  const evidenceIds = {};
  for (const [field, value] of Object.entries(fields)) {
    const id = "evidence-" + field;
    addEvidence(store, { id, field, value });
    evidenceIds[field] = [id];
  }
  return { store, product: createProduct(evidenceIds) };
}

test("returns performance ranges only when both ends have matching independent-test evidence", () => {
  const { store, product } = createFullySupportedFixture();
  const profile = buildFragrancePerformanceProfile(product, store);
  assert.equal(profile.longevity.status, "estimated");
  assert.equal(profile.longevity.min, 5);
  assert.equal(profile.longevity.max, 7);
  assert.equal(profile.longevity.display, "5–7 hours (estimated)");
  assert.equal(profile.longevity.basis, "independent_test");
  assert.equal(profile.longevity.evidenceStatus, "verified");
  assert.equal(profile.projectionDuration.display, "1–3 hours (estimated)");
  assert.equal(profile.intensity.label, "soft / suave");
  assert.equal(profile.projection.label, "cercana a la piel");
  assert.equal(profile.sillage.label, "baja");
});

test("does not turn a single longevity point into a range", () => {
  const product = normalizeFragranceProduct({
    id: "perfume-1",
    name: "Single Point",
    productType: "perfume",
    attributes: { longevityHours: 6 },
  });
  const profile = buildFragrancePerformanceProfile(product, new EvidenceStore());
  assert.equal(profile.longevity.status, "unavailable");
  assert.equal(profile.longevity.reason, "range_not_provided");
});

test("does not publish an interval when either endpoint lacks evidence", () => {
  const store = new EvidenceStore();
  addEvidence(store, { id: "min", field: "longevityMinHours", value: 5 });
  const product = createProduct({ longevityMinHours: ["min"] });
  const profile = buildFragrancePerformanceProfile(product, store);
  assert.equal(profile.longevity.status, "unavailable");
  assert.equal(profile.longevity.reason, "incomplete_evidence");
});

test("reported community observations require explicit opt-in and remain labelled as reported", () => {
  const store = new EvidenceStore();
  addEvidence(store, {
    id: "reported-min", field: "longevityMinHours", value: 5,
    status: "reported", sourceType: "community",
  });
  addEvidence(store, {
    id: "reported-max", field: "longevityMaxHours", value: 7,
    status: "reported", sourceType: "community",
  });
  const product = createProduct({
    longevityMinHours: ["reported-min"],
    longevityMaxHours: ["reported-max"],
  });
  assert.equal(
    buildFragrancePerformanceProfile(product, store).longevity.reason,
    "reported_claim_requires_opt_in",
  );
  const allowed = buildFragrancePerformanceProfile(product, store, { allowReported: true });
  assert.equal(allowed.longevity.status, "estimated");
  assert.equal(allowed.longevity.basis, "reported_observation");
  assert.equal(allowed.longevity.evidenceStatus, "reported");
  assert.match(allowed.longevity.disclaimer, /not an independently verified test/u);
  assert.equal(allowed.longevity.evidenceStrength, "limited");
});

test("conflicting evidence blocks the complete range", () => {
  const store = new EvidenceStore();
  addEvidence(store, { id: "min", field: "longevityMinHours", value: 5 });
  addEvidence(store, { id: "max", field: "longevityMaxHours", value: 7 });
  addEvidence(store, { id: "conflicting-min", field: "longevityMinHours", value: 4 });
  const product = createProduct({
    longevityMinHours: ["min"],
    longevityMaxHours: ["max"],
  });
  const profile = buildFragrancePerformanceProfile(product, store);
  assert.equal(profile.longevity.status, "unavailable");
  assert.equal(profile.longevity.reason, "conflicting_evidence");
});

test("rejects evidence links that point to another product", () => {
  const store = new EvidenceStore();
  store.add({
    id: "wrong-product",
    domain: "fragrance",
    subjectId: "another-perfume",
    field: "longevityMinHours",
    value: 5,
    status: "verified",
    confidence: 0.9,
    source: { name: "Test", url: "https://example.com/wrong", type: "independent_test" },
    observedAt: "2026-11-08T10:00:00.000Z",
  });
  const product = createProduct({ longevityMinHours: ["wrong-product"] });
  assert.throws(
    () => buildFragrancePerformanceProfile(product, store),
    /does not match product/u,
  );
});

test("rejects a malformed evidence policy option", () => {
  const { store, product } = createFullySupportedFixture();
  assert.throws(
    () => buildFragrancePerformanceProfile(product, store, { allowReported: "yes" }),
    /must be a boolean/u,
  );
});


test("does not treat supporting reference URLs as independent performance sources", () => {
  const store = new EvidenceStore();
  for (const [id, field, value] of [
    ["min", "longevityMinHours", 5],
    ["max", "longevityMaxHours", 7],
  ]) {
    store.add({
      id,
      domain: "fragrance",
      subjectId: "perfume-1",
      field,
      value,
      status: "cross_checked",
      confidence: 0.9,
      source: {
        name: "One consolidated test report",
        url: "https://example.com/test-report",
        type: "independent_test",
        references: ["https://example.com/reference-a", "https://example.com/reference-b"],
      },
      observedAt: "2026-11-08T10:00:00.000Z",
    });
  }
  const product = createProduct({
    longevityMinHours: ["min"],
    longevityMaxHours: ["max"],
  });
  const estimate = buildFragrancePerformanceProfile(product, store).longevity;
  assert.equal(estimate.status, "estimated");
  assert.equal(estimate.sourceCount, 1);
  assert.equal(estimate.referenceCount, 2);
  assert.equal(estimate.evidenceStrength, "good");
});
