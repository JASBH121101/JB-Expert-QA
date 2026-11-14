import { EvidenceStore } from "../core/evidence-store.js";
import { DOMAINS } from "../core/domains.js";
import { normalizeFragranceProduct } from "../domains/fragrance/adapter.js";
import { normalizeTechnologyProduct } from "../domains/technology/adapter.js";

export const KNOWLEDGE_SCHEMA_VERSION = 2;
const EVIDENCE_SCHEMA_VERSION = 1;
const CATALOG_SCHEMA_VERSION = 1;

function* iterateProductEvidenceIds(evidenceIds) {
  for (const ids of Object.values(evidenceIds ?? {})) {
    for (const id of ids) yield id;
  }
}
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isoTimestamp(value, field) {
  if (typeof value !== "string") throw new TypeError(`${field} must be an ISO 8601 timestamp`);
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical ISO 8601 timestamp`);
  }
  return value;
}
function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid date");
  return date.toISOString();
}
function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
export function normalizeCatalogProduct(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Catalog product must be an object");
  }
  if (input.domain === DOMAINS.FRAGRANCE) return normalizeFragranceProduct(input);
  if (input.domain === DOMAINS.TECHNOLOGY) return normalizeTechnologyProduct(input);
  throw new TypeError("Catalog product domain is unsupported");
}
export function createEmptyKnowledgeSnapshot({ clock = () => new Date() } = {}) {
  const timestamp = nowIso(clock);
  return freezeDeep({
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    metadata: { createdAt: timestamp, updatedAt: timestamp },
    evidence: { schemaVersion: EVIDENCE_SCHEMA_VERSION, records: [] },
    catalog: { schemaVersion: CATALOG_SCHEMA_VERSION, products: [] },
  });
}
function migrateV0ToV1(snapshot, clock) {
  if (!Array.isArray(snapshot.records)) {
    throw new TypeError("Version 0 knowledge snapshot must contain a records array");
  }
  const fallback = nowIso(clock);
  const createdAt = snapshot.createdAt == null ? fallback : isoTimestamp(snapshot.createdAt, "createdAt");
  const updatedAt = snapshot.updatedAt == null ? createdAt : isoTimestamp(snapshot.updatedAt, "updatedAt");
  return {
    schemaVersion: 1,
    metadata: { createdAt, updatedAt },
    evidence: { schemaVersion: EVIDENCE_SCHEMA_VERSION, records: snapshot.records },
  };
}
function migrateV1ToV2(snapshot) {
  return {
    ...snapshot,
    schemaVersion: 2,
    catalog: { schemaVersion: CATALOG_SCHEMA_VERSION, products: [] },
  };
}
const migrations = new Map([[0, migrateV0ToV1], [1, migrateV1ToV2]]);
export function validateKnowledgeSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) throw new TypeError("Knowledge snapshot must be an object");
  if (snapshot.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) {
    throw new TypeError("Knowledge snapshot has not been migrated to the current schema");
  }
  if (!isPlainObject(snapshot.metadata)) throw new TypeError("Knowledge snapshot metadata is required");
  const createdAt = isoTimestamp(snapshot.metadata.createdAt, "metadata.createdAt");
  const updatedAt = isoTimestamp(snapshot.metadata.updatedAt, "metadata.updatedAt");
  if (!isPlainObject(snapshot.evidence)) throw new TypeError("Knowledge snapshot evidence is required");
  if (!isPlainObject(snapshot.catalog) || snapshot.catalog.schemaVersion !== CATALOG_SCHEMA_VERSION ||
      !Array.isArray(snapshot.catalog.products)) {
    throw new TypeError("Knowledge snapshot catalog is missing or unsupported");
  }
  const ledger = EvidenceStore.fromExport(snapshot.evidence);
  const products = snapshot.catalog.products.map(normalizeCatalogProduct);
  const productIds = new Set();
  for (const product of products) {
    if (productIds.has(product.id)) throw new Error(`Duplicate catalog product ID: ${product.id}`);
    productIds.add(product.id);
    for (const evidenceId of iterateProductEvidenceIds(product.evidenceIds)) {
      if (!ledger.getById(evidenceId)) {
        throw new Error(`Catalog product ${product.id} references missing evidence: ${evidenceId}`);
      }
    }
  }
  return freezeDeep({
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    metadata: { createdAt, updatedAt },
    evidence: ledger.export(),
    catalog: { schemaVersion: CATALOG_SCHEMA_VERSION, products },
  });
}
export function migrateKnowledgeSnapshot(snapshot, { clock = () => new Date() } = {}) {
  if (!isPlainObject(snapshot) || !Number.isInteger(snapshot.schemaVersion)) {
    throw new TypeError("Knowledge snapshot must include an integer schemaVersion");
  }
  if (snapshot.schemaVersion > KNOWLEDGE_SCHEMA_VERSION || snapshot.schemaVersion < 0) {
    throw new TypeError("Unsupported knowledge snapshot version");
  }
  let current = snapshot;
  while (current.schemaVersion < KNOWLEDGE_SCHEMA_VERSION) {
    const migration = migrations.get(current.schemaVersion);
    if (!migration) throw new Error(`Missing migration from knowledge schema ${current.schemaVersion}`);
    current = migration(current, clock);
  }
  return validateKnowledgeSnapshot(current);
}
