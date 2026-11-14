const STRICT_STATUSES = new Set(["verified", "cross_checked"]);
const REPORTED_SOURCES = new Set(["independent_test", "community"]);

function canonicalValue(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalValue).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ":" + canonicalValue(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function unavailable(reason, detail) {
  return Object.freeze({
    status: "unavailable",
    reason,
    detail,
  });
}

function resolvePerformanceClaim(product, field, expectedValue, evidenceStore, allowReported) {
  if (!evidenceStore) return { status: "not_assessed", accepted: [], reason: "evidence_store_missing" };
  if (expectedValue === undefined || expectedValue === null) {
    return { status: "missing_value", accepted: [], reason: "value_missing" };
  }

  const suppliedIds = product.evidenceIds?.[field] ?? [];
  if (!Array.isArray(suppliedIds)) {
    throw new TypeError("product.evidenceIds." + field + " must be an array of evidence IDs");
  }
  const ids = suppliedIds.map((id, index) => {
    if (typeof id !== "string" || !id.trim()) {
      throw new TypeError("product.evidenceIds." + field + "[" + index + "] must be a non-empty evidence ID");
    }
    return id.trim();
  });
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("Duplicate evidence IDs for field: " + field);
  }
  if (ids.length === 0) return { status: "missing_evidence", accepted: [], reason: "evidence_missing" };

  const records = ids.map(id => {
    const record = evidenceStore.getById(id);
    if (!record) throw new Error("Evidence record not found: " + id);
    if (record.domain !== "fragrance" || record.subjectId !== product.id || record.field !== field) {
      throw new Error("Evidence record " + id + " does not match product, domain and field");
    }
    if (canonicalValue(record.value) !== canonicalValue(expectedValue)) {
      throw new Error("Evidence record " + id + " does not support the supplied value for " + field);
    }
    return record;
  });

  const conflicts = evidenceStore.conflicts({
    domain: "fragrance",
    subjectId: product.id,
    field,
  });
  if (conflicts.length > 1) return { status: "conflict", accepted: [], reason: "conflicting_evidence" };

  const strict = records.filter(record =>
    STRICT_STATUSES.has(record.status) &&
    record.source?.type === "independent_test"
  );
  if (strict.length) {
    return {
      status: strict.some(record => record.status === "cross_checked") ? "cross_checked" : "verified",
      accepted: strict,
      reason: null,
      basis: "independent_test",
    };
  }

  const reported = records.filter(record =>
    record.status === "reported" && REPORTED_SOURCES.has(record.source?.type)
  );
  if (allowReported && reported.length) {
    return {
      status: "reported",
      accepted: reported,
      reason: null,
      basis: "reported_observation",
    };
  }

  const hasReported = records.some(record => record.status === "reported");
  return {
    status: hasReported ? "reported_only" : "unconfirmed",
    accepted: [],
    reason: hasReported ? "reported_claim_requires_opt_in" : "no_eligible_independent_test",
  };
}

