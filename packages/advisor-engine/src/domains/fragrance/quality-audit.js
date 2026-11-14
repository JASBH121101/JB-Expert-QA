const VERIFIED_STATUSES = new Set(["verified", "cross_checked"]);
const NON_CLAIM_FIELDS = new Set(["scentFamilySystem"]);
const RANGE_FIELDS = Object.freeze([
  Object.freeze({
    key: "longevity",
    minField: "longevityMinHours",
    maxField: "longevityMaxHours",
  }),
  Object.freeze({
    key: "projectionDuration",
    minField: "projectionDurationMinHours",
    maxField: "projectionDurationMaxHours",
  }),
]);
const CATEGORICAL_PERFORMANCE_FIELDS = Object.freeze([
  "intensityLevel",
  "projectionLevel",
  "sillageLevel",
]);

function canonicalValue(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalValue).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ":" + canonicalValue(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function hasStrictIndependentEvidence(product, field, value, evidenceStore) {
  if (!evidenceStore || value === undefined || value === null) return false;
  const ids = product.evidenceIds?.[field];
  if (!Array.isArray(ids) || ids.length === 0) return false;

  const records = [];
  for (const id of ids) {
    const record = evidenceStore.getById(id);
    if (!record ||
        record.domain !== "fragrance" ||
        record.subjectId !== product.id ||
        record.field !== field ||
        canonicalValue(record.value) !== canonicalValue(value)) return false;
    records.push(record);
  }

  if (evidenceStore.conflicts({
    domain: "fragrance",
    subjectId: product.id,
    field,
  }).length > 1) return false;

  return records.some(record =>
    VERIFIED_STATUSES.has(record.status) &&
    record.source?.type === "independent_test"
  );
}

export function auditFragranceLibrary({ products, evidenceStore = null } = {}) {
  if (!Array.isArray(products)) {
    throw new TypeError("products must be an array");
  }
  if (evidenceStore !== null &&
      (typeof evidenceStore.getById !== "function" ||
       typeof evidenceStore.query !== "function" ||
       typeof evidenceStore.conflicts !== "function")) {
    throw new TypeError("evidenceStore must implement getById(), query() and conflicts()");
  }

  const records = evidenceStore?.query({ domain: "fragrance" }) ?? [];
  const statusCounts = {};
  const sourceTypeCounts = {};
  for (const record of records) {
    statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;
    if (record.source?.type) {
      sourceTypeCounts[record.source.type] = (sourceTypeCounts[record.source.type] ?? 0) + 1;
    }
  }

  let claimFieldCount = 0;
  let linkedClaimFieldCount = 0;
  let malformedEvidenceLinkCount = 0;
  let unassessedEvidenceLinkFieldCount = 0;
  const missingEvidenceFields = {};
  for (const product of products) {
    for (const [field, value] of Object.entries(product.attributes ?? {})) {
      if (NON_CLAIM_FIELDS.has(field) || field.startsWith("source")) continue;
      claimFieldCount += 1;
      const ids = product.evidenceIds?.[field];
      if (!Array.isArray(ids) || ids.length === 0) {
        missingEvidenceFields[field] = (missingEvidenceFields[field] ?? 0) + 1;
        continue;
      }
      if (!evidenceStore) {
        // Linked IDs cannot be called malformed when the ledger itself was not supplied.
        unassessedEvidenceLinkFieldCount += 1;
        continue;
      }
      const valid = ids.every(id => {
        const record = evidenceStore?.getById(id);
        const matches = record &&
          record.domain === "fragrance" &&
          record.subjectId === product.id &&
          record.field === field &&
          canonicalValue(record.value) === canonicalValue(value);
        if (!matches) malformedEvidenceLinkCount += 1;
        return matches;
      });
      if (valid) linkedClaimFieldCount += 1;
    }
  }

  const performance = {};
  for (const definition of RANGE_FIELDS) {
    let presentCount = 0;
    let independentlySupportedCount = 0;
    for (const product of products) {
      const attributes = product.attributes ?? {};
      const min = attributes[definition.minField];
      const max = attributes[definition.maxField];
      if (typeof min === "number" && typeof max === "number" && max > min) {
        presentCount += 1;
        if (
          hasStrictIndependentEvidence(product, definition.minField, min, evidenceStore) &&
          hasStrictIndependentEvidence(product, definition.maxField, max, evidenceStore)
        ) independentlySupportedCount += 1;
      }
    }
    performance[definition.key] = Object.freeze({
      productsWithRange: presentCount,
      productsWithIndependentTestEvidence: independentlySupportedCount,
      coveragePercent: products.length
        ? Number(((presentCount / products.length) * 100).toFixed(1))
        : 0,
      independentlySupportedPercent: products.length
        ? Number(((independentlySupportedCount / products.length) * 100).toFixed(1))
        : 0,
    });
  }

  for (const field of CATEGORICAL_PERFORMANCE_FIELDS) {
    let presentCount = 0;
    let independentlySupportedCount = 0;
    for (const product of products) {
      const value = product.attributes?.[field];
      if (value === undefined || value === null) continue;
      presentCount += 1;
      if (hasStrictIndependentEvidence(product, field, value, evidenceStore)) {
        independentlySupportedCount += 1;
      }
    }
    performance[field] = Object.freeze({
      productsWithValue: presentCount,
      productsWithIndependentTestEvidence: independentlySupportedCount,
      coveragePercent: products.length
        ? Number(((presentCount / products.length) * 100).toFixed(1))
        : 0,
      independentlySupportedPercent: products.length
        ? Number(((independentlySupportedCount / products.length) * 100).toFixed(1))
        : 0,
    });
  }

  const verifiedRecordCount =
    (statusCounts.verified ?? 0) + (statusCounts.cross_checked ?? 0);
  const reportedRecordCount = statusCounts.reported ?? 0;
  const distinctSourceCount = new Set(records.map(record => record.source?.url).filter(Boolean)).size;
  const warnings = [];
  if (reportedRecordCount > 0) {
    warnings.push("Reported claims are attributed to their source but are not independently verified.");
  }
  if (performance.longevity.productsWithIndependentTestEvidence === 0) {
    warnings.push("No customer-facing longevity range is supported by linked independent-test evidence in this library snapshot.");
  }
  if (performance.projectionDuration.productsWithIndependentTestEvidence === 0) {
    warnings.push("No customer-facing projection-duration range is supported by linked independent-test evidence in this library snapshot.");
  }
  if (malformedEvidenceLinkCount > 0) {
    warnings.push("One or more product-to-evidence links are malformed or point to a different claim.");
  }
  if (evidenceStore === null) {
    warnings.push("Evidence integrity was not assessed because no EvidenceStore was supplied.");
  }

  return freezeDeep({
    schemaVersion: 1,
    totals: {
      products: products.length,
      evidenceRecords: records.length,
      distinctSourceUrls: distinctSourceCount,
      claimFields: claimFieldCount,
      claimFieldsWithValidEvidenceLinks: linkedClaimFieldCount,
      claimFieldLinkCoveragePercent: claimFieldCount
        ? Number(((linkedClaimFieldCount / claimFieldCount) * 100).toFixed(1))
        : 0,
      malformedEvidenceLinks: malformedEvidenceLinkCount,
      claimFieldsWithEvidenceLinksNotAssessed: unassessedEvidenceLinkFieldCount,
      verifiedOrCrossCheckedRecords: verifiedRecordCount,
      reportedRecords: reportedRecordCount,
    },
    evidenceStatuses: statusCounts,
    evidenceSourceTypes: sourceTypeCounts,
    missingEvidenceFields,
    performance,
    readiness: {
      canShowEvidenceBackedLongevityRanges:
        performance.longevity.productsWithIndependentTestEvidence > 0,
      canShowEvidenceBackedProjectionDurationRanges:
        performance.projectionDuration.productsWithIndependentTestEvidence > 0,
    },
    warnings,
    interpretation: "Field presence and provenance-link coverage measure catalog structure, not the truth of a claim. Customer-facing performance ranges require independently tested, field-matched evidence for both interval bounds.",
  });
}

export function renderFragranceQualityAuditMarkdown(report) {
  if (!report || report.schemaVersion !== 1 || !report.totals || !report.performance) {
    throw new TypeError("report must be a schema-v1 fragrance quality audit");
  }
  const rows = [
    ["Longevity range", report.performance.longevity],
    ["Projection duration range", report.performance.projectionDuration],
    ["Intensity level", report.performance.intensityLevel],
    ["Projection level", report.performance.projectionLevel],
    ["Sillage level", report.performance.sillageLevel],
  ];
  return [
    "# Fragrance library quality audit",
    "",
    "## Evidence and provenance",
    "",
    "- Products: **" + report.totals.products + "**",
    "- Evidence records: **" + report.totals.evidenceRecords + "**",
    "- Distinct source URLs: **" + report.totals.distinctSourceUrls + "**",
    "- Claim fields with valid evidence links: **" + report.totals.claimFieldsWithValidEvidenceLinks + "/" + report.totals.claimFields + "** (" + report.totals.claimFieldLinkCoveragePercent + "%)",
    "- Claim fields with linked evidence not assessed (ledger unavailable): **" + (report.totals.claimFieldsWithEvidenceLinksNotAssessed ?? 0) + "**",
    "- Verified or cross-checked records: **" + report.totals.verifiedOrCrossCheckedRecords + "**",
    "- Reported records: **" + report.totals.reportedRecords + "**",
    "- Malformed evidence links: **" + report.totals.malformedEvidenceLinks + "**",
    "",
    "## Performance readiness",
    "",
    "| Dimension | Products with value/range | With independent-test evidence | Catalog coverage | Independently supported |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows.map(([label, item]) => {
      const present = item.productsWithRange ?? item.productsWithValue;
      return "| " + label + " | " + present + " | " +
        item.productsWithIndependentTestEvidence + " | " +
        item.coveragePercent + "% | " +
        item.independentlySupportedPercent + "% |";
    }),
    "",
    "## Warnings",
    "",
    ...(report.warnings.length ? report.warnings.map(item => "- " + item) : ["- No structural warnings detected."]),
    "",
    "> " + report.interpretation,
    "",
  ].join("\n");
}
