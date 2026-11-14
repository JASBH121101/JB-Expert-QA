import { EvidenceStore } from "../core/evidence-store.js";
import { DOMAINS } from "../core/domains.js";
import { CatalogIndex } from "./catalog-index.js";
import {
  createEmptyKnowledgeSnapshot,
  migrateKnowledgeSnapshot,
  normalizeCatalogProduct,
  validateKnowledgeSnapshot,
} from "./migrations.js";

const BACKUP_FORMAT = "jbae-knowledge-backup";
const BACKUP_VERSION = 1;
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function* iterateProductEvidenceIds(evidenceIds) {
  for (const ids of Object.values(evidenceIds ?? {})) {
    for (const id of ids) yield id;
  }
}


function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid date");
  return date.toISOString();
}
function assertAdapter(adapter) {
  if (!adapter || typeof adapter.readSnapshot !== "function" ||
      typeof adapter.writeSnapshot !== "function") {
    throw new TypeError("adapter must implement readSnapshot() and writeSnapshot()");
  }
}
function decodeBackup(backup, clock) {
  if (!backup || backup.format !== BACKUP_FORMAT || backup.backupVersion !== BACKUP_VERSION) {
    throw new TypeError("Unsupported JBAE knowledge backup format");
  }
  if (typeof backup.exportedAt !== "string" || Number.isNaN(Date.parse(backup.exportedAt))) {
    throw new TypeError("Backup exportedAt must be a valid timestamp");
  }
  return migrateKnowledgeSnapshot(backup.snapshot, { clock });
}
function summarizeImport(current, incoming) {
  const currentStore = EvidenceStore.fromExport(current.evidence);
  const incomingStore = EvidenceStore.fromExport(incoming.evidence);
  const newIds = [], duplicateIds = [], conflictingIds = [];
  for (const record of incomingStore.query()) {
    const existing = currentStore.getById(record.id);
    if (!existing) newIds.push(record.id);
    else if (JSON.stringify(existing) === JSON.stringify(record)) duplicateIds.push(record.id);
    else conflictingIds.push(record.id);
  }
  const currentProducts = new Map(current.catalog.products.map(product => [product.id, product]));
  const newProductIds = [], duplicateProductIds = [], conflictingProductIds = [];
  for (const product of incoming.catalog.products) {
    const existing = currentProducts.get(product.id);
    if (!existing) newProductIds.push(product.id);
    else if (JSON.stringify(existing) === JSON.stringify(product)) duplicateProductIds.push(product.id);
    else conflictingProductIds.push(product.id);
  }
  return freezeDeep({
    canImport: conflictingIds.length === 0 && conflictingProductIds.length === 0,
    newRecordCount: newIds.length,
    duplicateRecordCount: duplicateIds.length,
    conflictingRecordIds: conflictingIds,
    newRecordIds: newIds,
    duplicateRecordIds: duplicateIds,
    newProductCount: newProductIds.length,
    duplicateProductCount: duplicateProductIds.length,
    conflictingProductIds,
    newProductIds,
    duplicateProductIds,
  });
}

