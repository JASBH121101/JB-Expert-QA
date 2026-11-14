/**
 * JB Advisor Engine
 * Understand. Compare. Recommend.
 *
 * Public entry point. Domain logic is intentionally separated from
 * external AI providers and network research adapters.
 */
export const ENGINE_NAME = "JB Advisor Engine";
export const ENGINE_ID = "JBAE";
export const ENGINE_VERSION = "0.1.0";

export { DOMAINS } from "./core/domains.js";
import { DOMAINS } from "./core/domains.js";

export function getEngineInfo() {
  return Object.freeze({
    name: ENGINE_NAME,
    id: ENGINE_ID,
    version: ENGINE_VERSION,
    domains: Object.values(DOMAINS),
    principles: [
      "evidence-first",
      "explainable-scoring",
      "offline-first",
      "human-approval-for-sensitive-changes",
      "domain-isolated-normalization",
      "coverage-aware-recommendations",
      "versioned-local-knowledge",
      "deterministic-advisor-orchestration",
      "provider-agnostic-research",
      "offline-searchable-catalog",
      "multi-provider-live-research",
    ],
  });
}

export { AdvisorCore, createAdvisorCore } from "./advisor/advisor-core.js";
export { ResearchEngine } from "./research/research-engine.js";
export { compareNicaraguaRetailerOffers } from "./research/nicaragua-retailer-comparison.js";
export { CatalogIndex, searchCatalog } from "./knowledge/catalog-index.js";
export {
  createScentoResearchProvider,
  createTenMlResearchProvider,
  createOpenBeautyFactsResearchProvider,
  createWikidataResearchProvider,
  createTechApiResearchProvider,
  createCoreInfoResearchProvider,
  createSicsaResearchProvider,
  createRadioShackResearchProvider,
  createLaCuracaoResearchProvider,
  createElGalloMasGalloResearchProvider,
  createSimanResearchProvider,
  createElVerdugoResearchProvider,
  createDefaultResearchProviders,
  NICARAGUA_RETAILER_INTEGRATION_STATUS,
} from "./research/providers.js";
export {
  createEvidenceRecord,
  EVIDENCE_STATUSES,
  SOURCE_TYPES,
} from "./core/evidence.js";

export { EvidenceStore } from "./core/evidence-store.js";
export {
  KnowledgeStore,
  MemoryKnowledgeAdapter,
} from "./knowledge/knowledge-store.js";
export {
  CapacitorSQLiteKnowledgeAdapter,
  CAPACITOR_SQLITE_SCHEMA_VERSION,
} from "./knowledge/capacitor-sqlite-adapter.js";
export {
  KNOWLEDGE_SCHEMA_VERSION,
  createEmptyKnowledgeSnapshot,
  migrateKnowledgeSnapshot,
  validateKnowledgeSnapshot,
  normalizeCatalogProduct,
} from "./knowledge/migrations.js";
export { getSourcePolicy, assessSource } from "./research/source-policy.js";
export { createResearchCandidate } from "./research/research-candidate.js";
export { compareProducts } from "./comparison/compare.js";
export { matchProducts, findProductMatches, ProductIdentityMatcher } from "./core/product-matching.js";

export {
  normalizeTechnologyProduct,
  TECHNOLOGY_DEVICE_TYPES,
} from "./domains/technology/adapter.js";
export {
  normalizeFragranceProduct,
  FRAGRANCE_PRODUCT_TYPES,
  FRAGRANCE_CONCENTRATIONS,
} from "./domains/fragrance/adapter.js";
export { buildFragrancePerformanceProfile } from "./domains/fragrance/performance.js";
export { matchFragrances } from "./domains/fragrance/matching.js";
export { parseFragranceCustomerMessage } from "./domains/fragrance/intent.js";
export { buildFragranceCustomerExplanation } from "./domains/fragrance/customer-explanation.js";
export {
  auditFragranceLibrary,
  renderFragranceQualityAuditMarkdown,
} from "./domains/fragrance/quality-audit.js";

export {
  buildRecommendationCriteria,
  getRecommendationProfiles,
  RECOMMENDATION_PROFILES,
  recommendProducts,
} from "./recommendation/recommend.js";

export {
  SCENTO_DATASET,
  parseCsvRecords,
  createScentoFragranceLibrary,
  buildScentoFragranceBundle,
  buildScentoKnowledgeSnapshot,
  importScentoFragranceLibrary,
} from "./domains/fragrance/library.js";
