const domains = new Set(["fragrance", "technology"]);
const verifiedStatuses = new Set(["verified", "cross_checked"]);
const usableStatuses = new Set(["verified", "cross_checked", "reported"]);
const ORDINAL_FIELDS = Object.freeze({
  intensityLevel: Object.freeze({ soft: 1, moderate: 2, strong: 3, very_strong: 4 }),
  projectionLevel: Object.freeze({ close: 1, moderate: 2, strong: 3, very_strong: 4 }),
  sillageLevel: Object.freeze({ low: 1, moderate: 2, strong: 3, very_strong: 4 }),
});

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function canonicalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeProduct(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Each item must be an object");
  }
  const id = text(input.id, "product.id");
  const name = text(input.name, "product.name");
  const domain = text(input.domain, "product.domain");
  if (!domains.has(domain)) throw new TypeError("Unsupported comparison domain");
  if (!input.attributes || typeof input.attributes !== "object" || Array.isArray(input.attributes)) {
    throw new TypeError("product.attributes must be an object");
  }
  if (input.evidenceIds !== undefined &&
      (!input.evidenceIds || typeof input.evidenceIds !== "object" || Array.isArray(input.evidenceIds))) {
    throw new TypeError("product.evidenceIds must be an object keyed by attribute field");
  }
  const evidenceIds = input.evidenceIds ?? {};
  if (!evidenceIds || typeof evidenceIds !== "object" || Array.isArray(evidenceIds)) {
    throw new TypeError("product.evidenceIds must be an object keyed by attribute field");
  }
  const categoryField = domain === "technology" ? "deviceType" : "productType";
  const category = input[categoryField] == null ? null : text(input[categoryField], `product.${categoryField}`);
  return Object.freeze({
    id,
    name,
    domain,
    category,
    attributes: Object.freeze({ ...input.attributes }),
    evidenceIds: Object.freeze({ ...evidenceIds }),
  });
}

function normalizeCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new TypeError("At least one criterion is required");
  }
  const seen = new Set();
  return criteria.map(item => {
    if (!item || typeof item !== "object") throw new TypeError("Each criterion must be an object");
    const field = text(item.field, "criterion.field");
    if (seen.has(field)) throw new TypeError(`Duplicate criterion: ${field}`);
    seen.add(field);
    const weight = item.weight;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
      throw new TypeError("Criterion weight must be a positive finite number");
    }
    const direction = item.direction ?? "higher";
    if (!["higher", "lower", "target", "match"].includes(direction)) {
      throw new TypeError("Unsupported criterion direction");
    }
    if (direction === "target" && (typeof item.target !== "number" || !Number.isFinite(item.target))) {
      throw new TypeError("Target direction requires a finite numeric target");
    }
    if (direction === "match" && (typeof item.target !== "string" || !item.target.trim())) {
      throw new TypeError("Match direction requires a non-empty string target");
    }
    return Object.freeze({ field, weight, direction, target: item.target ?? null });
  });
}

function normalizeEvidenceOptions(evidenceStore, evidencePolicy) {
  const policy = evidencePolicy ?? {};
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("evidencePolicy must be an object");
  }
  const allowReported = policy.allowReported ?? false;
  if (typeof allowReported !== "boolean") {
    throw new TypeError("evidencePolicy.allowReported must be a boolean");
  }
  if (evidenceStore == null) {
    return Object.freeze({ store: null, allowReported });
  }
  if (typeof evidenceStore.getById !== "function" || typeof evidenceStore.conflicts !== "function") {
    throw new TypeError("evidenceStore must implement getById() and conflicts()");
  }
  return Object.freeze({ store: evidenceStore, allowReported });
}

