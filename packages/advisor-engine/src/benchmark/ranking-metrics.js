const DOMAINS = new Set(["fragrance", "technology"]);

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function normalizeGrades(relevanceById) {
  if (!relevanceById || typeof relevanceById !== "object" || Array.isArray(relevanceById)) {
    throw new TypeError("relevanceById must be an object keyed by product ID");
  }
  const grades = {};
  for (const [id, grade] of Object.entries(relevanceById)) {
    requireText(id, "relevance product ID");
    if (typeof grade !== "number" || !Number.isFinite(grade) || grade < 0) {
      throw new TypeError(`Relevance grade for ${id} must be a non-negative finite number`);
    }
    grades[id] = grade;
  }
  return grades;
}

function normalizeRanking(rankedIds) {
  if (!Array.isArray(rankedIds) || rankedIds.length === 0) throw new TypeError("rankedIds must be a non-empty array");
  const normalized = rankedIds.map((id, index) => requireText(id, `rankedIds[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new TypeError("rankedIds cannot contain duplicates");
  return normalized;
}

function dcg(grades, cutoff) {
  return grades.slice(0, cutoff).reduce((sum, grade, index) => {
    return sum + ((2 ** grade - 1) / Math.log2(index + 2));
  }, 0);
}

/**
 * NDCG@K for a single ranked list.
 * Returns null when every reviewed item has zero relevance; no useful ideal ranking exists.
 */
export function calculateNdcgAtK(rankedIds, relevanceById, cutoff = 3) {
  const ranking = normalizeRanking(rankedIds);
  const grades = normalizeGrades(relevanceById);
  if (!Number.isSafeInteger(cutoff) || cutoff < 1 || cutoff > 50) {
    throw new TypeError("cutoff must be an integer between 1 and 50");
  }
  const actual = ranking.map(id => grades[id] ?? 0);
  const ideal = Object.values(grades).sort((a, b) => b - a);
  const idealDcg = dcg(ideal, cutoff);
  if (idealDcg === 0) return null;
  return Number((dcg(actual, cutoff) / idealDcg).toFixed(4));
}

function mean(values) {
  return values.length === 0 ? null : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function summarizeCases(cases, cutoff) {
  const top1Cases = cases.filter(item => item.expectedWinnerId !== null);
  const top1Correct = top1Cases.filter(item => item.rankedIds[0] === item.expectedWinnerId).length;
  const ndcgs = cases.map(item => calculateNdcgAtK(item.rankedIds, item.relevanceById, cutoff)).filter(value => value !== null);
  const evidenceCoverage = cases.map(item => item.evidenceCoverage).filter(value => value !== null);
  const verifiedCoverage = cases.map(item => item.verifiedCoverage).filter(value => value !== null);
  return Object.freeze({
    caseCount: cases.length,
    top1CaseCount: top1Cases.length,
    top1Agreement: top1Cases.length ? Number((top1Correct / top1Cases.length).toFixed(4)) : null,
    ndcgAtK: mean(ndcgs),
    ndcgCaseCount: ndcgs.length,
    meanEvidenceCoverage: mean(evidenceCoverage),
    meanVerifiedCoverage: mean(verifiedCoverage),
  });
}

/**
 * Evaluates already-reviewed expected winners and graded relevance labels.
 * It does not generate labels or claim that test fixtures represent real users.
 */
export function evaluateRankingBenchmark({ cases, cutoff = 3 } = {}) {
  if (!Array.isArray(cases) || cases.length === 0) throw new TypeError("cases must be a non-empty array");
  if (!Number.isSafeInteger(cutoff) || cutoff < 1 || cutoff > 50) throw new TypeError("cutoff must be an integer between 1 and 50");

  const ids = new Set();
  const normalized = cases.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`cases[${index}] must be an object`);
    const id = requireText(item.id, `cases[${index}].id`);
    if (ids.has(id)) throw new TypeError(`Duplicate benchmark case ID: ${id}`);
    ids.add(id);
    const domain = requireText(item.domain, `cases[${index}].domain`);
    if (!DOMAINS.has(domain)) throw new TypeError(`Unsupported benchmark domain: ${domain}`);
    const profile = requireText(item.profile, `cases[${index}].profile`);
    const rankedIds = normalizeRanking(item.rankedIds);
    const relevanceById = normalizeGrades(item.relevanceById);
    const expectedWinnerId = item.expectedWinnerId == null ? null : requireText(item.expectedWinnerId, "expectedWinnerId");
    if (expectedWinnerId && !rankedIds.includes(expectedWinnerId)) {
      throw new Error(`Expected winner ${expectedWinnerId} is missing from ranking in case ${id}`);
    }
    const evidenceCoverage = item.evidenceCoverage ?? null;
    const verifiedCoverage = item.verifiedCoverage ?? null;
    for (const [field, value] of [["evidenceCoverage", evidenceCoverage], ["verifiedCoverage", verifiedCoverage]]) {
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) {
        throw new TypeError(`${field} in case ${id} must be between 0 and 100`);
      }
    }
    return Object.freeze({
      id, domain, profile, rankedIds: Object.freeze(rankedIds),
      relevanceById: Object.freeze(relevanceById), expectedWinnerId,
      evidenceCoverage, verifiedCoverage,
    });
  });

  const perDomain = {};
  for (const domain of [...new Set(normalized.map(item => item.domain))].sort()) {
    perDomain[domain] = summarizeCases(normalized.filter(item => item.domain === domain), cutoff);
  }
  const profileKeys = [...new Set(normalized.map(item => `${item.domain}:${item.profile}`))].sort();
  const perProfile = {};
  for (const key of profileKeys) {
    const [domain, profile] = key.split(":");
    perProfile[key] = summarizeCases(normalized.filter(item => item.domain === domain && item.profile === profile), cutoff);
  }

  return Object.freeze({
    cutoff,
    overall: summarizeCases(normalized, cutoff),
    perDomain: Object.freeze(perDomain),
    perProfile: Object.freeze(perProfile),
    caveat: "Metrics describe only the supplied reviewed benchmark cases. They are not population-level recommendation accuracy.",
  });
}
