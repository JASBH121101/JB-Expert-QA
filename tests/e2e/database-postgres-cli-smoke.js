import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const connectionString = process.env.QA_DATABASE_URL;
if (!connectionString) {
  throw new Error("QA_DATABASE_URL is required for the local PostgreSQL CLI smoke test.");
}

const parsedUrl = new URL(connectionString);
const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
  throw new Error("The PostgreSQL CLI smoke test accepts only a local loopback database.");
}

const schema = "jbqa_e2e";
const table = "no_primary_key";
const client = new Client({ connectionString });
let connected = false;

try {
  await client.connect();
  connected = true;
  await client.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
  await client.query("CREATE SCHEMA " + schema);
  await client.query("CREATE TABLE " + schema + "." + table + " (payload text)");

  const result = spawnSync(
    process.execPath,
    ["src/postgres-database-cli.js", "--env=QA_DATABASE_URL", "--confirm-read-only"],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024
    }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "Database CLI exited with code " + result.status + ": " +
      String(result.stderr ?? "").slice(0, 4000)
    );
  }

  assert.equal(result.stderr, "", "The CLI should not emit warnings or credentials to stderr.");
  assert.equal(result.stdout.includes(connectionString), false, "The CLI must not print the connection URL.");

  const report = JSON.parse(result.stdout);
  assert.equal(report.engine, "JB Expert QA");
  assert.equal(report.database.engine, "postgresql");
  assert.equal(report.database.transactionReadOnly, true);
  assert.equal(report.coverage.metadataOnly, true);
  assert.equal(report.coverage.applicationRowsRead, 0);
  assert.equal(report.coverage.catalogQueries, 8);
  assert.ok(
    report.inventory.tables.some((item) => item.schema === schema && item.name === table),
    "The real PostgreSQL catalog result should include the probe table."
  );
  assert.ok(
    report.diagnostics.some((item) =>
      item.id.startsWith("DB-LIVE-NO-PRIMARY-KEY-") &&
      item.location === schema + "." + table
    ),
    "The CLI should report the intentionally missing primary key in the disposable CI database."
  );

  process.stdout.write(
    "PostgreSQL CLI E2E passed: pg connected, read-only mode verified, " +
    report.summary.tables + " tables inspected, zero application rows read.\n"
  );
} finally {
  if (connected) {
    try {
      await client.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    } finally {
      await client.end();
    }
  }
}
