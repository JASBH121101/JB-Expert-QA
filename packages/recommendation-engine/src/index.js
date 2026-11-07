const CATEGORY_ATTRIBUTES = Object.freeze({
  phone: Object.freeze({
    performanceScore: 100, cameraScore: 100, batteryScore: 100,
    displayScore: 100, gamingScore: 100, durabilityScore: 100,
    storageGB: 1024, ramGB: 32, batteryMah: 10000
  }),
  perfume: Object.freeze({
    longevityScore: 100, projectionScore: 100, sillageScore: 100, versatilityScore: 100
  })
});

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeTag(value) {
  return String(value).normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function clarify(message, missing) {
  return Object.freeze({
    status: "needs_clarification",
    recommendations: Object.freeze([]),
    clarification: message,
    missing: Object.freeze(missing)
  });
}

function compareRequirement(actual, requirement) {
  if (actual === undefined || actual === null) return false;
  const expected = requirement.value;
  switch (requirement.operator) {
    case "gte": return typeof actual === "number" && actual >= expected;
    case "lte": return typeof actual === "number" && actual <= expected;
    case "eq": return typeof actual === "string" && typeof expected === "string"
      ? normalizeTag(actual) === normalizeTag(expected)
      : actual === expected;
    case "includes":
      if (Array.isArray(actual)) return actual.some((item) => normalizeTag(item) === normalizeTag(expected));
      if (typeof actual === "string") return normalizeTag(actual).includes(normalizeTag(expected));
      return false;
    default: return false;
  }
}

function normalizePriorities(category, priorities) {
  if (!record(priorities) || Object.keys(priorities).length === 0) return null;
  const supported = CATEGORY_ATTRIBUTES[category];
  const result = [];
  for (const [attribute, weight] of Object.entries(priorities)) {
    if (!(attribute in supported)) throw new TypeError("Unsupported " + category + " priority: " + attribute);
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0 || weight > 100) {
      throw new TypeError("Priority weights must be numbers greater than 0 and no greater than 100");
    }
    result.push({ attribute, weight, scale: supported[attribute] });
  }
  return result;
}

function validateRequirements(requirements, name) {
  if (requirements === undefined) return [];
  if (!Array.isArray(requirements)) throw new TypeError(name + " must be an array");
  for (const requirement of requirements) {
    if (!record(requirement) || !nonEmptyString(requirement.attribute) ||
        !["gte", "lte", "eq", "includes"].includes(requirement.operator) ||
        requirement.value === undefined || requirement.value === null) {
      throw new TypeError(name + " entries require attribute, supported operator, and value");
    }
    if (["gte", "lte"].includes(requirement.operator) &&
        (typeof requirement.value !== "number" || !Number.isFinite(requirement.value))) {
      throw new TypeError(name + " numeric comparisons require a finite number");
    }
  }
  return requirements;
}

function scoreProduct(product, priorities) {
  let totalWeight = 0;
  let matchedWeight = 0;
  let weightedScore = 0;
  const matchedPriorities = [];
  const missingPriorities = [];
  for (const priority of priorities) {
    totalWeight += priority.weight;
    const value = product.attributes?.[priority.attribute];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      missingPriorities.push(priority.attribute);
      continue;
    }
    const normalized = Math.max(0, Math.min(100, (value / priority.scale) * 100));
    matchedWeight += priority.weight;
    weightedScore += normalized * priority.weight;
    matchedPriorities.push({ attribute: priority.attribute, value, normalizedScore: Number(normalized.toFixed(1)), weight: priority.weight });
  }
  const coverage = totalWeight === 0 ? 0 : matchedWeight / totalWeight;
  const score = matchedWeight === 0 ? null : weightedScore / matchedWeight;
  return {
    score: score === null ? null : Number(score.toFixed(1)),
    coverage: Number((coverage * 100).toFixed(1)),
    matchedPriorities,
    missingPriorities
  };
}