function aggregateEvidence(claims) {
  const records = claims.flatMap(claim => claim.accepted);
  const evidenceIds = [...new Set(records.map(record => record.id))];
  const sourceMap = new Map();
  for (const record of records) {
    if (record.source?.url) {
      sourceMap.set(record.source.url, {
        name: record.source.name,
        url: record.source.url,
      });
    }
    for (const url of record.source?.references ?? []) {
      sourceMap.set(url, { name: record.source.name, url });
    }
  }
  const confidenceValues = records.map(record => record.confidence).filter(Number.isFinite);
  const averageConfidence = confidenceValues.length
    ? Number((confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length).toFixed(4))
    : null;
  const allStrict = claims.every(claim => claim.basis === "independent_test");
  const allReported = claims.every(claim => claim.basis === "reported_observation");
  const evidenceStatus = allStrict
    ? (claims.some(claim => claim.status === "cross_checked") ? "cross_checked" : "verified")
    : allReported ? "reported" : "mixed";
  // References are supporting links, not independent evidence sources. Count only
  // the primary source URLs attached to evidence records when grading strength.
  const primarySourceCount = new Set(records.map(record => record.source?.url).filter(Boolean)).size;
  const referenceCount = new Set(records.flatMap(record => record.source?.references ?? [])).size;
  const evidenceStrength = allReported
    ? "limited"
    : evidenceStatus === "cross_checked" && primarySourceCount >= 2 && averageConfidence >= 0.8
      ? "strong"
      : primarySourceCount >= 1 && averageConfidence >= 0.8
        ? "good"
        : "limited";

  return Object.freeze({
    evidenceStatus,
    basis: allStrict ? "independent_test" : allReported ? "reported_observation" : "mixed",
    evidenceStrength,
    evidenceCount: evidenceIds.length,
    sourceCount: primarySourceCount,
    referenceCount,
    averageSourceConfidence: averageConfidence,
    evidenceIds: Object.freeze(evidenceIds),
    sources: Object.freeze([...sourceMap.values()].map(item => Object.freeze(item))),
    confidenceNote: "Source confidence is not a calibrated probability or a guarantee of real-world performance.",
  });
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

function buildRangeEstimate(product, definition, evidenceStore, allowReported) {
  const min = product.attributes[definition.minField];
  const max = product.attributes[definition.maxField];
  if (min === undefined && max === undefined) {
    return unavailable("range_not_provided", "No source-backed interval is recorded for this performance dimension.");
  }
  if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) ||
      !Number.isFinite(max) || min <= 0 || max <= min) {
    return unavailable("invalid_or_incomplete_range", "Both positive range bounds are required, and the maximum must exceed the minimum.");
  }

  const claims = [
    resolvePerformanceClaim(product, definition.minField, min, evidenceStore, allowReported),
    resolvePerformanceClaim(product, definition.maxField, max, evidenceStore, allowReported),
  ];
  if (claims.some(claim => claim.accepted.length === 0)) {
    const reason = claims.some(claim => claim.reason === "conflicting_evidence")
      ? "conflicting_evidence"
      : claims.some(claim => claim.reason === "reported_claim_requires_opt_in")
        ? "reported_claim_requires_opt_in"
        : claims.some(claim => claim.reason === "evidence_store_missing")
          ? "evidence_store_missing"
          : "incomplete_evidence";
    return unavailable(reason, "The two interval bounds must each have matching, eligible evidence before a customer-facing range can be shown.");
  }
  const metadata = aggregateEvidence(claims);
  if (metadata.evidenceStatus === "mixed") {
    return unavailable("mixed_evidence", "The interval bounds do not share the same evidence class; no combined range is displayed.");
  }

  return Object.freeze({
    status: "estimated",
    min,
    max,
    unit: "hours",
    display: formatNumber(min) + "–" + formatNumber(max) + " hours (estimated)",
    ...metadata,
    disclaimer: metadata.basis === "reported_observation"
      ? "Based on attributed community or reported observations; not an independently verified test result."
      : "Evidence-backed estimate, not a guarantee. Skin, application, temperature and humidity can change the result.",
  });
}

function buildCategoricalEstimate(product, field, labels, evidenceStore, allowReported) {
  const value = product.attributes[field];
  if (value === undefined || value === null) {
    return unavailable("value_not_provided", "No source-backed classification is recorded.");
  }
  const claim = resolvePerformanceClaim(product, field, value, evidenceStore, allowReported);
  if (!claim.accepted.length) {
    return unavailable(claim.reason, "The classification is not supported by eligible, field-matched evidence.");
  }
  const metadata = aggregateEvidence([claim]);
  return Object.freeze({
    status: "estimated",
    value,
    label: labels[value] ?? value,
    ...metadata,
    disclaimer: metadata.basis === "reported_observation"
      ? "Reported classification; individual perception may differ."
      : "Evidence-backed classification, not a universal or guaranteed perception.",
  });
}

export function buildFragrancePerformanceProfile(
  product,
  evidenceStore = null,
  { allowReported = false } = {},
) {
  if (!product || typeof product !== "object" || product.domain !== "fragrance" ||
      !product.attributes || typeof product.attributes !== "object") {
    throw new TypeError("A normalized fragrance product is required");
  }
  if (typeof allowReported !== "boolean") {
    throw new TypeError("allowReported must be a boolean");
  }
  if (evidenceStore !== null &&
      (typeof evidenceStore.getById !== "function" || typeof evidenceStore.conflicts !== "function")) {
    throw new TypeError("evidenceStore must implement getById() and conflicts()");
  }

  return Object.freeze({
    productId: product.id,
    productName: product.name,
    longevity: buildRangeEstimate(product, {
      minField: "longevityMinHours",
      maxField: "longevityMaxHours",
    }, evidenceStore, allowReported),
    projectionDuration: buildRangeEstimate(product, {
      minField: "projectionDurationMinHours",
      maxField: "projectionDurationMaxHours",
    }, evidenceStore, allowReported),
    intensity: buildCategoricalEstimate(product, "intensityLevel", {
      soft: "soft / suave",
      moderate: "moderada",
      strong: "intensa",
      very_strong: "muy intensa",
    }, evidenceStore, allowReported),
    projection: buildCategoricalEstimate(product, "projectionLevel", {
      close: "cercana a la piel",
      moderate: "moderada",
      strong: "alta",
      very_strong: "muy alta",
    }, evidenceStore, allowReported),
    sillage: buildCategoricalEstimate(product, "sillageLevel", {
      low: "baja",
      moderate: "moderada",
      strong: "alta",
      very_strong: "muy alta",
    }, evidenceStore, allowReported),
  });
}
