import test from "node:test";
import assert from "node:assert/strict";
import { auditPostgresDatabase } from "../src/adapters/database/postgres.js";

function fixtureClient({
  readOnly = "on",
  metadata = [{
    database_name: "qa_fixture",
    audit_role: "qa_auditor",
    server_version: "18.1",
    transaction_read_only: "on"
  }],
  tables = [],
  constraints = [],
  indexes = [],
  policies = [],
  role = [{}],
  stats = [],
  extensions = []
} = {}) {
  const calls = [];
  let connected = false;
  let ended = false;
  const resultMap = { metadata, tables, constraints, indexes, policies, role, stats, extensions };
  const client = {
    calls,
    get connected() { return connected; },
    get ended() { return ended; },
    async connect() { connected = true; },
    async query(sql) {
      calls.push(sql);
      if (sql === "SHOW transaction_read_only") {
        return { rows: [{ transaction_read_only: readOnly }] };
      }
      const match = sql.match(/jb-expert-qa:([a-z]+)/);
      if (match) return { rows: resultMap[match[1]] ?? [] };
      return { rows: [] };
    },
    async end() { ended = true; }
  };
  return client;
}

const connectionString = "postgresql://qa_user:secret-value@db.example.test:5432/qa_fixture?sslmode=require";

test("PostgreSQL audit uses a read-only transaction, metadata queries, rollback and closes the client", async () => {
  const client = fixtureClient();
  const report = await auditPostgresDatabase({
    connectionString,
    clientFactory: async (config) => {
      assert.equal(config.host, "db.example.test");
      assert.equal(config.database, "qa_fixture");
      assert.equal(config.user, "qa_user");
      assert.equal(config.password, "secret-value");
      assert.deepEqual(config.ssl, { rejectUnauthorized: true });
      return client;
    }
  });

  assert.equal(report.database.engine, "postgresql");
  assert.equal(report.database.transactionReadOnly, true);
  assert.equal(report.database.name, "qa_fixture");
  assert.equal(report.coverage.applicationRowsRead, 0);
  assert.equal(client.calls[0], "BEGIN READ ONLY");
  assert.ok(client.calls.includes("ROLLBACK"));
  assert.equal(client.ended, true);
  assert.equal(client.calls.some((sql) => /\\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\\b/i.test(sql)), false);
});

test("live audit reports missing primary keys, missing FK indexes and unvalidated constraints", async () => {
  const client = fixtureClient({
    tables: [{
      schema_name: "public", table_name: "orders", relkind: "r",
      estimated_rows: "12000", total_bytes: "8192",
      has_primary_key: false, row_level_security: false, force_row_level_security: false
    }],
    constraints: [{
      schema_name: "public", table_name: "orders",
      constraint_name: "orders_customer_fk", constraint_type: "f",
      is_validated: false, columns: ["customer_id"]
    }],
    indexes: []
  });

  const report = await auditPostgresDatabase({ connectionString, clientFactory: async () => client });
  const ids = report.diagnostics.map((item) => item.id);
  assert.ok(ids.some((id) => id.startsWith("DB-LIVE-NO-PRIMARY-KEY-")));
  assert.ok(ids.includes("DB-LIVE-UNVALIDATED-CONSTRAINT-orders_customer_fk"));
  assert.ok(ids.includes("DB-LIVE-FK-NO-INDEX-orders_customer_fk"));
});

test("live audit flags elevated roles, invalid indexes and RLS without policies", async () => {
  const client = fixtureClient({
    tables: [{
      schema_name: "public", table_name: "accounts", relkind: "r",
      estimated_rows: "5", total_bytes: "8192",
      has_primary_key: true, row_level_security: true, force_row_level_security: true
    }],
    indexes: [{
      schema_name: "public", table_name: "accounts", index_name: "accounts_idx",
      is_valid: false, is_ready: false, is_partial: false, key_columns: ["id"]
    }],
    role: [{
      is_superuser: true, can_create_database: true, can_create_role: true,
      can_replicate: false, bypasses_rls: true
    }]
  });

  const report = await auditPostgresDatabase({ connectionString, clientFactory: async () => client });
  const ids = report.diagnostics.map((item) => item.id);
  assert.ok(ids.includes("DB-LIVE-ROLE-SUPERUSER"));
  assert.ok(ids.includes("DB-LIVE-INVALID-INDEX-accounts_idx"));
  assert.ok(ids.some((id) => id.startsWith("DB-LIVE-RLS-NO-POLICY-")));
  assert.ok(ids.includes("DB-LIVE-ROLE-ELEVATED-ATTRIBUTES"));
});

test("audit aborts if PostgreSQL does not confirm read-only mode", async () => {
  const client = fixtureClient({ readOnly: "off" });
  await assert.rejects(
    auditPostgresDatabase({ connectionString, clientFactory: async () => client }),
    /did not confirm a read-only transaction/
  );
  assert.ok(client.calls.includes("ROLLBACK"));
  assert.equal(client.ended, true);
});

test("invalid connection schemes and missing clients are rejected before any audit query", async () => {
  await assert.rejects(
    auditPostgresDatabase({ connectionString: "https://example.test/db" }),
    /postgres/
  );
  await assert.rejects(
    auditPostgresDatabase({ connectionString, clientFactory: async () => ({}) }),
    /invalid client/
  );
});

test("connection errors redact connection strings and passwords", async () => {
  await assert.rejects(
    auditPostgresDatabase({
      connectionString,
      clientFactory: async () => {
        throw new Error("could not connect using postgresql://user:secret-value@host/db");
      }
    }),
    (error) => {
      assert.equal(error.message.includes("secret-value"), false);
      assert.equal(error.message.includes("postgresql://user"), false);
      assert.match(error.message, /redacted PostgreSQL connection string/);
      return true;
    }
  );
});
