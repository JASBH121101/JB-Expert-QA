import test from "node:test";
import assert from "node:assert/strict";
import { createProductRecommender } from "../src/index.js";

const engine = createProductRecommender();

function phone(id, amount, attributes, extra = {}) {
  return {
    id,
    name: id,
    category: "phone",
    price: { amount, currency: "NIO" },
    availability: "in_stock",
    attributes,
    ...extra
  };
}

function perfume(id, amount, attributes, extra = {}) {
  return {
    id,
    name: id,
    category: "perfume",
    price: { amount, currency: "NIO" },
    availability: "in_stock",
    attributes,
    ...extra
  };
}

test("asks one focused clarification when budget or priority is missing", () => {
  const noBudget = engine.recommend({
    category: "phone",
    customer: { priorities: { batteryScore: 1 } },
    catalog: []
  });
  assert.equal(noBudget.status, "needs_clarification");
  assert.match(noBudget.clarification, /presupuesto máximo/);

  const noPriority = engine.recommend({
    category: "perfume",
    customer: { budget: { max: 1000, currency: "NIO" } },
    catalog: []
  });
  assert.equal(noPriority.status, "needs_clarification");
  assert.match(noPriority.clarification, /familia de aroma/);
});

test("phone recommendations follow the customer's weighted priorities", () => {
  const result = engine.recommend({
    category: "phone",
    customer: {
      budget: { max: 9000, currency: "NIO" },
      priorities: { batteryScore: 80, performanceScore: 20 }
    },
    catalog: [
      phone("camera-gamer", 8500, { batteryScore: 70, performanceScore: 95 }),
      phone("all-day", 7000, { batteryScore: 98, performanceScore: 70 })
    ]
  });
  assert.equal(result.status, "recommended");
  assert.equal(result.recommendations[0].productId, "all-day");
  assert.equal(result.recommendations[0].score, 92.4);
  assert.match(result.recommendations[0].reasons.join(" "), /batteryScore: 98/);
});

test("hard budget and must-have storage constraints are enforced", () => {
  const result = engine.recommend({
    category: "phone",
    customer: {
      budget: { max: 6000, currency: "NIO" },
      priorities: { batteryScore: 1 },
      mustHave: [{ attribute: "storageGB", operator: "gte", value: 256 }]
    },
    catalog: [
      phone("cheap-128", 3500, { batteryScore: 95, storageGB: 128 }),
      phone("over-budget-512", 9000, { batteryScore: 99, storageGB: 512 }),
      phone("eligible-256", 5900, { batteryScore: 80, storageGB: 256 })
    ]
  });
  assert.deepEqual(result.recommendations.map((item) => item.productId), ["eligible-256"]);
  assert.equal(result.exclusions.overBudget, 1);
  assert.equal(result.exclusions.mustHave, 1);
});

test("the recommender does not convert currencies without a verified exchange rate", () => {
  const result = engine.recommend({
    category: "phone",
    customer: {
      budget: { max: 250, currency: "NIO" },
      priorities: { batteryScore: 1 }
    },
    catalog: [phone("usd-phone", 200, { batteryScore: 90 }, {
      price: { amount: 200, currency: "USD" }
    })]
  });
  assert.equal(result.status, "no_match");
  assert.match(result.clarification, /No voy a convertir precios/);
  assert.equal(result.exclusions.currencyMismatch, 1);
});

test("unknown availability is labelled unverified rather than in stock", () => {
  const result = engine.recommend({
    category: "phone",
    customer: {
      budget: { max: 5000, currency: "NIO" },
      priorities: { batteryScore: 1 }
    },
    catalog: [phone("availability-unknown", 4000, { batteryScore: 90 }, { availability: "unknown" })]
  });
  assert.equal(result.status, "recommended");
  assert.equal(result.recommendations[0].availability, "unverified");
});

test("out-of-stock products are never recommended", () => {
  const result = engine.recommend({
    category: "phone",
    customer: {
      budget: { max: 5000, currency: "NIO" },
      priorities: { batteryScore: 1 }
    },
    catalog: [phone("sold-out", 4000, { batteryScore: 99 }, { availability: "out_of_stock" })]
  });
  assert.equal(result.status, "no_match");
  assert.equal(result.exclusions.outOfStock, 1);
});

test("avoid tags exclude products without inventing replacement specifications", () => {
  const result = engine.recommend({
    category: "perfume",
    customer: {
      budget: { max: 3000, currency: "NIO" },
      priorities: { longevityScore: 1 },
      avoidTags: ["oud"]
    },
    catalog: [
      perfume("oud-intense", 1800, { longevityScore: 95 }, { tags: ["Oud", "woody"] }),
      perfume("fresh-citrus", 2200, { longevityScore: 78 }, { tags: ["citrus", "fresh"] })
    ]
  });
  assert.equal(result.recommendations[0].productId, "fresh-citrus");
  assert.equal(result.exclusions.avoidTag, 1);
});

test("perfume recommendations honor fragrance-family must-have constraints", () => {
  const result = engine.recommend({
    category: "perfume",
    customer: {
      budget: { max: 3500, currency: "NIO" },
      priorities: { longevityScore: 70, projectionScore: 30 },
      mustHave: [{ attribute: "families", operator: "includes", value: "woody" }]
    },
    catalog: [
      perfume("floral-long", 2600, { longevityScore: 98, projectionScore: 90, families: ["floral"] }),
      perfume("woody-balanced", 3200, { longevityScore: 85, projectionScore: 80, families: ["woody", "amber"] })
    ]
  });
  assert.equal(result.recommendations[0].productId, "woody-balanced");
  assert.equal(result.exclusions.mustHave, 1);
});

test("catalog records with insufficient priority data are not ranked as reliable matches", () => {
  const result = engine.recommend({
    category: "phone",
    customer: {
      budget: { max: 8000, currency: "NIO" },
      priorities: { batteryScore: 50, cameraScore: 50 }
    },
    catalog: [phone("incomplete", 6000, { batteryScore: 90 })]
  });
  assert.equal(result.status, "no_match");
  assert.equal(result.exclusions.insufficientData, 1);
});

test("only supported numeric attributes can be used as weighted priorities", () => {
  assert.throws(() => engine.recommend({
    category: "phone",
    customer: {
      budget: { max: 5000, currency: "NIO" },
      priorities: { fragranceFamily: 1 }
    },
    catalog: []
  }), /Unsupported phone priority/);
});

test("invalid catalog prices are excluded and never emitted as recommendations", () => {
  const result = engine.recommend({
    category: "phone",
    customer: {
      budget: { max: 5000, currency: "NIO" },
      priorities: { batteryScore: 1 }
    },
    catalog: [{
      id: "missing-price",
      name: "Missing price",
      category: "phone",
      attributes: { batteryScore: 99 }
    }]
  });
  assert.equal(result.status, "no_match");
  assert.equal(result.exclusions.invalidProduct, 1);
});

test("soft budgets allow an over-cap candidate only when explicitly requested", () => {
  const result = engine.recommend({
    category: "phone",
    customer: {
      budget: { max: 5000, currency: "NIO", hardCap: false },
      priorities: { cameraScore: 1 }
    },
    catalog: [phone("slightly-higher", 5200, { cameraScore: 90 })]
  });
  assert.equal(result.status, "recommended");
  assert.equal(result.recommendations[0].price.amount, 5200);
});
