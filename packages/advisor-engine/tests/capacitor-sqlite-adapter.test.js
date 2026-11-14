import test from "node:test";
import assert from "node:assert/strict";
import {
  CapacitorSQLiteKnowledgeAdapter,
  CAPACITOR_SQLITE_SCHEMA_VERSION,
} from "../src/knowledge/capacitor-sqlite-adapter.js";
import { KnowledgeStore } from "../src/knowledge/knowledge-store.js";
import { EVIDENCE_STATUSES, SOURCE_TYPES } from "../src/core/evidence.js";

class FakeSQLiteConnection {
  version = 0;
  tableExists = false;
  snapshotJson = null;
  updatedAt = null;
  transaction = null;
  failRun = false;
  failExecute = false;
  inactiveTransaction = false;
  queryError = false;
  integrityResult = "ok";
  commitError = false;

  async query(statement) {
    if (this.queryError) return { message: "simulated query failure", values: [] };
    if (statement.includes("PRAGMA user_version")) {
      return { values: [{ user_version: this.version }] };
    }
    if (statement.includes("sqlite_master")) {
      return { values: this.tableExists ? [{ name: "jbae_knowledge_state" }] : [] };
    }
    if (statement.includes("quick_check")) {
      return { values: [{ quick_check: this.integrityResult }] };
    }
    if (statement.includes("SELECT snapshot_json")) {
      return {
        values: this.snapshotJson === null
          ? []
          : [{ snapshot_json: this.snapshotJson, updated_at: this.updatedAt }],
      };
    }
    throw new Error(`Unexpected query: ${statement}`);
  }

  async execute(statement, transactional = true) {
    if (this.failExecute) throw new Error("simulated DDL failure");
    assert.equal(transactional, false);
    if (statement.includes("CREATE TABLE")) this.tableExists = true;
    if (statement.includes("PRAGMA user_version =")) this.version = 1;
    return { changes: { changes: 0 } };
  }

  async run(statement, values = [], transactional = true) {
    if (this.failRun) throw new Error("simulated disk write failure");
    assert.equal(statement.includes("INSERT INTO jbae_knowledge_state"), true);
    assert.equal(transactional, false);
    this.snapshotJson = values[1];
    this.updatedAt = values[2];
    return { changes: { changes: 1 } };
  }

  async beginTransaction() {
    assert.equal(this.transaction, null);
    this.transaction = {
      version: this.version,
      tableExists: this.tableExists,
      snapshotJson: this.snapshotJson,
      updatedAt: this.updatedAt,
    };
  }

  async isTransactionActive() {
    return !this.inactiveTransaction && this.transaction !== null;
  }

  async commitTransaction() {
    assert.notEqual(this.transaction, null);
    if (this.commitError) return { message: "simulated commit failure" };
    this.transaction = null;
  }

  async rollbackTransaction() {
    assert.notEqual(this.transaction, null);
    Object.assign(this, this.transaction);
    this.transaction = null;
  }
}

const source = {
  name: "Manufacturer",
  url: "https://example.com/device",
  type: SOURCE_TYPES.OFFICIAL,
};
const evidence = (id, value) => ({
  id,
  domain: "technology",
  subjectId: "phone-001",
  field: "storage",
  value,
  status: EVIDENCE_STATUSES.VERIFIED,
  confidence: 0.95,
  source,
  observedAt: "2026-11-07T18:00:00.000Z",
  note: null,
});
const snapshot = (id = "ev-1") => ({
  schemaVersion: 2,
  metadata: {
    createdAt: "2026-11-07T18:00:00.000Z",
    updatedAt: "2026-11-07T18:05:00.000Z",
  },
  evidence: {
    schemaVersion: 1,
    records: [evidence(id, "256 GB")],
  },
  catalog: { schemaVersion: 1, products: [] },
});

test("initializes a versioned SQLite schema in one transaction", async () => {
  const db = new FakeSQLiteConnection();
  const adapter = new CapacitorSQLiteKnowledgeAdapter({ db });
  await adapter.initialize();
  assert.equal(db.version, CAPACITOR_SQLITE_SCHEMA_VERSION);
  assert.equal(db.tableExists, true);
  assert.equal(db.transaction, null);
});

test("reads an empty SQLite knowledge table as null", async () => {
  const db = new FakeSQLiteConnection();
  const adapter = new CapacitorSQLiteKnowledgeAdapter({ db });
  assert.equal(await adapter.readSnapshot(), null);
});

test("writes and reads a full validated snapshot using bound parameters", async () => {
  const db = new FakeSQLiteConnection();
  const adapter = new CapacitorSQLiteKnowledgeAdapter({ db });
  const expected = snapshot();
  await adapter.writeSnapshot(expected);
  assert.deepEqual(await adapter.readSnapshot(), expected);
  assert.equal(db.transaction, null);
});

