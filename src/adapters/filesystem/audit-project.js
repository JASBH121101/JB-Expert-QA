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

export async function auditProject(rootPath, { config = projectConfig, scanOptions = {}, ruleIds } = {}) {
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
  const scanComplete = incompleteReasons.length === 0;

  const context = {
    projectFiles: scan.files,
    packageManifests: scan.manifests,
    projectScan: scan,
    thresholds: validatedConfig.thresholds,
    dependencyAdvisoryScan: dependencyAdvisories
  };
  const report = await new ExpertQAEngine({ registry, config: validatedConfig }).audit(context, {
    ...(ruleIds === undefined ? {} : { ruleIds })
  });
  const deadCodeSelected = ruleIds === undefined ||
    ruleIds.includes("code-quality.possibly-unused-exports");
  const deadCodeWarnings = report.diagnostics.filter((item) =>
    item.id === "CODE-DEAD-EXPORT-PARSE-SKIPPED" ||
    item.id === "CODE-DEAD-EXPORT-ANALYSIS-SKIPPED"
  );
  const possibleUnusedExports = report.diagnostics.filter((item) =>
    item.ruleId === "code-quality.possibly-unused-exports" &&
    item.id.startsWith("CODE-DEAD-EXPORT-") &&
    !deadCodeWarnings.includes(item)
  );

  return Object.freeze({
    ...report,
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
        unreadableFiles: scan.summary.unreadableFiles
      }),
      filesAnalyzed: scan.summary.filesRead,
      deadCodeAnalysis: Object.freeze({
        status: !deadCodeSelected ? "not-run" : deadCodeWarnings.length ? "partial" : "heuristic-complete",
        coverageWarnings: deadCodeWarnings.length,
        possibleUnusedExports: deadCodeSelected ? possibleUnusedExports.length : null
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
