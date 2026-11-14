import { DOMAINS } from "../core/domains.js";
import { compareProducts } from "../comparison/compare.js";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const FIELD_RULES = Object.freeze({
  [DOMAINS.TECHNOLOGY]: Object.freeze({
    performanceScore: "higher",
    cameraScore: "higher",
    videoScore: "higher",
    batteryLifeHours: "higher",
    displayScore: "higher",
    gamingScore: "higher",
    productivityScore: "higher",
    portabilityScore: "higher",
    softwareSupportYears: "higher",
    thermalStabilityScore: "higher",
    efficiencyScore: "higher",
    buildQualityScore: "higher",
    priceUSD: "lower",
    priceNIO: "lower",
  }),
  [DOMAINS.FRAGRANCE]: Object.freeze({
    // Interval optimization uses the conservative lower bound; the upper bound is display-only.
    longevityMinHours: "higher",
    projectionDurationMinHours: "higher",
    intensityLevel: "lower",
    projectionLevel: "lower",
    sillageLevel: "lower",
    projectionMeters: "higher",
    sillageScore: "higher",
    versatilityScore: "higher",
    climateSuitabilityScore: "higher",
    occasionFitScore: "higher",
    projectionBalanceScore: "higher",
    projectionDiscretionScore: "higher",
    freshnessScore: "higher",
    sweetnessBalanceScore: "higher",
    scentComplexityScore: "higher",
    priceUSD: "lower",
    priceNIO: "lower",
  }),
});

const PROFILES = deepFreeze({
  [DOMAINS.TECHNOLOGY]: Object.freeze({
    photography_video: Object.freeze([
      { field: "cameraScore", weight: 5 },
      { field: "videoScore", weight: 4 },
      { field: "batteryLifeHours", weight: 2 },
      { field: "priceUSD", weight: 1 },
    ]),
    gaming: Object.freeze([
      { field: "gamingScore", weight: 5 },
      { field: "performanceScore", weight: 4 },
      { field: "batteryLifeHours", weight: 2 },
      { field: "thermalStabilityScore", weight: 2 },
      { field: "priceUSD", weight: 1 },
    ]),
    productivity: Object.freeze([
      { field: "productivityScore", weight: 5 },
      { field: "batteryLifeHours", weight: 3 },
      { field: "displayScore", weight: 3 },
      { field: "portabilityScore", weight: 2 },
      { field: "softwareSupportYears", weight: 2 },
    ]),
    premium: Object.freeze([
      { field: "buildQualityScore", weight: 3 },
      { field: "displayScore", weight: 3 },
      { field: "cameraScore", weight: 3 },
      { field: "performanceScore", weight: 2 },
      { field: "softwareSupportYears", weight: 2 },
    ]),
    autonomy: Object.freeze([
      { field: "batteryLifeHours", weight: 5 },
      { field: "efficiencyScore", weight: 3 },
      { field: "portabilityScore", weight: 1 },
      { field: "priceUSD", weight: 1 },
    ]),
    balanced: Object.freeze([
      { field: "performanceScore", weight: 2 },
      { field: "cameraScore", weight: 2 },
      { field: "batteryLifeHours", weight: 2 },
      { field: "displayScore", weight: 2 },
      { field: "softwareSupportYears", weight: 2 },
      { field: "priceUSD", weight: 2 },
    ]),
  }),
  [DOMAINS.FRAGRANCE]: Object.freeze({
    hot_humid_daily: Object.freeze([
      { field: "climateSuitabilityScore", weight: 4 },
      { field: "versatilityScore", weight: 3 },
      { field: "projectionBalanceScore", weight: 2 },
      { field: "intensityLevel", weight: 1 },
      { field: "projectionLevel", weight: 1 },
      { field: "priceUSD", weight: 1 },
    ]),
    office: Object.freeze([
      { field: "versatilityScore", weight: 4 },
      { field: "projectionDiscretionScore", weight: 3 },
      { field: "freshnessScore", weight: 2 },
      { field: "intensityLevel", weight: 2 },
      { field: "projectionLevel", weight: 2 },
      { field: "sillageLevel", weight: 1 },
      { field: "longevityMinHours", weight: 1 },
    ]),
    evening: Object.freeze([
      { field: "longevityMinHours", weight: 3 },
      { field: "projectionBalanceScore", weight: 3 },
      { field: "scentComplexityScore", weight: 2 },
      { field: "occasionFitScore", weight: 2 },
    ]),
    fresh_light: Object.freeze([
      { field: "freshnessScore", weight: 4 },
      { field: "climateSuitabilityScore", weight: 3 },
      { field: "projectionDiscretionScore", weight: 2 },
      { field: "intensityLevel", weight: 2 },
      { field: "projectionLevel", weight: 2 },
      { field: "priceUSD", weight: 1 },
    ]),
    soft_daily: Object.freeze([
      { field: "intensityLevel", weight: 4 },
      { field: "projectionLevel", weight: 4 },
      { field: "sillageLevel", weight: 2 },
      { field: "freshnessScore", weight: 2 },
      { field: "versatilityScore", weight: 2 },
      { field: "climateSuitabilityScore", weight: 1 },
    ]),
    long_lasting: Object.freeze([
      { field: "longevityMinHours", weight: 5 },
      { field: "projectionDurationMinHours", weight: 2 },
      { field: "sillageScore", weight: 1 },
      { field: "projectionBalanceScore", weight: 1 },
    ]),
    budget: Object.freeze([
      { field: "priceUSD", weight: 4 },
      { field: "versatilityScore", weight: 2 },
      { field: "longevityMinHours", weight: 1 },
    ]),
    balanced: Object.freeze([
      { field: "versatilityScore", weight: 3 },
      { field: "climateSuitabilityScore", weight: 2 },
      { field: "occasionFitScore", weight: 2 },
      { field: "freshnessScore", weight: 1 },
    ]),
  }),
});

