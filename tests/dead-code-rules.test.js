import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadCodeRules } from "../src/specialists/dead-code-rules.js";
import { auditProject } from "../src/adapters/filesystem/audit-project.js";

const evaluate = deadCodeRules.find((rule) => rule.id === "code-quality.possibly-unused-exports").evaluate;

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


const evaluateBindings = deadCodeRules.find((rule) => rule.id === "code-quality.possibly-unused-bindings").evaluate;
const evaluateCss = deadCodeRules.find((rule) => rule.id === "code-quality.possibly-unused-css-selectors").evaluate;
const evaluateDeclarations = deadCodeRules.find((rule) => rule.id === "code-quality.possibly-unused-declarations").evaluate;
const evaluateImports = deadCodeRules.find((rule) => rule.id === "code-quality.unresolved-relative-imports").evaluate;
const evaluateCycles = deadCodeRules.find((rule) => rule.id === "code-quality.circular-dependencies").evaluate;

test("reports unused imports and local variables as review-only candidates", () => {
  const findings = evaluateBindings({ projectFiles: [file("src/app.js", [
    'import { unusedImport, usedImport as active } from "./lib.js";',
    "const unusedLocal = buildResource();",
    "const usedLocal = active;",
    "console.log(usedLocal);"
  ].join("\n"))] });
  assert.equal(findings.length, 2);
  assert.ok(findings.some((item) => item.id.includes("IMPORT") && item.evidence.bindingName === "unusedImport"));
  assert.ok(findings.some((item) => item.id.includes("BINDING") && item.evidence.bindingName === "unusedLocal"));
  assert.ok(findings.every((item) => item.severity === "info"));
  assert.ok(findings.every((item) => item.metadata.safeToDeleteAutomatically === false));
});

test("does not report referenced, exported, underscored, or duplicate-name bindings", () => {
  const findings = evaluateBindings({ projectFiles: [file("src/app.js", [
    'import { used } from "./lib.js";',
    "const local = used;",
    "export const publicApi = 1;",
    "const _intentionallyUnused = 2;",
    "function nested(local) { return local; }",
    "console.log(local);"
  ].join("\n"))] });
  assert.equal(findings.length, 0);
});

