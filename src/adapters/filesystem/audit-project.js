import { basename, resolve } from "node:path";
import { ExpertQAEngine } from "../../core/engine.js";
import { validateEngineConfig } from "../../core/config.js";
import { RuleRegistry } from "../../core/rule-registry.js";
import { ENGINE_VERSION } from "../../core/version.js";
import projectConfig from "../../../config/project-audit.config.json" with { type: "json" };
import { scanProject } from "./scan-project.js";
import { scanNpmAdvisories } from "../advisories/osv.js";
import { projectRules } from "../../specialists/project-rules.js";
import { deadCodeRules } from "../../specialists/dead-code-rules.js";

export async function auditProject(rootPath, { config = projectConfig, scanOptions = {} } = {}) {
  if (typeof rootPath !== "string" || !rootPath.trim()) throw new TypeError("A project directory path is required");
  const root = resolve(rootPath);
  const validatedConfig = validateEngineConfig(config);
  const effectiveScanOptions = { ...validatedConfig.scan, ...scanOptions };
  const scan = await scanProject(root, effectiveScanOptions);
  const dependencyAdvisories = await scanNpmAdvisories(scan, validatedConfig.advisories);
  const registry = new RuleRegistry();
  for (const rule of projectRules) registry.register(rule);
  for (const rule of deadCodeRules) registry.register(rule);

  const incompleteReasons = [];
  if (scan.summary.truncated) incompleteReasons.push("file-count or directory-depth limit reached");
  if (scan.summary.oversizedFiles > 0) incompleteReasons.push(scan.summary.oversizedFiles + " oversized file(s) skipped");
  if (scan.summary.unreadableFiles > 0) incompleteReasons.push(scan.summary.unreadableFiles + " unreadable file(s) skipped");
  if (scan.summary.skippedSymlinks > 0) incompleteReasons.push(scan.summary.skippedSymlinks + " symbolic link(s) not followed");
  const scanComplete = incompleteReasons.length === 0;

  const context = {
    projectFiles: scan.files,
    packageManifests: scan.manifests,
    projectScan: scan,
    thresholds: validatedConfig.thresholds,
    dependencyAdvisoryScan: dependencyAdvisories
  };
  const report = await new ExpertQAEngine({ registry, config: validatedConfig }).audit(context);
  const hasSourceFiles = scan.files.some((file) => [
    ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte",
    ".html", ".htm", ".css", ".scss", ".sass", ".less", ".sql", ".prisma",
    ".sh", ".ps1", ".py", ".rb", ".php", ".java", ".kt", ".go", ".rs",
    ".cs", ".graphql", ".gql"
  ].includes(file.extension));
  const scoring = hasSourceFiles ? report.scoring : Object.freeze({
    ...report.scoring,
    passed: false,
    blockedByCoverage: true
  });
  const diagnostics = report.diagnostics;

  const deadCodeRuleIds = new Set([
    "code-quality.possibly-unused-exports",
    "code-quality.possibly-unused-bindings",
    "code-quality.possibly-unused-css-selectors",
    "code-quality.possibly-unused-declarations",
    "code-quality.unresolved-relative-imports",
    "code-quality.circular-dependencies"
  ]);
  const deadCodeWarnings = report.diagnostics.filter((item) =>
    deadCodeRuleIds.has(item.ruleId) && item.metadata?.confidence === "coverage-warning"
  );
  const possibleUnusedExports = report.diagnostics.filter((item) =>
    item.ruleId === "code-quality.possibly-unused-exports" &&
    item.id.startsWith("CODE-DEAD-EXPORT-") &&
    !deadCodeWarnings.includes(item)
  );

  return Object.freeze({
    ...report,
    scoring,
    engine: "JB Expert QA — Project Auditor",
    version: ENGINE_VERSION,
    target: Object.freeze({ project: basename(root) }),
    projectScan: scan.summary,
    dependencyAdvisories,
    analysisScope: Object.freeze({
      mode: "local-static",
      complete: scanComplete,
      incompleteReasons: Object.freeze(incompleteReasons),
      coverage: Object.freeze({
        truncated: scan.summary.truncated,
        oversizedFiles: scan.summary.oversizedFiles,
        unreadableFiles: scan.summary.unreadableFiles,
        skippedSymlinks: scan.summary.skippedSymlinks
      }),
      filesAnalyzed: scan.summary.filesRead,
      sourceFiles: scan.files.filter((file) => [
        ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte",
        ".html", ".htm", ".css", ".scss", ".sass", ".less", ".sql", ".prisma",
        ".sh", ".ps1", ".py", ".rb", ".php", ".java", ".kt", ".go", ".rs",
        ".cs", ".graphql", ".gql"
      ].includes(file.extension)).length,
      scannedExtensions: Object.freeze(Object.keys(scan.summary.languageCounts).sort()),
      assessmentStatus: !hasSourceFiles ? "insufficient-source" : (!scanComplete || deadCodeWarnings.length ? "partial" : "scanned"),
      languageCoverage: Object.freeze({
        javascriptModuleGraph: Object.freeze({
          supportedExtensions: Object.freeze([".js", ".mjs", ".cjs"]),
          scannedFiles: scan.files.filter((file) => [".js", ".mjs", ".cjs"].includes(file.extension)).length,
          unsupportedModuleFiles: scan.files.filter((file) =>
            [".jsx", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"].includes(file.extension) &&
            /\\b(?:import|export)\\b/.test(file.content)
          ).length
        }),
        cssSelectors: Object.freeze({
          parsedExtensions: Object.freeze([".css", ".scss", ".less"]),
          scannedFiles: scan.files.filter((file) => [".css", ".scss", ".sass", ".less"].includes(file.extension)).length,
          indentedSassFiles: scan.files.filter((file) => file.extension === ".sass").length
        }),
        database: Object.freeze({
          supportedExtensions: Object.freeze([".sql", ".prisma"]),
          scannedFiles: scan.files.filter((file) => [".sql", ".prisma"].includes(file.extension)).length
        }),
        dependencyAdvisories: Object.freeze({
          ecosystem: "npm",
          supportedLockfiles: Object.freeze(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"]),
          scannedLockfiles: scan.summary.lockFiles
        })
      }),
      deadCodeAnalysis: Object.freeze({
        status: deadCodeWarnings.length || !scanComplete ? "partial" : "heuristic-complete",
        coverageWarnings: deadCodeWarnings.length,
        possibleUnusedExports: possibleUnusedExports.length,
        possibleUnusedBindings: report.diagnostics.filter((item) =>
          item.ruleId === "code-quality.possibly-unused-bindings" &&
          (item.id.startsWith("CODE-DEAD-IMPORT-") || item.id.startsWith("CODE-DEAD-BINDING-"))
        ).length,
        possibleUnusedCssSelectors: report.diagnostics.filter((item) =>
          item.ruleId === "code-quality.possibly-unused-css-selectors" && item.metadata?.confidence === "review-only"
        ).length,
        possibleUnusedDeclarations: report.diagnostics.filter((item) =>
          item.ruleId === "code-quality.possibly-unused-declarations" && item.id.startsWith("CODE-DEAD-DECLARATION-")
        ).length,
        unresolvedRelativeImports: report.diagnostics.filter((item) =>
          item.ruleId === "code-quality.unresolved-relative-imports" && item.id.startsWith("CODE-IMPORT-UNRESOLVED-")
        ).length,
        dependencyCycles: report.diagnostics.filter((item) =>
          item.ruleId === "code-quality.circular-dependencies" && item.id.startsWith("CODE-CYCLE-") && item.metadata?.confidence === "review-only"
        ).length
      }),
      networkRequests: dependencyAdvisories.networkRequests ?? 0,
      dependencyAdvisoryLookup: dependencyAdvisories.enabled,
      dependencyAdvisoryStatus: dependencyAdvisories.status,
      secretsCopiedToReport: false,
      limitations: Object.freeze([
        "Static pattern checks require manual review and can produce false positives.",
        "Unused-export reachability is a conservative review heuristic over statically resolvable JavaScript module imports; external consumers, dynamic loading, reflection, and framework entrypoints may be invisible.",
        "Dependency CVEs and current package versions are not checked because no advisory service is queried.",
        "The scanner does not execute project code, install dependencies, or connect to the database.",
        ...(dependencyAdvisories.enabled ? [
          "When enabled, only package names and exact versions from supported npm lockfiles or pinned manifests are sent to OSV.dev; source code and credentials are not sent.",
          ...(dependencyAdvisories.complete ? [] : ["Dependency advisory coverage is partial or unavailable; see dependencyAdvisories status and message."])
        ] : ["Online dependency advisory lookup is disabled for this profile."]),
        ...(scanComplete ? [] : ["The scan is incomplete; the result is blocked until omitted files can be inspected."])
      ])
    })
  });
}
