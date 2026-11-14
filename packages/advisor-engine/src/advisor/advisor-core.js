import { DOMAINS } from "../core/domains.js";
import { normalizeFragranceProduct } from "../domains/fragrance/adapter.js";
import { buildFragrancePerformanceProfile } from "../domains/fragrance/performance.js";
import { matchFragrances } from "../domains/fragrance/matching.js";
import { parseFragranceCustomerMessage } from "../domains/fragrance/intent.js";
import { buildFragranceCustomerExplanation } from "../domains/fragrance/customer-explanation.js";
import { normalizeTechnologyProduct } from "../domains/technology/adapter.js";
import { recommendProducts } from "../recommendation/recommend.js";

function assertRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Advisor request must be an object");
  }
  if (!Object.values(DOMAINS).includes(request.domain)) {
    throw new TypeError("Advisor request domain must be fragrance or technology");
  }
  if (!Array.isArray(request.products) || request.products.length < 2 || request.products.length > 4) {
    throw new TypeError("Advisor requires between 2 and 4 candidate products");
  }
}

function normalizeProducts(domain, products) {
  const normalize = domain === DOMAINS.TECHNOLOGY
    ? normalizeTechnologyProduct
    : normalizeFragranceProduct;
  const normalized = products.map(normalize);
  if (new Set(normalized.map(product => product.id)).size !== normalized.length) {
    throw new TypeError("Advisor candidate IDs must be unique");
  }
  return Object.freeze(normalized);
}

function summarizeProducts(products) {
  return Object.freeze(products.map(product => Object.freeze({
    id: product.id,
    name: product.name,
    category: product.deviceType ?? product.productType,
  })));
}

function validateEvidenceSource({ knowledgeStore, evidenceStore }) {
  if (knowledgeStore !== null && evidenceStore !== null) {
    throw new TypeError("Provide either knowledgeStore or evidenceStore, not both");
  }
  if (knowledgeStore !== null && typeof knowledgeStore.getEvidenceStore !== "function") {
    throw new TypeError("knowledgeStore must implement getEvidenceStore()");
  }
  if (evidenceStore !== null &&
      (typeof evidenceStore.getById !== "function" || typeof evidenceStore.conflicts !== "function")) {
    throw new TypeError("evidenceStore must implement getById() and conflicts()");
  }
}

/**
 * Deterministic orchestration for Fragrance Advisor and Tech Advisor.
 * This layer does not fetch data, call AI providers, or mutate verified facts.
 */
export class AdvisorCore {
  #knowledgeStore;
  #evidenceStore;
  #minimumScoredCoverage;

  constructor({
    knowledgeStore = null,
    evidenceStore = null,
    minimumScoredCoverage = 60,
  } = {}) {
    validateEvidenceSource({ knowledgeStore, evidenceStore });
    if (!Number.isFinite(minimumScoredCoverage) ||
        minimumScoredCoverage < 0 || minimumScoredCoverage > 100) {
      throw new TypeError("minimumScoredCoverage must be between 0 and 100");
    }
    this.#knowledgeStore = knowledgeStore;
    this.#evidenceStore = evidenceStore;
    this.#minimumScoredCoverage = minimumScoredCoverage;
  }

  advise(request) {
    assertRequest(request);
    const products = normalizeProducts(request.domain, request.products);
    const evidenceStore = this.#knowledgeStore
      ? this.#knowledgeStore.getEvidenceStore()
      : this.#evidenceStore;
    const minimumScoredCoverage = request.minimumScoredCoverage ?? this.#minimumScoredCoverage;
    const customerIntent = request.domain === DOMAINS.FRAGRANCE && request.customerMessage
      ? parseFragranceCustomerMessage(request.customerMessage)
      : null;
    const preferences = customerIntent
      ? { ...customerIntent.preferences, ...(request.preferences ?? {}) }
      : request.preferences;
    const inferredProfile = customerIntent?.preferences.performancePriority === "long_lasting"
      ? "long_lasting"
      : customerIntent?.preferences.occasion === "evening"
        ? "evening"
        : customerIntent?.preferences.occasion === "office"
          ? "office"
          : customerIntent?.preferences.intensity === "soft"
            ? "soft_daily"
            : customerIntent?.preferences.preferredCharacters?.includes("fresh")
              ? "fresh_light"
              : customerIntent ? "balanced" : undefined;
    const resolvedProfile = request.profile ?? inferredProfile;

    const evidencePolicy = request.evidencePolicy ?? {};
    const recommendation = recommendProducts({
      products,
      priorities: request.priorities,
      profile: resolvedProfile,
      evidenceStore,
      evidencePolicy,
      minimumScoredCoverage,
    });
    const performance = request.domain === DOMAINS.FRAGRANCE
      ? Object.freeze(products.map(product => buildFragrancePerformanceProfile(
          product,
          evidenceStore,
          { allowReported: evidencePolicy.allowReported === true },
        )))
      : null;
    const preferenceMatch = request.domain === DOMAINS.FRAGRANCE && preferences &&
      Object.keys(preferences).some(key => key !== "performancePriority")
      ? matchFragrances({
          products,
          preferences,
          minimumMatchCoverage: request.minimumMatchCoverage ?? 60,
          evidenceStore,
          evidencePolicy,
        })
      : null;

    const customerExplanation = request.domain === DOMAINS.FRAGRANCE
      ? buildFragranceCustomerExplanation({ preferenceMatch, performance })
      : null;

    return Object.freeze({
      engineId: "JBAE",
      domain: request.domain,
      candidateCount: products.length,
      products: summarizeProducts(products),
      evidence: Object.freeze({
        mode: recommendation.evidenceMode,
        recordCount: evidenceStore?.size ?? null,
        reportedClaimsAllowed: request.evidencePolicy?.allowReported === true,
      }),
      recommendation,
      preferenceMatch,
      customerIntent,
      customerExplanation,
      performance,
      limitations: Object.freeze([
        "Recommendations rank only the supplied candidates; the advisor does not discover or fetch products in this operation.",
        "Scores are relative to the selected criteria and supplied data, not universal quality ratings.",
        "When no EvidenceStore is connected, the supplied attributes are not independently fact-checked.",
        "Fragrance performance ranges are shown only when both bounds have matching, eligible evidence; reported observations require explicit opt-in.",
      ]),
    });
  }
}

export function createAdvisorCore(options = {}) {
  return new AdvisorCore(options);
}