export function createProductRecommender({ maxResults = 3, minimumDataCoverage = 60 } = {}) {
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 10) {
    throw new RangeError("maxResults must be an integer between 1 and 10");
  }
  if (typeof minimumDataCoverage !== "number" || !Number.isFinite(minimumDataCoverage) ||
      minimumDataCoverage < 1 || minimumDataCoverage > 100) {
    throw new RangeError("minimumDataCoverage must be between 1 and 100");
  }

  function recommend(input = {}) {
    if (!record(input) || !["phone", "perfume"].includes(input.category)) {
      throw new TypeError("category must be phone or perfume");
    }
    const customer = record(input.customer) ? input.customer : {};
    const budget = customer.budget;
    if (!record(budget) || typeof budget.max !== "number" || !Number.isFinite(budget.max) ||
        budget.max <= 0 || !/^[A-Z]{3}$/.test(String(budget.currency ?? ""))) {
      return clarify("¿Cuál es tu presupuesto máximo y en qué moneda querés comparar?", ["customer.budget.max", "customer.budget.currency"]);
    }
    const priorities = normalizePriorities(input.category, customer.priorities);
    if (!priorities) {
      const question = input.category === "phone"
        ? "¿Qué querés priorizar: batería, cámara, rendimiento, almacenamiento o precio?"
        : "¿Qué familia de aroma o característica priorizás: fresca, floral, amaderada, duración o proyección?";
      return clarify(question, ["customer.priorities"]);
    }
    if (!Array.isArray(input.catalog)) throw new TypeError("catalog must be an array");
    const mustHave = validateRequirements(customer.mustHave, "customer.mustHave");
    const avoidTags = Array.isArray(customer.avoidTags) ? customer.avoidTags.map(normalizeTag) : [];
    if (customer.avoidTags !== undefined && !Array.isArray(customer.avoidTags)) {
      throw new TypeError("customer.avoidTags must be an array");
    }

    const sameCategory = input.catalog.filter((product) => record(product) && product.category === input.category);
    const exclusions = { invalidProduct: 0, currencyMismatch: 0, overBudget: 0, outOfStock: 0, mustHave: 0, avoidTag: 0, insufficientData: 0 };
    const candidates = [];
    for (const product of sameCategory) {
      if (!nonEmptyString(product.id) || !nonEmptyString(product.name) || !record(product.price) ||
          typeof product.price.amount !== "number" || !Number.isFinite(product.price.amount) ||
          product.price.amount < 0 || !/^[A-Z]{3}$/.test(String(product.price.currency ?? "")) ||
          !record(product.attributes)) {
        exclusions.invalidProduct += 1;
        continue;
      }
      if (product.price.currency !== budget.currency) { exclusions.currencyMismatch += 1; continue; }
      if (budget.hardCap !== false && product.price.amount > budget.max) { exclusions.overBudget += 1; continue; }
      if (product.availability === "out_of_stock") { exclusions.outOfStock += 1; continue; }
      if (mustHave.some((item) => !compareRequirement(product.attributes[item.attribute], item))) {
        exclusions.mustHave += 1;
        continue;
      }
      const productTags = Array.isArray(product.tags) ? product.tags.map(normalizeTag) : [];
      if (avoidTags.some((tag) => productTags.includes(tag))) { exclusions.avoidTag += 1; continue; }
      const measured = scoreProduct(product, priorities);
      if (measured.score === null || measured.coverage < minimumDataCoverage) {
        exclusions.insufficientData += 1;
        continue;
      }
      candidates.push({ product, measured });
    }

    candidates.sort((left, right) => right.measured.score - left.measured.score ||
      left.product.price.amount - right.product.price.amount || left.product.id.localeCompare(right.product.id));
    if (candidates.length === 0) {
      const onlyCurrencyMismatch = sameCategory.length > 0 && exclusions.currencyMismatch === sameCategory.length;
      return Object.freeze({
        status: "no_match",
        recommendations: Object.freeze([]),
        clarification: onlyCurrencyMismatch
          ? "El catálogo no tiene productos en la moneda seleccionada. No voy a convertir precios sin una tasa verificada."
          : "No encontré opciones que cumplan el presupuesto, los requisitos y la cobertura mínima de datos. Podemos ajustar una condición.",
        missing: Object.freeze([]),
        exclusions: Object.freeze(exclusions)
      });
    }

    const recommendations = candidates.slice(0, maxResults).map(({ product, measured }, index) => {
      const availability = product.availability === "in_stock" ? "in_stock" : "unverified";
      const reasons = measured.matchedPriorities.map((item) =>
        item.attribute + ": " + item.value + " (peso " + item.weight + ")");
      if (measured.missingPriorities.length) {
        reasons.push("Datos no proporcionados: " + measured.missingPriorities.join(", "));
      }
      return Object.freeze({
        rank: index + 1,
        productId: product.id,
        name: product.name,
        price: Object.freeze({ amount: product.price.amount, currency: product.price.currency }),
        score: measured.score,
        dataCoverage: measured.coverage,
        availability,
        updatedAt: product.updatedAt ?? null,
        reasons: Object.freeze(reasons),
        missingPriorities: Object.freeze(measured.missingPriorities)
      });
    });

    return Object.freeze({
      status: "recommended",
      recommendations: Object.freeze(recommendations),
      clarification: null,
      missing: Object.freeze([]),
      exclusions: Object.freeze(exclusions),
      policy: Object.freeze({
        currencyConversion: false,
        pricesInvented: false,
        availabilityClaimedWithoutCatalogStatus: false,
        scoreMeaning: "weighted fit across supplied attributes; not a guarantee of product quality"
      })
    });
  }

  return Object.freeze({ recommend });
}

export const RECOMMENDATION_CATEGORIES = Object.freeze(["phone", "perfume"]);
