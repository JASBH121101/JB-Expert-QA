import { createEvidenceRecord, EVIDENCE_STATUSES } from "./evidence.js";

const comparableStatuses = new Set([
  EVIDENCE_STATUSES.VERIFIED,
  EVIDENCE_STATUSES.CROSS_CHECKED,
  EVIDENCE_STATUSES.REPORTED,
  EVIDENCE_STATUSES.UNCONFIRMED,
]);

function canonicalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalValue(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function valueKey(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `string:${value.trim().toLocaleLowerCase()}`;
  return canonicalValue(value);
}

export class EvidenceStore {
  #records = new Map();

  add(input) {
    const record = createEvidenceRecord(input);
    if (this.#records.has(record.id)) {
      throw new Error(`Evidence id already exists: ${record.id}`);
    }
    this.#records.set(record.id, record);
    return record;
  }

  getById(id) {
    return this.#records.get(id) ?? null;
  }

  query({ domain, subjectId, field } = {}) {
    return Object.freeze(
      [...this.#records.values()].filter(record =>
        (domain === undefined || record.domain === domain) &&
        (subjectId === undefined || record.subjectId === subjectId) &&
        (field === undefined || record.field === field)
      )
    );
  }

  conflicts({ domain, subjectId, field }) {
    if (!domain || !subjectId || !field) {
      throw new TypeError("domain, subjectId and field are required to inspect conflicts");
    }
    const records = this.query({ domain, subjectId, field })
      .filter(record => comparableStatuses.has(record.status) && record.value !== null);
    const groups = new Map();

    for (const record of records) {
      const key = valueKey(record.value);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }

    if (groups.size < 2) return Object.freeze([]);
    return Object.freeze([...groups.values()].map(group => Object.freeze([...group])));
  }

  get size() {
    return this.#records.size;
  }

  export() {
    return Object.freeze({
      schemaVersion: 1,
      records: Object.freeze([...this.#records.values()]),
    });
  }

  static fromExport(payload) {
    if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.records)) {
      throw new TypeError("Unsupported evidence export format");
    }
    const store = new EvidenceStore();
    for (const record of payload.records) store.add(record);
    return store;
  }
}