function validateDomain(domain) {
  if (!Object.hasOwn(FIELD_RULES, domain)) throw new TypeError("Unsupported recommendation domain");
}

export function getRecommendationProfiles(domain) {
  validateDomain(domain);
  return Object.freeze(Object.keys(PROFILES[domain]));
}

export function buildRecommendationCriteria({ domain, priorities, profile } = {}) {
  validateDomain(domain);
  const selected = priorities ?? (profile ? PROFILES[domain][profile] : null);
  if (!Array.isArray(selected) || selected.length === 0) {
    throw new TypeError("Provide an ordered priorities array or a supported profile");
  }
  const seen = new Set();
  return Object.freeze(selected.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`priority at index ${index} must be an object`);
    }
    const field = typeof item.field === "string" ? item.field.trim() : "";
    if (!Object.hasOwn(FIELD_RULES[domain], field)) {
      throw new TypeError(`Unsupported ${domain} priority field: ${field || "(empty)"}`);
    }
    if (seen.has(field)) throw new TypeError(`Duplicate priority field: ${field}`);
    seen.add(field);
    if (typeof item.weight !== "number" || !Number.isFinite(item.weight) || item.weight <= 0) {
      throw new TypeError(`Priority weight for ${field} must be positive`);
    }
    return Object.freeze({
      field,
      weight: item.weight,
      direction: FIELD_RULES[domain][field],
      order: index + 1,
    });
  }));
}

function describeCriterion(item) {
  return Object.freeze({
    field: item.field,
    value: item.value,
    weight: item.weight,
    criterionScore: item.score,
    evidenceStatus: item.evidence.status,
    evidenceIds: item.evidence.evidenceIds,
    confidence: item.evidence.confidence,
  });
}

export function recommendProducts({
  products,
  priorities,
  profile,
  evidenceStore = null,
  evidencePolicy = {},
  minimumScoredCoverage = 60,
} = {}) {
  if (!Array.isArray(products) || products.length < 2 || products.length > 4) {
    throw new TypeError("Recommendation requires between 2 and 4 products");
  }
  const domain = products[0]?.domain;
  validateDomain(domain);
  if (!Number.isFinite(minimumScoredCoverage) || minimumScoredCoverage < 0 || minimumScoredCoverage > 100) {
    throw new TypeError("minimumScoredCoverage must be between 0 and 100");
  }
  const criteria = buildRecommendationCriteria({ domain, priorities, profile });
  const comparison = compareProducts({ products, criteria, evidenceStore, evidencePolicy });

  const annotated = comparison.ranking.map(item => {
    const strengths = item.breakdown
      .filter(field => field.score !== null && field.score >= 70)
      .sort((a, b) => b.score - a.score)
      .map(describeCriterion);
    const compromises = item.breakdown
      .filter(field => field.score !== null && field.score < 40)
      .sort((a, b) => a.score - b.score)
      .map(describeCriterion);
    const eligible = item.score !== null && item.scoredCoverage >= minimumScoredCoverage;
    return Object.freeze({
      ...item,
      eligibility: eligible ? "eligible" : item.score === null ? "insufficient_data" : "insufficient_coverage",
      strengths: Object.freeze(strengths),
      compromises: Object.freeze(compromises),
      explanation: Object.freeze({
        score: item.score,
        scoredCoverage: item.scoredCoverage,
        evidenceCoverage: item.evidenceCoverage,
        verifiedCoverage: item.verifiedCoverage,
        strengths: Object.freeze(strengths),
        compromises: Object.freeze(compromises),
        caveats: comparison.caveats,
      }),
    });
  });

  const ranking = annotated
    .sort((a, b) => {
      const aEligible = a.eligibility === "eligible";
      const bEligible = b.eligibility === "eligible";
      if (aEligible !== bEligible) return aEligible ? -1 : 1;
      if (a.score === null && b.score === null) return 0;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score;
    })
    .map((item, index) => Object.freeze({ ...item, position: index + 1 }));

  const eligibleRanking = ranking
    .filter(item => item.eligibility === "eligible")
    .sort((a, b) => b.score - a.score);
  const first = eligibleRanking[0] ?? null;
  const tied = first !== null && eligibleRanking.filter(item => item.score === first.score).length > 1;
  const winnerId = !first || tied ? null : first.id;
  const decision = !first
    ? (ranking.some(item => item.score !== null) ? "insufficient_coverage" : "insufficient_data")
    : tied ? "tie" : "recommended";

  const summary = decision === "recommended"
    ? `Recommended: ${first.name}. It ranks highest against the selected priorities and meets the minimum scored-coverage threshold.`
    : decision === "tie"
      ? "No single winner: the highest eligible products are tied under the selected priorities."
      : decision === "insufficient_coverage"
        ? "No recommendation: available comparable data does not meet the minimum coverage threshold."
        : "No recommendation: there is not enough comparable data to score the supplied products.";

  return Object.freeze({
    domain,
    profile: profile ?? null,
    criteria,
    decision,
    winnerId,
    summary,
    ranking: Object.freeze(ranking),
    comparisonDecision: comparison.decision,
    evidenceMode: comparison.evidenceMode,
    minimumScoredCoverage,
    caveats: comparison.caveats,
  });
}

export const RECOMMENDATION_PROFILES = PROFILES;