test("stores KnowledgeStore records durably and restores them on reopen", async () => {
  const db = new FakeSQLiteConnection();
  const adapterOne = new CapacitorSQLiteKnowledgeAdapter({ db });
  const first = await KnowledgeStore.open({ adapter: adapterOne });
  await first.addEvidence(evidence("device-fact", "512 GB"));

  const adapterTwo = new CapacitorSQLiteKnowledgeAdapter({ db });
  const reopened = await KnowledgeStore.open({ adapter: adapterTwo });
  assert.equal(reopened.queryEvidence()[0].id, "device-fact");
  assert.equal(reopened.queryEvidence()[0].value, "512 GB");
});

test("rolls back a failed snapshot write and preserves previous committed data", async () => {
  const db = new FakeSQLiteConnection();
  const adapter = new CapacitorSQLiteKnowledgeAdapter({ db });
  const original = snapshot();
  await adapter.writeSnapshot(original);
  db.failRun = true;

  await assert.rejects(() => adapter.writeSnapshot(snapshot("uncommitted")), /simulated disk write failure/);
  db.failRun = false;
  assert.deepEqual(await adapter.readSnapshot(), original);
  assert.equal(db.transaction, null);
});

test("rolls back a commit failure", async () => {
  const db = new FakeSQLiteConnection();
  const adapter = new CapacitorSQLiteKnowledgeAdapter({ db });
  const original = snapshot();
  await adapter.writeSnapshot(original);
  db.commitError = true;

  await assert.rejects(() => adapter.writeSnapshot(snapshot("not-committed")), /simulated commit failure/);
  db.commitError = false;
  assert.deepEqual(await adapter.readSnapshot(), original);
  assert.equal(db.transaction, null);
});

test("rolls back failed schema migrations and safely retries initialization", async () => {
  const db = new FakeSQLiteConnection();
  db.failExecute = true;
  const adapter = new CapacitorSQLiteKnowledgeAdapter({ db });
  await assert.rejects(() => adapter.initialize(), /simulated DDL failure/);
  assert.equal(db.version, 0);
  assert.equal(db.tableExists, false);
  assert.equal(db.transaction, null);

  db.failExecute = false;
  await adapter.initialize();
  assert.equal(db.version, 1);
  assert.equal(db.tableExists, true);
});

test("rejects databases created by a newer incompatible schema", async () => {
  const db = new FakeSQLiteConnection();
  db.version = CAPACITOR_SQLITE_SCHEMA_VERSION + 1;
  const adapter = new CapacitorSQLiteKnowledgeAdapter({ db });
  await assert.rejects(() => adapter.initialize(), /newer than supported/);
});

test("detects a missing state table when user_version claims it exists", async () => {
  const db = new FakeSQLiteConnection();
  db.version = CAPACITOR_SQLITE_SCHEMA_VERSION;
  const adapter = new CapacitorSQLiteKnowledgeAdapter({ db });
  await assert.rejects(() => adapter.initialize(), /state table is missing/);
});

test("rejects malformed JSON already present in SQLite", async () => {
  const db = new FakeSQLiteConnection();
  const adapter = new CapacitorSQLiteKnowledgeAdapter({ db });
  await adapter.initialize();
  db.snapshotJson = "{invalid-json";
  await assert.rejects(() => adapter.readSnapshot(), /invalid JSON/);
});

test("fails closed when the SQLite plugin returns an error result", async () => {
  const db = new FakeSQLiteConnection();
  db.queryError = true;
  const adapter = new CapacitorSQLiteKnowledgeAdapter({ db });
  await assert.rejects(() => adapter.initialize(), /simulated query failure/);
});

test("rejects a transaction that did not become active", async () => {
  const db = new FakeSQLiteConnection();
  db.inactiveTransaction = true;
  const adapter = new CapacitorSQLiteKnowledgeAdapter({ db });
  await assert.rejects(() => adapter.initialize(), /did not become active/);
  assert.equal(db.transaction, null);
});

test("rejects a failed SQLite quick integrity check", async () => {
  const db = new FakeSQLiteConnection();
  db.integrityResult = "database disk image is malformed";
  const adapter = new CapacitorSQLiteKnowledgeAdapter({ db });
  await assert.rejects(() => adapter.initialize(), /integrity check failed/);
});

test("serializes concurrent durable writes", async () => {
  const db = new FakeSQLiteConnection();
  const adapter = new CapacitorSQLiteKnowledgeAdapter({ db });
  await Promise.all([
    adapter.writeSnapshot(snapshot("first")),
    adapter.writeSnapshot(snapshot("second")),
  ]);
  assert.equal((await adapter.readSnapshot()).evidence.records[0].id, "second");
  assert.equal(db.transaction, null);
});

test("validates the Capacitor SQLite connection contract", () => {
  assert.throws(
    () => new CapacitorSQLiteKnowledgeAdapter({ db: {} }),
    /missing methods/,
  );
});
