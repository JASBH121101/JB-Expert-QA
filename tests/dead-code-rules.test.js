import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadCodeRules } from "../src/specialists/dead-code-rules.js";
import { auditProject } from "../src/adapters/filesystem/audit-project.js";

const evaluate = deadCodeRules[0].evaluate;

function file(path, content) {
  return { path, extension: ".js", content };
}

test("reports unreferenced exports as review-only candidates, never deletion instructions", () => {
  const findings = evaluate({
    projectFiles: [file("src/orphan.js", "export function orphan() { return 1; }\n")],
    packageManifests: []
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.equal(findings[0].evidence.exportName, "orphan");
  assert.equal(findings[0].metadata.confidence, "review-only");
  assert.equal(findings[0].metadata.safeToDeleteAutomatically, false);
  assert.match(findings[0].recommendation, /review|check/i);
});

test("does not report named or default exports with static in-repository imports", () => {
  const findings = evaluate({
    projectFiles: [
      file("src/library.js", "export const value = 1; export default function run() {}\n"),
      file("src/consumer.js", 'import run, { value } from "./library.js"; run(); console.log(value);\n')
    ],
    packageManifests: []
  });
  assert.equal(findings.some((item) => item.evidence?.path === "src/library.js"), false);
});

test("does not report exports reachable through namespace imports or export-star re-exports", () => {
  const findings = evaluate({
    projectFiles: [
      file("src/library.js", "export const value = 1;\n"),
      file("src/namespace-consumer.js", 'import * as library from "./library.js"; console.log(library.value);\n'),
      file("src/other.js", "export function exposed() {}\n"),
      file("src/index.js", 'export * from "./other.js";\n')
    ],
    packageManifests: []
  });
  assert.equal(findings.some((item) => item.evidence?.path === "src/library.js"), false);
  assert.equal(findings.some((item) => item.evidence?.path === "src/other.js"), false);
});

test("respects package entrypoints, index modules, and CommonJS boundaries", () => {
  const findings = evaluate({
    projectFiles: [
      file("src/public-api.js", "export const api = true;\n"),
      file("src/index.js", "export const indexApi = true;\n"),
      file("src/legacy.cjs", "exports.legacy = true;\n")
    ],
    packageManifests: [{
      path: "package.json",
      data: { main: "./src/public-api.js", exports: { ".": "./src/index.js" } },
      parseError: null
    }]
  });
  assert.equal(findings.some((item) => item.evidence?.path === "src/public-api.js"), false);
  assert.equal(findings.some((item) => item.evidence?.path === "src/index.js"), false);
  assert.equal(findings.some((item) => item.evidence?.path === "src/legacy.cjs"), false);
});

test("abstains for dynamic import or require and never labels exports unused", () => {
  const findings = evaluate({
    projectFiles: [
      file("src/library.js", "export const possiblyUsedAtRuntime = true;\n"),
      file("src/loader.js", 'const moduleName = "./" + name; import(moduleName);\n')
    ],
    packageManifests: []
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "CODE-DEAD-EXPORT-ANALYSIS-SKIPPED");
  assert.equal(findings[0].metadata.confidence, "coverage-warning");
});

test("reports parse coverage warnings instead of treating unparsable modules as safe", () => {
  const findings = evaluate({
    projectFiles: [
      file("src/broken.js", "export const = ;\n"),
      file("src/valid.js", "export const valid = true;\n")
    ],
    packageManifests: []
  });
  assert.ok(findings.some((item) => item.id === "CODE-DEAD-EXPORT-PARSE-SKIPPED"));
  assert.equal(findings.some((item) => item.evidence?.path === "src/broken.js"), false);
});

test("ignores non-JavaScript extensions instead of pretending they were analyzed", () => {
  const findings = evaluate({
    projectFiles: [{ path: "src/component.ts", extension: ".ts", content: "export const component = true;" }],
    packageManifests: []
  });
  assert.deepEqual(findings, []);
});

test("project audit exposes dead-code analysis coverage and candidate counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-dead-code-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "dead-code-fixture",
      main: "src/index.js"
    }));
    await writeFile(join(root, "src", "index.js"), "export const entry = true;\n");
    await writeFile(join(root, "src", "orphan.js"), "export function unusedCandidate() {}\n");

    const report = await auditProject(root);
    assert.equal(report.analysisScope.deadCodeAnalysis.status, "heuristic-complete");
    assert.equal(report.analysisScope.deadCodeAnalysis.coverageWarnings, 0);
    assert.equal(report.analysisScope.deadCodeAnalysis.possibleUnusedExports, 1);
    assert.ok(report.diagnostics.some((item) =>
      item.ruleId === "code-quality.possibly-unused-exports" &&
      item.evidence?.exportName === "unusedCandidate"
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