function resolveEvidence(product, field, value, options) {
  if (!options.store) {
    return Object.freeze({
      status: "not_assessed",
      ids: Object.freeze([]),
      confidence: null,
      eligible: true,
      verified: false,
    });
  }
  if (value === null || value === undefined) {
    return Object.freeze({
      status: "no_value",
      ids: Object.freeze([]),
      confidence: null,
      eligible: false,
      verified: false,
    });
  }

  const suppliedIds = product.evidenceIds[field] ?? [];
  if (!Array.isArray(suppliedIds)) {
    throw new TypeError(`product.evidenceIds.${field} must be an array of evidence IDs`);
  }
  const ids = suppliedIds.map((id, index) => text(id, `product.evidenceIds.${field}[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`Duplicate evidence IDs for field: ${field}`);
  }

  const records = ids.map(id => {
    const record = options.store.getById(id);
    if (!record) throw new Error(`Evidence record not found: ${id}`);
    if (record.domain !== product.domain || record.subjectId !== product.id || record.field !== field) {
      throw new Error(`Evidence record ${id} does not match product, domain and field`);
    }
    if (canonicalValue(record.value) !== canonicalValue(value)) {
      throw new Error(`Evidence record ${id} does not support the supplied value for ${field}`);
    }
    return record;
  });

  const conflictGroups = options.store.conflicts({
    domain: product.domain,
    subjectId: product.id,
    field,
  });
  if (conflictGroups.length > 1) {
    return Object.freeze({
      status: "conflict",
      ids: Object.freeze(ids),
      confidence: null,
      eligible: false,
      verified: false,
    });
  }

  if (records.length === 0) {
    return Object.freeze({
      status: "missing_evidence",
      ids: Object.freeze([]),
      confidence: null,
      eligible: false,
      verified: false,
    });
  }

  const supporting = records.filter(record => usableStatuses.has(record.status));
  const verified = supporting.filter(record => verifiedStatuses.has(record.status));
  const reported = supporting.filter(record => record.status === "reported");
  const accepted = verified.length > 0 ? verified : (options.allowReported ? reported : []);

  if (accepted.length === 0) {
    return Object.freeze({
      status: reported.length > 0 ? "reported_only" : "unconfirmed",
      ids: Object.freeze(ids),
      confidence: null,
      eligible: false,
      verified: false,
    });
  }

  const status = verified.length > 0
    ? (verified.some(record => record.status === "cross_checked") ? "cross_checked" : "verified")
    : "reported";
  const confidence = accepted.reduce((sum, record) => sum + record.confidence, 0) / accepted.length;

  return Object.freeze({
    status,
    ids: Object.freeze(ids),
    confidence: Number(confidence.toFixed(4)),
    eligible: true,
    verified: verified.length > 0,
  });
}

function scoreValue(value, criterion, products, field) {
  if (value === null || value === undefined) return null;
  if (criterion.direction === "match") {
    const normalizedValue = String(value).trim().toLocaleLowerCase();
    const expected = criterion.target.trim().toLocaleLowerCase();
    return normalizedValue === expected ? 100 : 0;
  }
  const ordinalMap = ORDINAL_FIELDS[field];
  const numericValue = ordinalMap ? ordinalMap[String(value).trim().toLowerCase()] : value;
  if (ordinalMap && !Number.isFinite(numericValue)) {
    throw new TypeError("Unsupported ordinal value for " + field + ": " + String(value));
  }
  if (typeof numericValue !== "number" || !Number.isFinite(numericValue)) {
    throw new TypeError("Numeric criterion " + field + " requires numeric product values");
  }
  const values = products
    .map(product => product.attributes[field])
    .map(item => ordinalMap ? ordinalMap[String(item).trim().toLowerCase()] : item)
    .filter(item => typeof item === "number" && Number.isFinite(item));
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 100;
  if (criterion.direction === "higher") return ((numericValue - min) / (max - min)) * 100;
  if (criterion.direction === "lower") return ((max - numericValue) / (max - min)) * 100;
  const distance = Math.abs(numericValue - criterion.target);
  const maxDistance = Math.max(...values.map(item => Math.abs(item - criterion.target)), 0);
  return maxDistance === 0 ? 100 : (1 - distance / maxDistance) * 100;
}

export function compareProducts({ products, criteria, evidenceStore = null, evidencePolicy = {} }) {
  if (!Array.isArray(products) || products.length < 2 || products.length > 4) {
    throw new TypeError("Comparison requires between 2 and 4 products");
  }
  const normalized = products.map(normalizeProduct);
  if (new Set(normalized.map(product => product.id)).size !== normalized.length) {
    throw new TypeError("Product IDs must be unique");
  }
  if (new Set(normalized.map(product => product.domain)).size !== 1) {
    throw new TypeError("Products from different domains cannot be compared");
  }
  const categories = normalized.map(product => product.category);
  if (categories.some(Boolean) &&
      (categories.some(category => !category) || new Set(categories).size !== 1)) {
    const categoryName = normalized[0].domain === "technology" ? "device types" : "fragrance product types";
    throw new TypeError(`Cannot compare different ${categoryName}`);
  }

  const options = normalizeEvidenceOptions(evidenceStore, evidencePolicy);
  const normalizedCriteria = normalizeCriteria(criteria);
  const totalWeight = normalizedCriteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  const eligibleProductsByField = new Map(
    normalizedCriteria.map(criterion => [
      criterion.field,
      normalized.filter(product => {
        const value = product.attributes[criterion.field];
        return value !== null && value !== undefined &&
          resolveEvidence(product, criterion.field, value, options).eligible;
      }),
    ])
  );

  const results = normalized.map(product => {
    let weightedScore = 0;
    let scoredWeight = 0;
    let dataWeight = 0;
    let evidenceWeight = 0;
    let verifiedWeight = 0;
    let confidenceWeight = 0;
    let confidenceTotal = 0;

    const breakdown = normalizedCriteria.map(criterion => {
      const raw = product.attributes[criterion.field];
      const hasValue = raw !== null && raw !== undefined;
      const evidence = resolveEvidence(product, criterion.field, raw, options);
      const score = hasValue && evidence.eligible
        ? scoreValue(raw, criterion, eligibleProductsByField.get(criterion.field), criterion.field)
        : null;

      if (hasValue) dataWeight += criterion.weight;
      if (score !== null) {
        weightedScore += score * criterion.weight;
        scoredWeight += criterion.weight;
      }
      if (options.store && evidence.eligible) {
        evidenceWeight += criterion.weight;
        if (evidence.verified) verifiedWeight += criterion.weight;
        confidenceTotal += evidence.confidence * criterion.weight;
        confidenceWeight += criterion.weight;
      }

      const status = score !== null
        ? "scored"
        : !hasValue
          ? "missing"
          : evidence.status;
      return Object.freeze({
        field: criterion.field,
        value: raw ?? null,
        weight: criterion.weight,
        score: score === null ? null : Number(score.toFixed(2)),
        status,
        evidence: Object.freeze({
          status: evidence.status,
          evidenceIds: evidence.ids,
          confidence: evidence.confidence,
        }),
      });
    });

    return Object.freeze({
      id: product.id,
      name: product.name,
      category: product.category,
      score: scoredWeight ? Number((weightedScore / scoredWeight).toFixed(2)) : null,
      coverage: Number(((dataWeight / totalWeight) * 100).toFixed(2)),
      scoredCoverage: Number(((scoredWeight / totalWeight) * 100).toFixed(2)),
      evidenceCoverage: options.store
        ? Number(((evidenceWeight / totalWeight) * 100).toFixed(2))
        : null,
      verifiedCoverage: options.store
        ? Number(((verifiedWeight / totalWeight) * 100).toFixed(2))
        : null,
      evidenceConfidence: confidenceWeight
        ? Number((confidenceTotal / confidenceWeight).toFixed(4))
        : null,
      missingFields: breakdown.filter(item => item.status === "missing").map(item => item.field),
      excludedFields: breakdown
        .filter(item => item.status !== "scored" && item.status !== "missing")
        .map(item => Object.freeze({ field: item.field, reason: item.status })),
      breakdown: Object.freeze(breakdown),
    });
  });

  const ranked = [...results].sort((a, b) => {
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  });
  const top = ranked[0];
  const tied = top?.score !== null && ranked.filter(item => item.score === top.score).length > 1;

  const caveats = [
    "Scores are relative to the products and criteria supplied, not universal quality ratings.",
    "Numeric values must use consistent units and comparable measurement methods.",
    "Coverage describes how much criterion weight has supplied values; scoredCoverage describes how much weight contributed to the score.",
  ];
  if (options.store) {
    caveats.push(
      "Evidence-linked scoring excludes missing, unconfirmed and conflicting claims; reported claims are excluded unless evidencePolicy.allowReported is true.",
      "Evidence confidence is the stored confidence value averaged across accepted evidence; it is not a calibrated probability or product-quality score.",
      "Evidence coverage and verified coverage are separate from the product comparison score."
    );
  } else {
    caveats.push(
      "Evidence provenance was not assessed because no EvidenceStore was supplied; scores reflect supplied attributes and are not fact-checked."
    );
  }

  return Object.freeze({
    domain: normalized[0].domain,
    criteria: Object.freeze(normalizedCriteria),
    ranking: Object.freeze(ranked),
    winnerId: top?.score === null || tied ? null : top.id,
    decision: top?.score === null ? "insufficient_data" : tied ? "tie" : "ranked",
    evidenceMode: options.store ? "strict" : "not_assessed",
    caveats: Object.freeze(caveats),
  });
}
