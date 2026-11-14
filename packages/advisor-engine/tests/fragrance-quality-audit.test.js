import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceStore } from "../src/core/evidence-store.js";
import { normalizeFragranceProduct } from "../src/domains/fragrance/adapter.js";
import {
  auditFragranceLibrary,
  renderFragranceQualityAuditMarkdown,
} from "../src/domains/fragrance/quality-audit.js";

function addClaim(store, id, field, value, status = "verified", sourceType = "independent_test") {
  store.add({
    id,
    domain: "fragrance",
    subjectId: "perfume-1",
    field,
    value,
    status,
    confidence: 0.9,
    source: { name: "Quality audit source", url: "https://example.com/" + id, type: sourceType },
    observedAt: "2026-11-08T10:00:00.000Z",
  });
}

test("audits evidence links and distinguishes reported attributes from tested performance", () => {
  const store = new EvidenceStore();
  addClaim(store, "min", "longevityMinHours", 5);
  addClaim(store, "max", "longevityMaxHours", 7);
  addClaim(store, "intensity", "intensityLevel", "soft");
  addClaim(store, "family", "scentFamily", "Citrus", "reported", "database");
  const product = normalizeFragranceProduct({
    id: "perfume-1",
    name: "Audit Perfume",
    productType: "perfume",
    attributes: {
      longevityRange: { min: 5, max: 7 },
      intensityLevel: "soft",
      scentFamily: "Citrus",
    },
    evidenceIds: {
      longevityMinHours: ["min"],
      longevityMaxHours: ["max"],
      intensityLevel: ["intensity"],
      scentFamily: ["family"],
    },
  });
  const report = auditFragranceLibrary({ products: [product], evidenceStore: store });
  assert.equal(report.totals.products, 1);
  assert.equal(report.totals.evidenceRecords, 4);
  assert.equal(report.totals.claimFieldsWithValidEvidenceLinks, 4);
  assert.equal(report.performance.longevity.productsWithIndependentTestEvidence, 1);
  assert.equal(report.performance.intensityLevel.productsWithIndependentTestEvidence, 1);
  assert.equal(report.readiness.canShowEvidenceBackedLongevityRanges, true);
  assert.equal(report.totals.reportedRecords, 1);
  assert.match(renderFragranceQualityAuditMarkdown(report), /Performance readiness/u);
});

test("does not count source-reported performance values as independent test evidence", () => {
  const store = new EvidenceStore();
  addClaim(store, "min", "longevityMinHours", 5, "reported", "database");
  addClaim(store, "max", "longevityMaxHours", 7, "reported", "database");
  const product = normalizeFragranceProduct({
    id: "perfume-1",
    name: "Reported Perfume",
    productType: "perfume",
    attributes: { longevityRange: { min: 5, max: 7 } },
    evidenceIds: {
      longevityMinHours: ["min"],
      longevityMaxHours: ["max"],
    },
  });
  const report = auditFragranceLibrary({ products: [product], evidenceStore: store });
  assert.equal(report.performance.longevity.productsWithRange, 1);
  assert.equal(report.performance.longevity.productsWithIndependentTestEvidence, 0);
  assert.equal(report.readiness.canShowEvidenceBackedLongevityRanges, false);
});

test("reports unavailable evidence assessment when the ledger is not connected", () => {
  const product = normalizeFragranceProduct({
    id: "perfume-1",
    name: "No Ledger",
    productType: "perfume",
    attributes: {},
  });
  const report = auditFragranceLibrary({ products: [product] });
  assert.ok(report.warnings.some(item => /not assessed/u.test(item)));
});


test("does not mark evidence links malformed when the evidence ledger was not supplied", () => {
  const product = normalizeFragranceProduct({
    id: "perfume-1",
    name: "Unassessed links",
    productType: "perfume",
    attributes: { scentFamily: "Citrus" },
    evidenceIds: { scentFamily: ["existing-evidence-id"] },
  });
  const report = auditFragranceLibrary({ products: [product] });
  assert.equal(report.totals.malformedEvidenceLinks, 0);
  assert.equal(report.totals.claimFieldsWithEvidenceLinksNotAssessed, 1);
  assert.equal(report.totals.claimFieldsWithValidEvidenceLinks, 0);
});

test("matches structured evidence values independent of object key insertion order", () => {
  const store = new EvidenceStore();
  store.add({
    id: "structured-claim",
    domain: "fragrance",
    subjectId: "perfume-1",
    field: "customDescriptor",
    value: { family: "fresh", profile: { dry: false, sweet: true } },
    status: "reported",
    confidence: 0.8,
    source: { name: "Structured source", url: "https://example.com/structured", type: "database" },
    observedAt: "2026-11-08T10:00:00.000Z",
  });
  const product = normalizeFragranceProduct({
    id: "perfume-1",
    name: "Structured claim",
    productType: "perfume",
    attributes: { customDescriptor: { profile: { sweet: true, dry: false }, family: "fresh" } },
    evidenceIds: { customDescriptor: ["structured-claim"] },
  });
  const report = auditFragranceLibrary({ products: [product], evidenceStore: store });
  assert.equal(report.totals.claimFieldsWithValidEvidenceLinks, 1);
  assert.equal(report.totals.malformedEvidenceLinks, 0);
});
