import { DOMAINS } from "../core/domains.js";
import { EVIDENCE_STATUSES } from "../core/evidence.js";
import { createResearchCandidate } from "./research-candidate.js";
import { getSourcePolicy } from "./source-policy.js";

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function readClock(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Research clock must return a valid date");
  return date.toISOString();
}

function normalizeProviders(providers) {
  if (!Array.isArray(providers)) throw new TypeError("Research providers must be an array");
  const registry = new Map();
  for (const provider of providers) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      throw new TypeError("Each research provider must be an object");
    }
    const id = requireText(provider.id, "provider.id");
    if (registry.has(id)) throw new TypeError(`Duplicate research provider: ${id}`);
    if (typeof provider.search !== "function") {
      throw new TypeError(`Research provider ${id} must implement search()`);
    }
    if (provider.domains !== undefined &&
        (!Array.isArray(provider.domains) || provider.domains.length === 0 ||
         provider.domains.some(domain => !Object.values(DOMAINS).includes(domain)))) {
      throw new TypeError(`Research provider ${id} has invalid domains`);
    }
    registry.set(id, Object.freeze({
      id,
      domains: provider.domains ? Object.freeze([...new Set(provider.domains)]) : null,
      search: provider.search,
    }));
  }
  return registry;
}

/**
 * Provider-agnostic research orchestration.
 * Providers retrieve data; JBAE owns evidence validation and trust status.
 */
export class ResearchEngine {
  #providers;
  #clock;
  #pending = new Map();
  #knownEvidenceIds = new Set();
  #maxPendingCandidates;

  constructor({ providers = [], clock = () => new Date(), maxPendingCandidates = 100 } = {}) {
    if (typeof clock !== "function") throw new TypeError("Research clock must be a function");
    if (!Number.isSafeInteger(maxPendingCandidates) || maxPendingCandidates < 1) {
      throw new TypeError("maxPendingCandidates must be a positive integer");
    }
    this.#providers = normalizeProviders(providers);
    this.#clock = clock;
    this.#maxPendingCandidates = maxPendingCandidates;
  }

  getProviderIds() {
    return Object.freeze([...this.#providers.keys()]);
  }

  getPendingCandidates() {
    return Object.freeze([...this.#pending.values()]);
  }

  async research(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("Research request must be an object");
    }
    const domain = requireText(request.domain, "domain");
    if (!Object.values(DOMAINS).includes(domain)) throw new TypeError("Unsupported research domain");
    const subjectId = requireText(request.subjectId, "subjectId");
    const field = requireText(request.field, "field");
    const query = requireText(request.query, "query");
    const providerId = requireText(request.providerId, "providerId");
    const limit = request.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new TypeError("Research result limit must be an integer between 1 and 20");
    }

    const provider = this.#providers.get(providerId);
    if (!provider) throw new Error(`Research provider not registered: ${providerId}`);
    if (provider.domains && !provider.domains.includes(domain)) {
      throw new Error(`Research provider ${providerId} does not support ${domain}`);
    }

    const policy = getSourcePolicy({ domain, field });
    const retrievedAt = readClock(this.#clock);
    const rawResults = await provider.search({ domain, subjectId, field, query, limit });
    if (!Array.isArray(rawResults)) {
      throw new TypeError(`Research provider ${providerId} must return an array`);
    }

    const selected = rawResults.slice(0, limit);
    const candidates = [];
    const batchIds = new Set();
    for (const item of selected) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new TypeError("Research provider results must be objects");
      }
      const sourceRecordId = requireText(item.id, "research result id");
      if (!Object.hasOwn(item, "value") || item.value === undefined || item.value === null) {
        throw new TypeError(`Research result ${sourceRecordId} must include a non-null value`);
      }
      const evidenceId = [providerId, domain, subjectId, field, sourceRecordId].join(":");
      const candidateId = `candidate:${evidenceId}`;
      if (batchIds.has(evidenceId) || this.#knownEvidenceIds.has(evidenceId)) {
        throw new Error(`Duplicate research evidence ID: ${evidenceId}`);
      }
      batchIds.add(evidenceId);

      const candidate = createResearchCandidate({
        id: evidenceId,
        domain,
        subjectId,
        field,
        value: item.value,
        // Provider output is always a candidate, never self-certified fact.
        status: EVIDENCE_STATUSES.UNCONFIRMED,
        confidence: item.confidence,
        source: item.source,
        observedAt: item.observedAt ?? retrievedAt,
        note: item.note ?? `Retrieved by provider ${providerId}; awaiting human review.`,
      }, { now: retrievedAt });

      candidates.push(Object.freeze({
        ...candidate,
        providerId,
        query,
        retrievedAt,
      }));
    }

    if (this.#pending.size + candidates.length > this.#maxPendingCandidates) {
      throw new Error("Research pending-candidate capacity would be exceeded");
    }
    for (const candidate of candidates) {
      this.#pending.set(candidate.candidateId, candidate);
      this.#knownEvidenceIds.add(candidate.evidence.id);
    }

    return Object.freeze({
      domain,
      subjectId,
      field,
      query,
      providerId,
      retrievedAt,
      candidateCount: candidates.length,
      truncated: rawResults.length > limit,
      sourcePolicy: Object.freeze({
        preferredTypes: policy.preferredTypes,
        freshnessDays: policy.freshnessDays,
      }),
      candidates: Object.freeze(candidates),
      decision: "pending_review",
      changesVerifiedData: false,
      caveat: "Retrieved claims are unconfirmed candidates. They are not added to local knowledge until explicitly approved and never become verified through retrieval alone.",
    });
  }

  async stageCandidate(candidateId, { knowledgeStore, approved = false } = {}) {
    const id = requireText(candidateId, "candidateId");
    if (approved !== true) {
      throw new Error("Explicit human approval is required to stage a research candidate");
    }
    if (!knowledgeStore || typeof knowledgeStore.addEvidence !== "function") {
      throw new TypeError("knowledgeStore must implement addEvidence()");
    }
    const candidate = this.#pending.get(id);
    if (!candidate) throw new Error(`Pending research candidate not found: ${id}`);
    if (candidate.evidence.status !== EVIDENCE_STATUSES.UNCONFIRMED) {
      throw new Error("Only unconfirmed research candidates may be staged");
    }

    const stored = await knowledgeStore.addEvidence(candidate.evidence);
    this.#pending.delete(id);
    return Object.freeze({
      candidateId: id,
      evidenceId: stored.id,
      status: stored.status,
      staged: true,
      remainsUnconfirmed: true,
    });
  }
}
