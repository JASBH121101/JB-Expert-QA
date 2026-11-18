import test from "node:test";
import { persistThreatLabReport } from "./helpers/persist-report.js";
import assert from "node:assert/strict";
import { createThreatLab } from "../src/index.js";
import {
  createAdvisorCore,
  ENGINE_VERSION,
  ResearchEngine,
  SOURCE_TYPES
} from "../../advisor-engine/src/index.js";

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
      storage: { value: 1, unit: "tb" }
    }
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
      storage: { value: 512, unit: "gb" }
    }
  }
];

const safety = {
  safe: true,
  network: false,
  destructive: false,
  executesSample: false
};

test("JB Threat Lab validates Advisor Engine against deterministic offline fixtures", async () => {
  const lab = createThreatLab({ name: "JB Threat Lab", version: "0.2.0" });

  lab.registerTarget({
    id: "jb-advisor-engine",
    kind: "decision-engine",
    version: ENGINE_VERSION,
    capabilities: ["technology-advice", "evidence-review", "offline-research"],
    adapter: {
      async runScenario({ scenario }) {
        if (scenario.id === "advisor.technology.deterministic") {
          const result = createAdvisorCore().advise({
            domain: "technology",
            products: phones,
            profile: "photography_video"
          });
          const passed = result.engineId === "JBAE"
            && result.domain === "technology"
            && result.candidateCount === 2
            && result.recommendation.winnerId === "phone-a";
          return {
            status: passed ? "pass" : "fail",
            summary: "Synthetic smartphone comparison is deterministic and explainable.",
            metrics: { candidateCount: result.candidateCount, networkRequests: 0 },
            findings: []
          };
        }

        if (scenario.id === "advisor.research.pending-review") {
          const research = new ResearchEngine({
            clock: () => new Date("2026-11-14T12:00:00.000Z"),
            providers: [{
              id: "local-fixture",
              domains: ["technology"],
              async search() {
                return [{
                  id: "camera-score-a",
                  value: 96,
                  confidence: 0.9,
                  source: {
                    name: "Local Threat Lab fixture",
                    url: "https://example.invalid/fixtures/camera-score",
                    type: SOURCE_TYPES.DATABASE
                  },
                  observedAt: "2026-11-14T12:00:00.000Z"
                }];
              }
            }]
          });
          const result = await research.research({
            domain: "technology",
            subjectId: "phone-a",
            field: "cameraScore",
            query: "local synthetic fixture",
            providerId: "local-fixture",
            limit: 1
          });
          const status = result.candidates[0]?.evidence?.status;
          const passed = result.decision === "pending_review"
            && result.changesVerifiedData === false
            && status === "unconfirmed";
          return {
            status: passed ? "pass" : "fail",
            summary: "Mocked research stays unconfirmed until human review; no provider network call is made.",
            metrics: { candidateCount: result.candidateCount, networkRequests: 0 },
            findings: []
          };
        }

        if (scenario.id === "advisor.domain.type-isolation") {
          let rejected = false;
          try {
            createAdvisorCore().advise({
              domain: "technology",
              products: [
                phones[0],
                { ...phones[1], deviceType: "laptop" }
              ],
              profile: "balanced"
            });
          } catch (error) {
            rejected = /different device types/i.test(String(error?.message));
          }
          return {
            status: rejected ? "pass" : "fail",
            summary: "Mixed technology product types are rejected rather than compared as equivalent.",
            metrics: { mixedDomainRequests: 1, rejected: rejected ? 1 : 0 },
            findings: []
          };
        }


        if (scenario.id === "advisor.coverage.no-winner") {
          const result = createAdvisorCore({ minimumScoredCoverage: 80 }).advise({
            domain: "technology",
            products: [
              { id: "partial-a", name: "Partial A", deviceType: "smartphone", attributes: { cameraScore: 98 } },
              { id: "partial-b", name: "Partial B", deviceType: "smartphone", attributes: { cameraScore: 80 } }
            ],
            priorities: [
              { field: "cameraScore", weight: 1 },
              { field: "batteryLifeHours", weight: 1 }
            ]
          });
          const passed = result.recommendation.decision === "insufficient_coverage"
            && result.recommendation.winnerId === null
            && result.recommendation.ranking.every((item) => item.eligibility !== "eligible");
          return {
            status: passed ? "pass" : "fail",
            summary: passed
              ? "Advisor refuses to invent a winner when no candidate meets the combined coverage threshold"
              : "Advisor selected an ineligible winner from incomplete synthetic data",
            metrics: {
              decision: result.recommendation.decision,
              winnerId: result.recommendation.winnerId,
              scoredCoverage: result.recommendation.ranking.map((item) => item.scoredCoverage),
              minimumScoredCoverage: result.recommendation.minimumScoredCoverage ?? 80,
              networkRequests: 0
            },
            findings: passed ? [] : [{ code: "ADVISOR_COVERAGE_GATE_MISMATCH" }]
          };
        }

        if (scenario.id === "advisor.technology.stable-four-candidate-ranking") {
          const candidates = [
            { id: "matrix-a", name: "Matrix A", deviceType: "smartphone", attributes: { cameraScore: 98, batteryLifeHours: 17, priceUSD: 550 } },
            { id: "matrix-b", name: "Matrix B", deviceType: "smartphone", attributes: { cameraScore: 92, batteryLifeHours: 15, priceUSD: 650 } },
            { id: "matrix-c", name: "Matrix C", deviceType: "smartphone", attributes: { cameraScore: 86, batteryLifeHours: 12, priceUSD: 750 } },
            { id: "matrix-d", name: "Matrix D", deviceType: "smartphone", attributes: { cameraScore: 80, batteryLifeHours: 9, priceUSD: 850 } }
          ];
          const original = JSON.stringify(candidates);
          const priorities = [
            { field: "cameraScore", weight: 4 },
            { field: "batteryLifeHours", weight: 3 },
            { field: "priceUSD", weight: 2 }
          ];
          const advisor = createAdvisorCore({ minimumScoredCoverage: 100 });
          const forward = advisor.advise({ domain: "technology", products: candidates, priorities });
          const reverse = advisor.advise({ domain: "technology", products: [...candidates].reverse(), priorities });
          const ranking = (result) => result.recommendation.ranking.map((item) => ({
            id: item.id, score: item.score, position: item.position, eligibility: item.eligibility
          }));
          const forwardRanking = ranking(forward);
          const reverseRanking = ranking(reverse);
          const passed = forward.recommendation.decision === "recommended"
            && forward.recommendation.winnerId === "matrix-a"
            && reverse.recommendation.winnerId === forward.recommendation.winnerId
            && JSON.stringify(forwardRanking) === JSON.stringify(reverseRanking)
            && forwardRanking.length === 4
            && forwardRanking.every((item) => item.eligibility === "eligible")
            && JSON.stringify(candidates) === original;
          return {
            status: passed ? "pass" : "fail",
            summary: passed
              ? "Four-candidate weighted recommendation is stable under input permutation and leaves caller data unchanged"
              : "Advisor recommendation order or input immutability changed across an equivalent candidate permutation",
            metrics: {
              candidateCount: forward.candidateCount,
              winnerId: forward.recommendation.winnerId,
              forwardOrder: forwardRanking.map((item) => item.id),
              reverseOrder: reverseRanking.map((item) => item.id),
              minimumScoredCoverage: forward.recommendation.minimumScoredCoverage,
              inputUnchanged: JSON.stringify(candidates) === original,
              networkRequests: 0
            },
            findings: passed ? [] : [{ code: "ADVISOR_DETERMINISM_MISMATCH" }]
          };
        }

        if (scenario.id === "advisor.research.capacity-unconfirmed-invariants") {
          const fixedTime = "2026-11-16T03:00:00.000Z";
          const sourceFor = (index) => ({
            name: "Threat Lab local database fixture",
            url: "https://example.com/threat-lab/camera/" + index,
            type: SOURCE_TYPES.DATABASE
          });
          const primaryRows = Array.from({ length: 20 }, (_, index) => ({
            id: "primary-camera-" + index,
            value: 60 + index,
            confidence: 0.85,
            source: sourceFor(index),
            observedAt: fixedTime
          }));
          const overflowRows = Array.from({ length: 6 }, (_, index) => ({
            id: "overflow-camera-" + index,
            value: 70 + index,
            confidence: 0.8,
            source: sourceFor(index + 20),
            observedAt: fixedTime
          }));
          let providerCalls = 0;
          const research = new ResearchEngine({
            clock: () => new Date(fixedTime),
            maxPendingCandidates: 25,
            providers: [
              {
                id: "threat-lab-primary-batch",
                domains: ["technology"],
                async search({ limit }) { providerCalls += 1; return primaryRows.slice(0, limit); }
              },
              {
                id: "threat-lab-overflow-batch",
                domains: ["technology"],
                async search({ limit }) { providerCalls += 1; return overflowRows.slice(0, limit); }
              }
            ]
          });
          const firstBatch = await research.research({
            domain: "technology",
            subjectId: "phone-batch-primary",
            field: "cameraScore",
            query: "local synthetic camera evidence batch",
            providerId: "threat-lab-primary-batch",
            limit: 20
          });
          let capacityRejected = false;
          try {
            await research.research({
              domain: "technology",
              subjectId: "phone-batch-overflow",
              field: "cameraScore",
              query: "local synthetic overflow batch",
              providerId: "threat-lab-overflow-batch",
              limit: 6
            });
          } catch (error) {
            capacityRejected = /capacity/.test(String(error?.message));
          }
          const pending = research.getPendingCandidates();
          const allUnconfirmed = pending.every((candidate) =>
            candidate.evidence.status === "unconfirmed" && candidate.decision === "pending_review"
          );
          const passed = firstBatch.candidateCount === 20
            && firstBatch.truncated === false
            && firstBatch.decision === "pending_review"
            && firstBatch.changesVerifiedData === false
            && firstBatch.candidates.every((candidate) => candidate.evidence.status === "unconfirmed")
            && capacityRejected && pending.length === 20 && allUnconfirmed && providerCalls === 2;
          return {
            status: passed ? "pass" : "fail",
            summary: passed
              ? "Research staging kept 20 synthetic claims unconfirmed and rejected an over-capacity batch atomically"
              : "Research capacity or unconfirmed-evidence invariant was violated",
            metrics: {
              stagedCandidates: firstBatch.candidateCount,
              pendingAfterRejectedBatch: pending.length,
              allUnconfirmed, capacityRejected, providerCalls, networkRequests: 0
            },
            findings: passed ? [] : [{
              code: "ADVISOR_RESEARCH_CAPACITY_MISMATCH",
              stagedCandidates: firstBatch.candidateCount,
              pendingCandidates: pending.length,
              capacityRejected, allUnconfirmed
            }]
          };
        }

        return {
          status: "skip",
          summary: "Scenario is not implemented by the Advisor Engine adapter.",
          metrics: {},
          findings: []
        };
      }
    }
  });

  lab.registerScenario({
    id: "advisor.technology.deterministic",
    category: "recommendation",
    description: "Compare two synthetic smartphones using deterministic local data.",
    difficulty: "basic",
    appliesTo: ["jb-advisor-engine"],
    safety
  });
  lab.registerScenario({
    id: "advisor.research.pending-review",
    category: "evidence-governance",
    description: "Ensure mocked research candidates remain unconfirmed pending human review.",
    difficulty: "expert",
    appliesTo: ["jb-advisor-engine"],
    safety
  });
  lab.registerScenario({
    id: "advisor.domain.type-isolation",
    category: "domain-isolation",
    description: "Reject a comparison that mixes smartphone and laptop product types.",
    difficulty: "intermediate",
    appliesTo: ["jb-advisor-engine"],
    safety
  });

  lab.registerScenario({
    id: "advisor.coverage.no-winner",
    category: "coverage-governance",
    description: "Do not recommend a winner when no candidate meets the combined scored-coverage threshold.",
    difficulty: "advanced",
    appliesTo: ["jb-advisor-engine"],
    safety
  });
  lab.registerScenario({
    id: "advisor.technology.stable-four-candidate-ranking",
    category: "recommendation-stability",
    description: "Preserve weighted ranking under candidate-order permutation without mutating caller inputs.",
    difficulty: "extreme",
    appliesTo: ["jb-advisor-engine"],
    safety
  });
  lab.registerScenario({
    id: "advisor.research.capacity-unconfirmed-invariants",
    category: "evidence-governance",
    description: "Keep synthetic research batches unconfirmed and reject capacity overflow without partially staging candidates.",
    difficulty: "superextreme",
    appliesTo: ["jb-advisor-engine"],
    safety
  });

  const report = await lab.run({
    targetIds: ["jb-advisor-engine"],
    scenarioIds: [
      "advisor.technology.deterministic",
      "advisor.research.pending-review",
      "advisor.domain.type-isolation",
      "advisor.coverage.no-winner",
      "advisor.technology.stable-four-candidate-ranking",
      "advisor.research.capacity-unconfirmed-invariants"
    ],
    metadata: { profile: "advisor-local-fixtures", networkRequests: 0 }
  });
  await persistThreatLabReport(report, "advisor-engine");

  assert.deepEqual(report.totals, { pass: 6, fail: 0, skip: 0 });
  assert.equal(report.results.length, 6);
  assert.deepEqual(report.assessment.targets[0].coveredLevels, [
    "basic", "intermediate", "advanced", "expert", "extreme", "superextreme"
  ]);
  assert.equal(report.assessment.targets[0].ready, true);
});