test("write-only assignment does not count as a local binding read", () => {
  const findings = evaluateBindings({ projectFiles: [file("src/write-only.js", "let neverRead = 0; neverRead = 1;\n")] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence.bindingName, "neverRead");
});

test("abstains from unused-binding analysis when eval or with creates dynamic scope", () => {
  const findings = evaluateBindings({ projectFiles: [file("src/dynamic.js", 'const maybeUsed = 1; eval("maybeUsed");\n')] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "CODE-DEAD-LOCAL-ANALYSIS-SKIPPED");
});

test("reports simple CSS class and id selectors without scanned references", () => {
  const findings = evaluateCss({ projectFiles: [
    { path: "styles/site.css", extension: ".css", content: ".button { color: red; } .orphan { color: blue; } #legacy { display: none; }" },
    { path: "src/page.html", extension: ".html", content: '<button class="button">Save</button><div id="current"></div>' }
  ] });
  assert.equal(findings.length, 2);
  assert.ok(findings.some((item) => item.evidence.selector === ".orphan"));
  assert.ok(findings.some((item) => item.evidence.selector === "#legacy"));
  assert.ok(findings.every((item) => item.metadata.confidence === "review-only"));
});

test("CSS usage in code and other stylesheets prevents unused-selector findings", () => {
  const findings = evaluateCss({ projectFiles: [
    { path: "styles/site.css", extension: ".css", content: ".button { color: red; } .shared { color: blue; }" },
    { path: "styles/theme.css", extension: ".css", content: ".theme { composes: shared; }" },
    file("src/page.js", 'const styles = { button: "button" }; element.classList.add("theme");')
  ] });
  assert.equal(findings.some((item) => item.evidence?.selector === ".button"), false);
  assert.equal(findings.some((item) => item.evidence?.selector === ".shared"), false);
  assert.equal(findings.some((item) => item.evidence?.selector === ".theme"), false);
});

test("skips CSS reachability when class assignment is dynamic or selector scoping is framework-specific", () => {
  const dynamic = evaluateCss({ projectFiles: [
    { path: "styles/site.css", extension: ".css", content: ".maybeUnused { color: red; }" },
    { path: "src/page.jsx", extension: ".jsx", content: "return <div className={computeClass()} />;" }
  ] });
  assert.equal(dynamic.length, 1);
  assert.equal(dynamic[0].id, "CODE-DEAD-CSS-ANALYSIS-SKIPPED");
  const scoped = evaluateCss({ projectFiles: [
    { path: "styles/component.scss", extension: ".scss", content: ":global(.external) { color: red; } .local { color: blue; }" },
    { path: "src/page.html", extension: ".html", content: "<div></div>" }
  ] });
  assert.equal(scoped.length, 1);
  assert.ok(scoped[0].id.startsWith("CODE-DEAD-CSS-ANALYSIS-SKIPPED-"));
});

test("project audit reports binding and CSS candidate counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-dead-extra-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "styles"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "dead-code-extra-fixture" }));
    await writeFile(join(root, "src", "app.js"), 'import { unused } from "./lib.js";\nconst neverRead = 3;\n');
    await writeFile(join(root, "src", "lib.js"), "export const helper = true;\n");
    await writeFile(join(root, "styles", "site.css"), ".orphan { color: red; }\n");
    const report = await auditProject(root);
    assert.equal(report.analysisScope.deadCodeAnalysis.possibleUnusedBindings, 2);
    assert.equal(report.analysisScope.deadCodeAnalysis.possibleUnusedCssSelectors, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("reports unreferenced functions and classes but ignores recursion, exports, references, and duplicate names", () => {
  const findings = evaluateDeclarations({ projectFiles: [file("src/declarations.js", [
    "function deadFunction() { return 1; }",
    "function recursiveOnly() { return recursiveOnly(); }",
    "class DeadCache {}",
    "function usedFunction() {}",
    "function caller() { usedFunction(); }",
    "class UsedCache {}",
    "new UsedCache();",
    "export function publicFunction() {}",
    "function exportedByList() {}",
    "export { exportedByList as publicAlias };",
    "function _intentionallyKept() {}",
    "function duplicateName() {}",
    "{ function duplicateName() {} }"
  ].join("\n"))] });
  const names = findings.map((item) => item.evidence.declarationName).sort();
  assert.deepEqual(names, ["DeadCache", "caller", "deadFunction", "recursiveOnly"]);
  assert.ok(findings.every((item) => item.metadata.confidence === "review-only"));
  assert.ok(findings.every((item) => item.metadata.safeToDeleteAutomatically === false));
});

test("abstains from function and class analysis when direct eval can inspect local names", () => {
  const findings = evaluateDeclarations({ projectFiles: [file("src/reflection.js", [
    "function mayBeLoadedByName() {}",
    'eval("mayBeLoadedByName()");'
  ].join("\n"))] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "CODE-DEAD-FUNCTION-CLASS-ANALYSIS-SKIPPED");
  assert.equal(findings[0].metadata.confidence, "coverage-warning");
});

test("skips a declaration when an arrow parameter shadows its name", () => {
  const findings = evaluateDeclarations({ projectFiles: [file("src/shadow.js", [
    "function localHandler() {}",
    "const callback = (localHandler) => localHandler;"
  ].join("\n"))] });
  assert.equal(findings.some((item) => item.evidence?.declarationName === "localHandler"), false);
});

test("reports missing relative imports but resolves extensionless, TypeScript, JSON, and package-entry paths", () => {
  const files = [
    file("src/consumer.js", [
      'import missing from "./missing.js";',
      'import helper from "./helper";',
      'import typed from "./typed.js";',
      'import config from "./config.json";',
      'import pkg from "./pkg";',
      'import external from "external-package";'
    ].join("\n")),
    { path: "src/helper.mjs", extension: ".mjs", content: "export default true;" },
    { path: "src/typed.ts", extension: ".ts", content: "export default true;" },
    { path: "src/config.json", extension: ".json", content: "{}" },
    { path: "src/pkg/package.json", extension: ".json", content: '{"main":"./entry.js"}' },
    file("src/pkg/entry.js", "export default true;")
  ];
  const findings = evaluateImports({
    projectFiles: files,
    packageManifests: [{ path: "src/pkg/package.json", data: { main: "./entry.js" }, parseError: null }]
  });
  assert.equal(findings.length, 1, JSON.stringify(findings.map((item) => ({ id: item.id, specifier: item.evidence?.specifier }))));
  assert.equal(findings[0].evidence.importer, "src/consumer.js");
  assert.equal(findings[0].evidence.specifier, "./missing.js");
  assert.equal(findings[0].severity, "warning");
  assert.equal(findings[0].metadata.confidence, "review-required");
});

test("does not call paths outside the scan root unresolved and reports parse or dynamic coverage gaps", () => {
  const outside = evaluateImports({ projectFiles: [
    file("consumer.js", 'import shared from "../shared.js";')
  ] });
  assert.deepEqual(outside, []);

  const partial = evaluateImports({ projectFiles: [
    file("src/broken.js", "import { x } from ;"),
    file("src/dynamic.js", 'import("./modules/" + name);')
  ] });
  assert.ok(partial.some((item) => item.id === "CODE-IMPORT-RESOLUTION-PARSE-SKIPPED"));
  assert.ok(partial.some((item) => item.id === "CODE-IMPORT-RESOLUTION-DYNAMIC-SKIPPED"));
  assert.equal(partial.some((item) => item.id.startsWith("CODE-IMPORT-UNRESOLVED-")), false);
});

test("marks TypeScript and framework import syntax as uncovered by the JavaScript-only graph", () => {
  const files = [
    { path: "src/component.tsx", extension: ".tsx", content: 'import View from "./view"; export default View;' },
    file("src/main.js", 'import "./component.tsx";')
  ];
  const importFindings = evaluateImports({ projectFiles: files });
  assert.ok(importFindings.some((item) => item.id === "CODE-IMPORT-RESOLUTION-UNSUPPORTED-SOURCES"));
  const cycleFindings = evaluateCycles({ projectFiles: files });
  assert.ok(cycleFindings.some((item) => item.id === "CODE-CYCLE-ANALYSIS-PARTIAL"));
});

test("detects a multi-module circular dependency and ignores acyclic dependencies", () => {
  const findings = evaluateCycles({ projectFiles: [
    file("src/a.js", 'import "./b.js";'),
    file("src/b.js", 'import "./c.js";'),
    file("src/c.js", 'import "./a.js";'),
    file("src/main.js", 'import "./a.js";'),
    file("src/leaf.js", "export const leaf = true;")
  ] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence.cycleSize, 3);
  assert.deepEqual(findings[0].evidence.modules, ["src/a.js", "src/b.js", "src/c.js"]);
  assert.equal(findings[0].metadata.confidence, "review-only");
  assert.equal(findings[0].metadata.safeToDeleteAutomatically, false);
});

test("detects a CommonJS self-cycle and marks cycles with dynamic loading as partial", () => {
  const findings = evaluateCycles({ projectFiles: [
    { path: "src/self.cjs", extension: ".cjs", content: 'require("./self.cjs");' },
    file("src/loader.js", 'import("./" + moduleName);')
  ] });
  assert.ok(findings.some((item) => item.id.startsWith("CODE-CYCLE-") && item.evidence.cycleSize === 1));
  assert.ok(findings.some((item) => item.id === "CODE-CYCLE-ANALYSIS-PARTIAL"));
});

test("project audit exposes unused declarations, unresolved imports, and dependency cycle counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-graph-analysis-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "graph-analysis-fixture" }));
    await writeFile(join(root, "src", "app.js"), [
      'import missing from "./missing.js";',
      "function abandonedTask() {}",
      "class OldCache {}"
    ].join("\n"));
    await writeFile(join(root, "src", "a.js"), 'import "./b.js";');
    await writeFile(join(root, "src", "b.js"), 'import "./a.js";');
    const report = await auditProject(root);
    assert.equal(report.summary.rulesExecuted, 33);
    assert.equal(report.analysisScope.deadCodeAnalysis.possibleUnusedDeclarations, 2);
    assert.equal(report.analysisScope.deadCodeAnalysis.unresolvedRelativeImports, 1, JSON.stringify({
      diagnostics: report.diagnostics.map((item) => ({ id: item.id, ruleId: item.ruleId, location: item.location })),
      execution: report.execution.filter((item) => item.ruleId === "code-quality.unresolved-relative-imports")
    }));
    assert.equal(report.analysisScope.deadCodeAnalysis.dependencyCycles, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
