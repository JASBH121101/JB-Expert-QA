import test from "node:test";
import assert from "node:assert/strict";
import { recommendProducts } from "../src/recommendation/recommend.js";

function techProducts() {
  return [
    { id: "phone-a", name: "Phone A", domain: "technology", deviceType: "smartphone", attributes: {
      performanceScore: 90, cameraScore: 80, batteryLifeHours: 10, priceUSD: 800,
    } },
    { id: "phone-b", name: "Phone B", domain: "technology", deviceType: "smartphone", attributes: {
      performanceScore: 80, cameraScore: 95, batteryLifeHours: 12, priceUSD: 700,
    } },
    { id: "phone-c", name: "Phone C", domain: "technology", deviceType: "smartphone", attributes: {
      performanceScore: 60, cameraScore: 60, batteryLifeHours: 8, priceUSD: 500,
    } },
  ];
}

test("benchmark: photography profile ranks the expected camera-first candidate", () => {
  const result = recommendProducts({ products: techProducts(), profile: "photography_video", minimumScoredCoverage: 50 });
  assert.equal(result.decision, "recommended");
  assert.equal(result.winnerId, "phone-b");
  assert.deepEqual(result.ranking.map(item => item.position), [1, 2, 3]);
});

test("benchmark: ties are explicit and never invent a unique winner", () => {
  const products = techProducts().slice(0, 2).map(item => ({
    ...item, attributes: { performanceScore: 80, cameraScore: 80, batteryLifeHours: 10, priceUSD: 700 },
  }));
  const result = recommendProducts({
    products,
    priorities: [{ field: "performanceScore", weight: 1 }, { field: "cameraScore", weight: 1 }],
  });
  assert.equal(result.decision, "tie");
  assert.equal(result.winnerId, null);
});

test("benchmark: missing data reduces scored coverage and blocks low-coverage winner", () => {
  const products = [
    { id: "a", name: "A", domain: "technology", deviceType: "laptop", attributes: { performanceScore: 90 } },
    { id: "b", name: "B", domain: "technology", deviceType: "laptop", attributes: { performanceScore: 80 } },
  ];
  const result = recommendProducts({
    products,
    priorities: [
      { field: "performanceScore", weight: 1 },
      { field: "productivityScore", weight: 2 },
      { field: "batteryLifeHours", weight: 2 },
    ],
    minimumScoredCoverage: 80,
  });
  assert.equal(result.decision, "insufficient_coverage");
  assert.equal(result.winnerId, null);
  assert.equal(result.ranking[0].scoredCoverage, 20);
});

test("benchmark: fragrance profile remains deterministic for equivalent candidates", () => {
  const products = [
    { id: "scent-a", name: "Scent A", domain: "fragrance", productType: "perfume", attributes: {
      climateSuitabilityScore: 90, versatilityScore: 80, projectionBalanceScore: 75, priceUSD: 70,
    } },
    { id: "scent-b", name: "Scent B", domain: "fragrance", productType: "perfume", attributes: {
      climateSuitabilityScore: 80, versatilityScore: 90, projectionBalanceScore: 80, priceUSD: 60,
    } },
  ];
  const first = recommendProducts({ products, profile: "hot_humid_daily" });
  const second = recommendProducts({ products, profile: "hot_humid_daily" });
  assert.deepEqual(first.ranking.map(item => [item.id, item.score]), second.ranking.map(item => [item.id, item.score]));
  assert.equal(first.winnerId, second.winnerId);
});
