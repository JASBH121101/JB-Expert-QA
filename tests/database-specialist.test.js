import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditDatabaseProject } from "../src/adapters/filesystem/audit-database.js";
import { databaseSpecialistRules } from "../src/specialists/database/index.js";
import { ExpertQAEngine, RuleRegistry } from "../src/index.js";

async function runRules(projectFiles) {
  const registry = new RuleRegistry();
  for (const rule of databaseSpecialistRules) registry.register(rule);
  return new ExpertQAEngine({
    registry,
    config: { weights: { database: 100 }, thresholds: { failOnCritical: true } }
  }).audit({ projectFiles, projectScan: { lockFiles: [] }, packageManifests: [] });
}

test("database specialist reuses the existing PostgreSQL, Prisma and migration checks", () => {
  const ids = databaseSpecialistRules.map((rule) => rule.id);
  for (const id of [
    "database.destructive-sql", "database.prisma-relation-index",
    "database.foreign-key-index", "database.orm-destructive-sync",
    "database.connection-tls", "database.dynamic-raw-query",
    "database.query-performance-patterns", "database.migration-reversibility"
  ]) assert.ok(ids.includes(id), "missing rule " + id);
});

test("ORM schema synchronization and insecure database TLS are detected", async () => {
  const report = await runRules([{
    path: "src/database.ts", extension: ".ts", lineCount: 3,
    content: [
      "const dataSource = new DataSource({ type: 'postgres', synchronize: true });",
      "await sequelize.sync({ force: true });",
      "const pool = new Pool({ ssl: { rejectUnauthorized: false } });"
    ].join("\n")
  }]);
  assert.ok(report.diagnostics.some((item) => item.id.startsWith("DB-ORM-SYNC-") && item.severity === "critical"));
  assert.ok(report.diagnostics.some((item) => item.id.startsWith("DB-ORM-SYNC-") && item.severity === "high"));
  assert.ok(report.diagnostics.some((item) => item.id.startsWith("DB-TLS-") && item.severity === "high"));
});

test("raw SQL concatenation is reported without flagging positional parameters", async () => {
  const report = await runRules([{
    path: "src/repository.ts", extension: ".ts", lineCount: 2,
    content: [
      "await pool.query('SELECT * FROM users WHERE id = ' + userId);",
      "await pool.query('SELECT * FROM users WHERE id = $1', [userId]);"
    ].join("\n")
  }]);
  const findings = report.diagnostics.filter((item) => item.id.startsWith("DB-RAW-DYNAMIC-"));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
});

test("SQL efficiency rules are low-confidence review hints and ignore comments", async () => {
  const report = await runRules([{
    path: "database/queries.sql", extension: ".sql", lineCount: 3,
    content: [
      "SELECT * FROM customers;",
      "SELECT id FROM products WHERE name ILIKE '%phone%';",
      "-- SELECT * FROM archived;"
    ].join("\n")
  }]);
  assert.ok(report.diagnostics.some((item) => item.id.startsWith("DB-PERF-SELECT-STAR-") && item.severity === "low"));
  assert.ok(report.diagnostics.some((item) => item.id.startsWith("DB-PERF-LEADING-WILDCARD-") && item.severity === "medium"));
  assert.equal(report.diagnostics.some((item) => item.description.includes("archived")), false);
});

test("migration without visible rollback is flagged for review", async () => {
  const report = await runRules([{
    path: "database/migrations/2026_create_orders.php", extension: ".php", lineCount: 5,
    content: "<?php\nreturn new class { public function up(): void { Schema::create('orders', function () {}); } };"
  }]);
  assert.ok(report.diagnostics.some((item) => item.id.startsWith("DB-MIGRATION-DOWN-")));
});

test("focused database audit reports scope and guarantees no DB/network writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-db-audit-"));
  try {
    await mkdir(join(root, "database", "migrations"), { recursive: true });
    await writeFile(join(root, "database", "migrations", "001.sql"),
      "CREATE TABLE users (id integer PRIMARY KEY, email text);\n");
    await writeFile(join(root, "src.js"), "export const ready = true;\n");
    const report = await auditDatabaseProject(root);
    assert.equal(report.engine, "JB Expert QA — Database Auditor");
    assert.equal(report.databaseScope.databaseEvidenceFiles, 1);
    assert.equal(report.databaseScope.schemaFiles, 1);
    assert.equal(report.databaseScope.databaseConnections, 0);
    assert.equal(report.databaseScope.networkRequests, 0);
    assert.equal(report.databaseScope.databaseWrites, 0);
    assert.equal(report.databaseScope.complete, true);
    assert.equal(report.databaseScope.assessmentStatus, "scanned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("database audit cannot pass when there is no database evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-db-empty-"));
  try {
    await writeFile(join(root, "index.js"), "export const value = 1;\n");
    const report = await auditDatabaseProject(root);
    assert.equal(report.databaseScope.assessmentStatus, "insufficient-database-evidence");
    assert.equal(report.scoring.passed, false);
    assert.equal(report.scoring.blockedByCoverage, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
