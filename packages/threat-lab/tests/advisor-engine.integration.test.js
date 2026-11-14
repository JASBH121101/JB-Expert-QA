import test from "node:test";
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
    appliesTo: ["jb-advisor-engine"],
    safety
  });
  lab.registerScenario({
    id: "advisor.research.pending-review",
    category: "evidence-governance",
    description: "Ensure mocked research candidates remain unconfirmed pending human review.",
    appliesTo: ["jb-advisor-engine"],
    safety
  });
  lab.registerScenario({
    id: "advisor.domain.type-isolation",
    category: "domain-isolation",
    description: "Reject a comparison that mixes smartphone and laptop product types.",
    appliesTo: ["jb-advisor-engine"],
    safety
  });

  const report = await lab.run({
    targetIds: ["jb-advisor-engine"],
    scenarioIds: [
      "advisor.technology.deterministic",
      "advisor.research.pending-review",
      "advisor.domain.type-isolation"
    ],
    metadata: { profile: "advisor-local-fixtures", networkRequests: 0 }
  });

  assert.deepEqual(report.totals, { pass: 3, fail: 0, skip: 0 });
  assert.equal(report.results.length, 3);
});