/** Test/reference adapter. Production adapters must make writes atomic. */
export class MemoryKnowledgeAdapter {
  #snapshot = null;
  async readSnapshot() { return this.#snapshot === null ? null : cloneJson(this.#snapshot); }
  async writeSnapshot(snapshot) { this.#snapshot = cloneJson(snapshot); }
}
export class KnowledgeStore {
  #adapter;
  #clock;
  #snapshot;
  #queue = Promise.resolve();

  constructor(adapter, snapshot, clock) {
    this.#adapter = adapter;
    this.#snapshot = validateKnowledgeSnapshot(snapshot);
    this.#clock = clock;
  }
  static async open({ adapter, clock = () => new Date() } = {}) {
    assertAdapter(adapter);
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    const stored = await adapter.readSnapshot();
    const snapshot = stored == null
      ? createEmptyKnowledgeSnapshot({ clock })
      : migrateKnowledgeSnapshot(stored, { clock });
    if (stored == null || stored.schemaVersion !== snapshot.schemaVersion) {
      await adapter.writeSnapshot(snapshot);
    }
    return new KnowledgeStore(adapter, snapshot, clock);
  }
  #exclusive(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }
  async #commit(snapshot) {
    const validated = validateKnowledgeSnapshot(snapshot);
    await this.#adapter.writeSnapshot(validated);
    this.#snapshot = validated;
    return validated;
  }
  getSnapshot() { return this.#snapshot; }
  getEvidenceStore() { return EvidenceStore.fromExport(this.#snapshot.evidence); }
  queryEvidence(filters = {}) { return this.getEvidenceStore().query(filters); }
  conflicts(filters) { return this.getEvidenceStore().conflicts(filters); }
  getProducts({ domain } = {}) {
    if (domain !== undefined && !Object.values(DOMAINS).includes(domain)) {
      throw new TypeError("Unsupported catalog domain filter");
    }
    return Object.freeze(this.#snapshot.catalog.products.filter(product =>
      domain === undefined || product.domain === domain));
  }
  searchProducts(options = {}) {
    return new CatalogIndex(this.#snapshot.catalog.products).search(options);
  }
  findProductMatches(product, options = {}) {
    return new CatalogIndex(this.#snapshot.catalog.products).findMatches(product, options);
  }
  findPotentialDuplicateProducts() {
    return new CatalogIndex(this.#snapshot.catalog.products).findPotentialDuplicates();
  }
  addEvidence(input) {
    return this.#exclusive(async () => {
      const ledger = this.getEvidenceStore();
      const record = ledger.add(input);
      await this.#commit({
        ...this.#snapshot,
        metadata: { ...this.#snapshot.metadata, updatedAt: nowIso(this.#clock) },
        evidence: ledger.export(),
      });
      return record;
    });
  }
  addProduct(input) {
    return this.#exclusive(async () => {
      const product = normalizeCatalogProduct(input);
      if (this.#snapshot.catalog.products.some(existing => existing.id === product.id)) {
        throw new Error(`Catalog product ID already exists: ${product.id}`);
      }
      const ledger = this.getEvidenceStore();
      for (const evidenceId of iterateProductEvidenceIds(product.evidenceIds)) {
        if (!ledger.getById(evidenceId)) {
          throw new Error(`Catalog product references missing evidence: ${evidenceId}`);
        }
      }
      const products = [...this.#snapshot.catalog.products, product];
      await this.#commit({
        ...this.#snapshot,
        metadata: { ...this.#snapshot.metadata, updatedAt: nowIso(this.#clock) },
        catalog: { schemaVersion: 1, products },
      });
      return product;
    });
  }
  exportBackup() {
    return freezeDeep({
      format: BACKUP_FORMAT,
      backupVersion: BACKUP_VERSION,
      exportedAt: nowIso(this.#clock),
      snapshot: this.#snapshot,
    });
  }
  previewImport(backup) {
    return this.#exclusive(async () => summarizeImport(this.#snapshot, decodeBackup(backup, this.#clock)));
  }
  importBackup(backup) {
    return this.#exclusive(async () => {
      const incoming = decodeBackup(backup, this.#clock);
      const summary = summarizeImport(this.#snapshot, incoming);
      if (!summary.canImport) {
        const ids = [...summary.conflictingRecordIds, ...summary.conflictingProductIds];
        throw new Error(`Backup contains ID collisions: ${ids.join(", ")}`);
      }
      if (summary.newRecordCount === 0 && summary.newProductCount === 0) return summary;
      const ledger = this.getEvidenceStore();
      const imported = EvidenceStore.fromExport(incoming.evidence);
      for (const id of summary.newRecordIds) ledger.add(imported.getById(id));
      const products = [...this.#snapshot.catalog.products,
        ...incoming.catalog.products.filter(product => summary.newProductIds.includes(product.id))];
      await this.#commit({
        ...this.#snapshot,
        metadata: { ...this.#snapshot.metadata, updatedAt: nowIso(this.#clock) },
        evidence: ledger.export(),
        catalog: { schemaVersion: 1, products },
      });
      return summary;
    });
  }
}
