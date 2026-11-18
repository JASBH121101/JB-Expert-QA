const REVISION_ANCHOR_SCHEMA = "jb.resilience.a2-revision-anchor/v1";
const REVISION_ANCHOR_TABLE = "public.jb_resilience_a2_revision_anchors";
const LEDGER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function assertAnchorPool(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("PostgreSQL A2 revision anchor requires a node-postgres-compatible Pool");
  }
}

function assertLedgerId(value) {
  if (typeof value !== "string" || !LEDGER_ID_PATTERN.test(value)) {
    throw new TypeError("A2 revision-anchor ledgerId is invalid");
  }
  return value;
}

function exactObjectKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be a plain data object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(label + " must be a plain data object");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(label + " must not contain symbol properties");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new TypeError(label + " has missing or unsupported fields");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " must not contain accessors or hidden values");
    }
  }
}

function normalizeAnchorState(value, label = "A2 revision-anchor state") {
  exactObjectKeys(value, ["schema", "revision", "ledgerSha256"], label);
  if (value.schema !== REVISION_ANCHOR_SCHEMA ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.ledgerSha256 !== "string" || !SHA256_PATTERN.test(value.ledgerSha256)) {
    throw new TypeError(label + " is malformed");
  }
  return Object.freeze({
    schema: REVISION_ANCHOR_SCHEMA,
    revision: value.revision,
    ledgerSha256: value.ledgerSha256
  });
}

function databaseInteger(value, label) {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(label + " returned an invalid PostgreSQL integer");
  }
  return result;
}

/**
 * PostgreSQL-backed atomic monotonic revision anchor for a local A2 file ledger.
 *
 * Inject a Pool from a separately administered PostgreSQL failure domain.
 * A second Pool against the same primary tests atomic CAS only; it does not
 * protect against coordinated restoration of that database cluster.
 */
