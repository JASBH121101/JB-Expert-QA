import test from "node:test";
import assert from "node:assert/strict";
import { calculateNdcgAtK, evaluateRankingBenchmark } from "../src/benchmark/ranking-metrics.js";

test("NDCG@K returns 1 for an ideal reviewed ranking", () => {
  assert.equal(calculateNdcgAtK(["a", "b", "c"], { a: 3, b: 2, c: 0 }, 3), 1);
});

test("NDCG@K penalizes a reversed relevance ranking", () => {
  const score = calculateNdcgAtK(["c", "b", "a"], { a: 3, b: 2, c: 0 }, 3);
  assert.ok(score < 1);
  assert.ok(score >= 0);
});

test("NDCG@K is null when the reviewed relevance set has no positive grade", () => {
  assert.equal(calculateNdcgAtK(["a", "b"], { a: 0, b: 0 }, 2), null);
});

test("benchmark computes top-1 agreement, NDCG and domain/profile slices", () => {
  const result = evaluateRankingBenchmark({
    cutoff: 2,
    cases: [
      {
        id: "phone-photo", domain: "technology", profile: "photography_video",
        rankedIds: ["phone-b", "phone-a", "phone-c"],
        expectedWinnerId: "phone-b",
        relevanceById: { "phone-b": 3, "phone-a": 2, "phone-c": 0 },
        evidenceCoverage: 80, verifiedCoverage: 60,
      },
      {
        id: "scent-hot", domain: "fragrance", profile: "hot_humid_daily",
        rankedIds: ["scent-a", "scent-b"],
        expectedWinnerId: "scent-b",
        relevanceById: { "scent-a": 1, "scent-b": 3 },
        evidenceCoverage: 70, verifiedCoverage: 40,
      },
    ],
  });
  assert.equal(result.overall.caseCount, 2);
  assert.equal(result.overall.top1Agreement, 0.5);
  assert.equal(result.overall.ndcgCaseCount, 2);
  assert.equal(result.perDomain.technology.caseCount, 1);
  assert.equal(result.perDomain.fragrance.caseCount, 1);
  assert.ok(Object.hasOwn(result.perProfile, "technology:photography_video"));
  assert.equal(result.perDomain.technology.meanEvidenceCoverage, 80);
});

test("benchmark rejects invalid IDs, scores, domains and coverage", () => {
  assert.throws(() => calculateNdcgAtK(["a", "a"], { a: 1 }), /duplicates/);
  assert.throws(() => calculateNdcgAtK(["a"], { a: -1 }), /non-negative/);
  assert.throws(() => evaluateRankingBenchmark({ cases: [
    { id: "x", domain: "other", profile: "p", rankedIds: ["a"], relevanceById: { a: 1 } },
  ] }), /Unsupported benchmark domain/);
  assert.throws(() => evaluateRankingBenchmark({ cases: [
    { id: "x", domain: "technology", profile: "p", rankedIds: ["a"], expectedWinnerId: "b", relevanceById: { a: 1 } },
  ] }), /missing from ranking/);
  assert.throws(() => evaluateRankingBenchmark({ cases: [
    { id: "x", domain: "technology", profile: "p", rankedIds: ["a"], relevanceById: { a: 1 }, evidenceCoverage: 101 },
  ] }), /evidenceCoverage/);
});
