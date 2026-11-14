import { DOMAINS } from "./domains.js";
import { cloneAndFreeze } from "./immutable.js";

export const EVIDENCE_STATUSES = Object.freeze({
  VERIFIED: "verified",
  CROSS_CHECKED: "cross_checked",
  REPORTED: "reported",
  UNCONFIRMED: "unconfirmed",
  NOT_FOUND: "not_found",
  UNAVAILABLE: "unavailable",
});

export const SOURCE_TYPES = Object.freeze({
  OFFICIAL: "official",
  INDEPENDENT_TEST: "independent_test",
  DATABASE: "database",
  DISTRIBUTOR: "distributor",
  COMMUNITY: "community",
  OTHER: "other",
});

const statusValues = new Set(Object.values(EVIDENCE_STATUSES));
const sourceTypes = new Set(Object.values(SOURCE_TYPES));
const domains = new Set(Object.values(DOMAINS));
const terminalWithoutSource = new Set([
  EVIDENCE_STATUSES.NOT_FOUND,
  EVIDENCE_STATUSES.UNAVAILABLE,
]);

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeHttpUrl(value, field) {
  const raw = requireText(value, field);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new TypeError(`${field} must be a valid URL`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError(`${field} must be a public HTTP or HTTPS URL`);
  }
  return parsed.href;
}

function validateSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("source must be an object");
  }
  const name = requireText(source.name, "source.name");
  const url = normalizeHttpUrl(source.url, "source.url");
  if (!sourceTypes.has(source.type)) throw new TypeError("source.type is not supported");

  const normalized = { name, url, type: source.type };
  if (source.references !== undefined) {
    if (!Array.isArray(source.references) || source.references.length > 20) {
      throw new TypeError("source.references must be an array with at most 20 URLs");
    }
    normalized.references = Object.freeze([...new Set(
      source.references.map((reference, index) => normalizeHttpUrl(reference, `source.references[${index}]`))
    )]);
  }
  if (source.license !== undefined) normalized.license = requireText(source.license, "source.license");
  if (source.attribution !== undefined) normalized.attribution = requireText(source.attribution, "source.attribution");
  return Object.freeze(normalized);
}

export function createEvidenceRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Evidence input must be an object");
  }

  const id = requireText(input.id, "id");
  const domain = requireText(input.domain, "domain");
  if (!domains.has(domain)) throw new TypeError("domain is not supported");

  const subjectId = requireText(input.subjectId, "subjectId");
  const field = requireText(input.field, "field");
  if (!statusValues.has(input.status)) throw new TypeError("status is not supported");

  const observedAt = requireText(input.observedAt, "observedAt");
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(observedAt) || Number.isNaN(Date.parse(observedAt))) {
    throw new TypeError("observedAt must be an ISO 8601 date-time");
  }

  const confidence = input.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) ||
      confidence < 0 || confidence > 1) {
    throw new TypeError("confidence must be a number between 0 and 1");
  }

  const source = terminalWithoutSource.has(input.status)
    ? (input.source == null ? null : validateSource(input.source))
    : validateSource(input.source);

  return Object.freeze({
    id,
    domain,
    subjectId,
    field,
    value: input.value == null ? null : cloneAndFreeze(input.value),
    status: input.status,
    confidence,
    source,
    observedAt: new Date(observedAt).toISOString(),
    note: input.note == null ? null : String(input.note),
  });
}