export function createPostgresA2RevisionAnchor({
  pool,
  connectionTimeoutMs = 3_000,
  statementTimeoutMs = 4_000,
  lockTimeoutMs = 1_500,
  idleInTransactionTimeoutMs = 10_000
} = {}) {
  assertAnchorPool(pool);
  for (const [name, value, minimum, maximum] of [
    ["connectionTimeoutMs", connectionTimeoutMs, 100, 60_000],
    ["statementTimeoutMs", statementTimeoutMs, 100, 60_000],
    ["lockTimeoutMs", lockTimeoutMs, 50, 30_000],
    ["idleInTransactionTimeoutMs", idleInTransactionTimeoutMs, 100, 120_000]
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new TypeError("A2 PostgreSQL revision-anchor " + name + " is invalid");
    }
  }

  let initialized = false;

  function assertInitialized() {
    if (!initialized) throw new Error("PostgreSQL A2 revision anchor is not initialized");
  }

  async function acquireClient() {
    const pending = Promise.resolve().then(() => pool.connect());
    let timer;
    try {
      const client = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("A2 PostgreSQL revision-anchor Pool connection wait timed out"));
          }, connectionTimeoutMs);
        })
      ]);
      clearTimeout(timer);
      return client;
    } catch (error) {
      clearTimeout(timer);
      // Pool.connect() is not AbortSignal-aware. Release a client that arrives
      // after the bounded connection wait has already failed.
      pending.then((client) => client.release()).catch(() => {});
      throw error;
    }
  }

  async function transaction(operation) {
    const client = await acquireClient();
    let began = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      began = true;
      await client.query(
        "SELECT set_config('statement_timeout',$1,true), " +
        "set_config('lock_timeout',$2,true), " +
        "set_config('idle_in_transaction_session_timeout',$3,true)",
        [
          String(statementTimeoutMs) + "ms",
          String(lockTimeoutMs) + "ms",
          String(idleInTransactionTimeoutMs) + "ms"
        ]
      );
      const result = await operation(client);
      await client.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function validateSchema(client) {
    const columns = await client.query(
      "SELECT column_name, data_type, is_nullable, character_maximum_length " +
      "FROM information_schema.columns " +
      "WHERE table_schema='public' AND table_name='jb_resilience_a2_revision_anchors' " +
      "ORDER BY ordinal_position"
    );
    const expected = [
      ["ledger_id", "text", "NO", null],
      ["state_schema", "text", "NO", null],
      ["revision", "bigint", "NO", null],
      ["ledger_sha256", "character", "NO", 64],
      ["updated_at", "timestamp with time zone", "NO", null]
    ];
    if (columns.rowCount !== expected.length) {
      throw new Error("A2 PostgreSQL revision-anchor table has an incompatible column set");
    }
    for (let index = 0; index < expected.length; index += 1) {
      const actual = columns.rows[index];
      const wanted = expected[index];
      const characterLength = actual.character_maximum_length === null
        ? null : Number(actual.character_maximum_length);
      if (actual.column_name !== wanted[0] ||
          actual.data_type !== wanted[1] ||
          actual.is_nullable !== wanted[2] ||
          characterLength !== wanted[3]) {
        throw new Error("A2 PostgreSQL revision-anchor column is incompatible: " + wanted[0]);
      }
    }

    const constraintResult = await client.query(
      "SELECT conname, contype, convalidated, pg_get_constraintdef(oid) AS definition " +
      "FROM pg_constraint WHERE conrelid=$1::regclass",
      [REVISION_ANCHOR_TABLE]
    );
    const constraints = new Map(constraintResult.rows.map((row) => [row.conname, row]));
    const required = [
      ["jb_resilience_a2_anchor_pk", "p", "ledger_id"],
      ["jb_resilience_a2_anchor_ledger_id_check", "c", "ledger_id"],
      ["jb_resilience_a2_anchor_schema_check", "c", "state_schema"],
      ["jb_resilience_a2_anchor_revision_check", "c", "revision"],
      ["jb_resilience_a2_anchor_digest_check", "c", "ledger_sha256"]
    ];
    for (const [name, type, fragment] of required) {
      const row = constraints.get(name);
      if (!row || row.contype !== type || row.convalidated !== true ||
          typeof row.definition !== "string" ||
          !row.definition.toLowerCase().includes(fragment)) {
        throw new Error("A2 PostgreSQL revision-anchor constraint is missing or incompatible: " + name);
      }
    }

    const primaryKey = constraints.get("jb_resilience_a2_anchor_pk").definition
      .toLowerCase().replaceAll('"', "").replace(/\s+/g, "");
    if (!primaryKey.includes("primarykey(ledger_id)")) {
      throw new Error("A2 PostgreSQL revision-anchor primary key must bind ledger_id");
    }
    const schemaDefinition = constraints.get("jb_resilience_a2_anchor_schema_check").definition;
    if (!schemaDefinition.includes(REVISION_ANCHOR_SCHEMA)) {
      throw new Error("A2 PostgreSQL revision-anchor schema constraint is incompatible");
    }
    const revisionDefinition = constraints.get("jb_resilience_a2_anchor_revision_check").definition
      .toLowerCase().replace(/\s+/g, "");
    if (!revisionDefinition.includes("revision>=0")) {
      throw new Error("A2 PostgreSQL revision-anchor revision constraint is incompatible");
    }
    const digestDefinition = constraints.get("jb_resilience_a2_anchor_digest_check").definition
      .toLowerCase().replace(/\s+/g, "");
    if (!digestDefinition.includes("[a-f0-9]{64}")) {
      throw new Error("A2 PostgreSQL revision-anchor digest constraint is incompatible");
    }

    const triggerResult = await client.query(
      "SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition " +
      "FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal",
      [REVISION_ANCHOR_TABLE]
    );
    const trigger = triggerResult.rows.find(
      (row) => row.tgname === "jb_resilience_a2_anchor_immutable_trigger"
    );
    const triggerDefinition = trigger?.definition?.toLowerCase() ?? "";
    if (!trigger || trigger.tgenabled !== "O" ||
        !triggerDefinition.includes("before") ||
        !triggerDefinition.includes("insert") ||
        !triggerDefinition.includes("update") ||
        !triggerDefinition.includes("delete") ||
        !triggerDefinition.includes("jb_resilience_a2_anchor_guard_mutation")) {
      throw new Error("A2 PostgreSQL revision-anchor monotonic tombstone trigger is missing or disabled");
    }
  }

  async function initialize() {
    await transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["jb-resilience-a2-revision-anchor-schema-v1"]
      );
      await client.query(
        "CREATE TABLE IF NOT EXISTS " + REVISION_ANCHOR_TABLE + " (" +
        "ledger_id TEXT NOT NULL," +
        "state_schema TEXT NOT NULL," +
        "revision BIGINT NOT NULL," +
        "ledger_sha256 CHAR(64) NOT NULL," +
        "updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()," +
        "CONSTRAINT jb_resilience_a2_anchor_pk PRIMARY KEY (ledger_id)," +
        "CONSTRAINT jb_resilience_a2_anchor_ledger_id_check " +
        "CHECK (ledger_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$')," +
        "CONSTRAINT jb_resilience_a2_anchor_schema_check " +
        "CHECK (state_schema = '" + REVISION_ANCHOR_SCHEMA + "')," +
        "CONSTRAINT jb_resilience_a2_anchor_revision_check CHECK (revision >= 0)," +
        "CONSTRAINT jb_resilience_a2_anchor_digest_check " +
        "CHECK (ledger_sha256 ~ '^[a-f0-9]{64}$')" +
        ")"
      );
      await client.query(
        "CREATE OR REPLACE FUNCTION public.jb_resilience_a2_anchor_guard_mutation() " +
        "RETURNS trigger LANGUAGE plpgsql AS $a2anchor$ BEGIN " +
        "IF TG_OP = 'DELETE' THEN " +
        "RAISE EXCEPTION 'A2 external revision anchors are permanent tombstones'; " +
        "ELSIF TG_OP = 'INSERT' THEN " +
        "IF NEW.revision <> 0 THEN " +
        "RAISE EXCEPTION 'A2 external revision anchors must start at revision zero'; " +
        "END IF; " +
        "ELSE " +
        "IF NEW.ledger_id <> OLD.ledger_id OR NEW.state_schema <> OLD.state_schema OR " +
        "NEW.revision <> OLD.revision + 1 THEN " +
        "RAISE EXCEPTION 'A2 external revision anchor updates must advance exactly one revision'; " +
        "END IF; " +
        "END IF; RETURN NEW; END; $a2anchor$"
      );
      await client.query(
        "DO $a2anchor$ BEGIN " +
        "IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='" + REVISION_ANCHOR_TABLE + "'::regclass " +
        "AND tgname='jb_resilience_a2_anchor_immutable_trigger' AND NOT tgisinternal) THEN " +
        "CREATE TRIGGER jb_resilience_a2_anchor_immutable_trigger " +
        "BEFORE INSERT OR UPDATE OR DELETE ON " + REVISION_ANCHOR_TABLE + " " +
        "FOR EACH ROW EXECUTE FUNCTION public.jb_resilience_a2_anchor_guard_mutation(); " +
        "END IF; END; $a2anchor$"
      );
      await validateSchema(client);
    });
    initialized = true;
    return Object.freeze({
      initialized: true,
      dialect: "postgresql",
      schemaVersion: 1,
      table: REVISION_ANCHOR_TABLE
    });
  }

  async function verify() {
    await transaction(async (client) => {
      await validateSchema(client);
    });
    initialized = true;
    return Object.freeze({
      verified: true,
      dialect: "postgresql",
      schemaVersion: 1,
      table: REVISION_ANCHOR_TABLE
    });
  }

  async function read(input) {
    exactObjectKeys(input, ["ledgerId"], "A2 PostgreSQL revision-anchor read input");
    const ledgerId = assertLedgerId(input.ledgerId);
    assertInitialized();
    return transaction(async (client) => {
      const result = await client.query(
        "SELECT state_schema, revision, ledger_sha256 " +
        "FROM " + REVISION_ANCHOR_TABLE + " WHERE ledger_id=$1",
        [ledgerId]
      );
      if (result.rowCount === 0) return null;
      if (result.rowCount !== 1) {
        throw new Error("A2 PostgreSQL revision-anchor exact read returned an invalid row count");
      }
      const row = result.rows[0];
      return normalizeAnchorState({
        schema: row.state_schema,
        revision: databaseInteger(row.revision, "A2 revision-anchor revision"),
        ledgerSha256: String(row.ledger_sha256).trim()
      }, "A2 PostgreSQL revision-anchor database state");
    });
  }

  async function compareAndSwap(input) {
    exactObjectKeys(input, ["ledgerId", "expected", "next"], "A2 PostgreSQL revision-anchor CAS input");
    const ledgerId = assertLedgerId(input.ledgerId);
    const expected = input.expected === null
      ? null : normalizeAnchorState(input.expected, "A2 revision-anchor expected state");
    const next = normalizeAnchorState(input.next, "A2 revision-anchor next state");
    if (expected === null) {
      if (next.revision !== 0) {
        throw new TypeError("A2 revision-anchor initialization must start at revision zero");
      }
    } else if (expected.revision >= Number.MAX_SAFE_INTEGER ||
        next.revision !== expected.revision + 1) {
      throw new TypeError("A2 revision-anchor CAS must advance exactly one revision");
    }

    assertInitialized();
    return transaction(async (client) => {
      if (expected === null) {
        const inserted = await client.query(
          "INSERT INTO " + REVISION_ANCHOR_TABLE +
          " (ledger_id, state_schema, revision, ledger_sha256, updated_at) " +
          "VALUES ($1,$2,$3,$4,clock_timestamp()) " +
          "ON CONFLICT (ledger_id) DO NOTHING RETURNING ledger_id",
          [ledgerId, next.schema, next.revision, next.ledgerSha256]
        );
        return inserted.rowCount === 1;
      }

      const updated = await client.query(
        "UPDATE " + REVISION_ANCHOR_TABLE +
        " SET state_schema=$5, revision=$6, ledger_sha256=$7, updated_at=clock_timestamp() " +
        "WHERE ledger_id=$1 AND state_schema=$2 AND revision=$3 AND ledger_sha256=$4 " +
        "RETURNING ledger_id",
        [ledgerId, expected.schema, expected.revision, expected.ledgerSha256,
          next.schema, next.revision, next.ledgerSha256]
      );
      return updated.rowCount === 1;
    });
  }

  return Object.freeze({
    durable: true,
    atomicCompareAndSwap: true,
    dialect: "postgresql",
    initialize,
    verify,
    read,
    compareAndSwap
  });
}
