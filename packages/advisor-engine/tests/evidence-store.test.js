import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceStore } from "../src/core/evidence-store.js";
import { EVIDENCE_STATUSES, SOURCE_TYPES } from "../src/core/evidence.js";

const source = { name: "Official source", url: "https://example.com/item", type: SOURCE_TYPES.OFFICIAL };
const record = (id, value, status = EVIDENCE_STATUSES.CROSS_CHECKED) => ({
  id, domain: "technology", subjectId: "phone-001", field: "storage",
  value, status, confidence: 0.9, source, observedAt: "2026-11-07T17:00:00.000Z",
});

test("ledger is append-only and rejects duplicate evidence IDs", () => {
  const store = new EvidenceStore();
  store.add(record("ev-1", "256 GB"));
  assert.equal(store.size, 1);
  assert.throws(() => store.add(record("ev-1", "512 GB")), /already exists/);
  assert.equal(store.size, 1);
});

test("query filters by domain, subject and field", () => {
  const store = new EvidenceStore();
  store.add(record("ev-1", "256 GB"));
  store.add({ ...record("ev-2", "8 GB"), field: "ram" });
  assert.equal(store.query({ subjectId: "phone-001" }).length, 2);
  assert.equal(store.query({ field: "storage" }).length, 1);
  assert.equal(store.query({ domain: "fragrance" }).length, 0);
});

test("conflict detection groups contradictory claims without choosing a winner", () => {
  const store = new EvidenceStore();
  store.add(record("ev-1", "256 GB"));
  store.add(record("ev-2", "512 GB"));
  const conflicts = store.conflicts({ domain: "technology", subjectId: "phone-001", field: "storage" });
  assert.equal(conflicts.length, 2);
  assert.deepEqual(conflicts.map(group => group[0].value).sort(), ["256 GB", "512 GB"]);
});

test("export and import preserve records and reject duplicate IDs", () => {
  const store = new EvidenceStore();
  store.add(record("ev-1", "256 GB"));
  const restored = EvidenceStore.fromExport(store.export());
  assert.equal(restored.size, 1);
  assert.equal(restored.getById("ev-1").value, "256 GB");
  assert.throws(() => EvidenceStore.fromExport({ schemaVersion: 2, records: [] }), /Unsupported/);
});

test("matching claims are not reported as conflicts", () => {
  const store = new EvidenceStore();
  store.add(record("ev-1", "256 GB"));
  store.add(record("ev-2", "256 gb"));
  assert.deepEqual(store.conflicts({
    domain: "technology", subjectId: "phone-001", field: "storage",
  }), []);
});

test("object-valued claims compare independently of property insertion order", () => {
  const store = new EvidenceStore();
  store.add(record("ev-object-a", { ram: 8, storage: 256 }));
  store.add(record("ev-object-b", { storage: 256, ram: 8 }));
  assert.deepEqual(store.conflicts({
    domain: "technology", subjectId: "phone-001", field: "storage",
  }), []);
  store.add(record("ev-object-c", { ram: 12, storage: 512 }));
  assert.equal(store.conflicts({
    domain: "technology", subjectId: "phone-001", field: "storage",
  }).length, 2);
});
