import { validateKnowledgeSnapshot } from "./migrations.js";

const SQLITE_SCHEMA_VERSION = 1;
const STATE_TABLE = "jbae_knowledge_state";

const CREATE_STATE_TABLE = `
CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  snapshot_json TEXT NOT NULL CHECK (length(snapshot_json) > 1),
  updated_at TEXT NOT NULL
);
`;

const SELECT_SNAPSHOT = `
SELECT snapshot_json
FROM ${STATE_TABLE}
WHERE singleton = 1;
`;

const UPSERT_SNAPSHOT = `
INSERT INTO ${STATE_TABLE} (singleton, snapshot_json, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(singleton) DO UPDATE SET
  snapshot_json = excluded.snapshot_json,
  updated_at = excluded.updated_at;
`;

function assertDatabaseConnection(db) {
  const required = [
    "execute",
    "run",
    "query",
    "beginTransaction",
    "commitTransaction",
    "rollbackTransaction",
    "isTransactionActive",
  ];
  const missing = required.filter(method => typeof db?.[method] !== "function");
  if (missing.length > 0) {
    throw new TypeError(
      `Capacitor SQLite connection is missing methods: ${missing.join(", ")}`,
    );
  }
}

function assertPluginResult(result, operation) {
  if (result?.message) {
    throw new Error(`SQLite ${operation} failed: ${result.message}`);
  }
  if (result?.changes?.changes === -1) {
    throw new Error(`SQLite ${operation} failed: statement was not applied`);
  }
  return result;
}

function rowsFromResult(result, operation) {
  assertPluginResult(result, operation);
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.values)) return result.values;
  throw new TypeError(`SQLite ${operation} returned an unsupported result shape`);
}

function readUserVersion(result) {
  const rows = rowsFromResult(result, "schema version query");
  const version = Number(rows[0]?.user_version);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("SQLite PRAGMA user_version returned an invalid value");
  }
  return version;
}

function assertQuickCheck(result) {
  const rows = rowsFromResult(result, "integrity check");
  const resultValue = rows[0]?.quick_check;
  if (resultValue !== "ok") {
    throw new Error(`SQLite integrity check failed: ${String(resultValue ?? "no result")}`);
  }
}

/**
 * Durable adapter for @capacitor-community/sqlite SQLiteDBConnection.
 *
 * The connection must already be created and opened by the application.
 * This module deliberately has no direct Capacitor import so the engine
 * remains testable in Node and reusable outside the Android shell.
 */
export class CapacitorSQLiteKnowledgeAdapter {
  #db;
  #initialized = null;
  #writeQueue = Promise.resolve();

  constructor({ db } = {}) {
    assertDatabaseConnection(db);
    this.#db = db;
  }

  async #transaction(operation) {
    let began = false;
    try {
      assertPluginResult(await this.#db.beginTransaction(), "begin transaction");
      began = true;
      const activeResult = await this.#db.isTransactionActive();
      const isActive = typeof activeResult === "boolean"
        ? activeResult
        : activeResult?.result;
      if (isActive !== true) {
        throw new Error("SQLite transaction did not become active");
      }

      const result = await operation();
      assertPluginResult(await this.#db.commitTransaction(), "commit transaction");
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          assertPluginResult(await this.#db.rollbackTransaction(), "rollback transaction");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "SQLite transaction failed and rollback also failed",
            { cause: error },
          );
        }
      }
      throw error;
    }
  }

  async initialize() {
    if (!this.#initialized) {
      this.#initialized = this.#initialize().catch(error => {
        this.#initialized = null;
        throw error;
      });
    }
    return this.#initialized;
  }

  async #initialize() {
    const result = await this.#db.query("PRAGMA user_version;");
    const currentVersion = readUserVersion(result);
    if (currentVersion > SQLITE_SCHEMA_VERSION) {
      throw new Error(
        `SQLite schema version ${currentVersion} is newer than supported version ${SQLITE_SCHEMA_VERSION}`,
      );
    }

    if (currentVersion < 1) {
      await this.#transaction(async () => {
        assertPluginResult(
          await this.#db.execute(CREATE_STATE_TABLE, false),
          "schema creation",
        );
        assertPluginResult(
          await this.#db.execute("PRAGMA user_version = 1;", false),
          "schema version update",
        );
      });
    } else {
      const tables = rowsFromResult(
        await this.#db.query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;",
          [STATE_TABLE],
        ),
        "schema integrity query",
      );
      if (tables.length === 0) {
        throw new Error("SQLite schema is marked current but the JBAE state table is missing");
      }
    }

    assertQuickCheck(await this.#db.query("PRAGMA quick_check(1);"));
  }

  async readSnapshot() {
    await this.initialize();
    const rows = rowsFromResult(
      await this.#db.query(SELECT_SNAPSHOT),
      "knowledge snapshot query",
    );
    const row = rows[0];
    if (!row) return null;
    if (typeof row.snapshot_json !== "string" || !row.snapshot_json.trim()) {
      throw new Error("SQLite knowledge snapshot is empty or malformed");
    }
    try {
      return JSON.parse(row.snapshot_json);
    } catch (error) {
      throw new Error("SQLite knowledge snapshot contains invalid JSON", { cause: error });
    }
  }

  writeSnapshot(snapshot) {
    const operation = async () => {
      await this.initialize();
      const validated = validateKnowledgeSnapshot(snapshot);
      const json = JSON.stringify(validated);
      const updatedAt = validated.metadata.updatedAt;

      await this.#transaction(async () => {
        assertPluginResult(
          await this.#db.run(
            UPSERT_SNAPSHOT,
            [1, json, updatedAt],
            false,
          ),
          "snapshot write",
        );
      });
    };

    const result = this.#writeQueue.then(operation);
    this.#writeQueue = result.catch(() => undefined);
    return result;
  }
}

export const CAPACITOR_SQLITE_SCHEMA_VERSION = SQLITE_SCHEMA_VERSION;
