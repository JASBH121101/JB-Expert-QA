import { basename, resolve } from "node:path";
import { ExpertQAEngine } from "../../core/engine.js";
import { RuleRegistry } from "../../core/rule-registry.js";
import { ENGINE_VERSION } from "../../core/version.js";
import projectConfig from "../../../config/project-audit.config.json" with { type: "json" };
import { scanProject } from "./scan-project.js";
import { projectRules } from "../../specialists/project-rules.js";

export async function auditProject(rootPath, { config = projectConfig, scanOptions = {} } = {}) {
  if (typeof rootPath !== "string" || !rootPath.trim()) throw new TypeError("A project directory path is required");
  const root = resolve(rootPath);
  const scan = await scanProject(root, scanOptions);
  const registry = new RuleRegistry();
  for (const rule of projectRules) registry.register(rule);

  const incompleteReasons = [];
  if (scan.summary.truncated) incompleteReasons.push("file-count or directory-depth limit reached");
  if (scan.summary.oversizedFiles > 0) incompleteReasons.push(scan.summary.oversizedFiles + " oversized file(s) skipped");
  if (scan.summary.unreadableFiles > 0) incompleteReasons.push(scan.summary.unreadableFiles + " unreadable file(s) skipped");
  const scanComplete = incompleteReasons.length === 0;

  const context = {
    projectFiles: scan.files,
    packageManifests: scan.manifests,
    projectScan: scan,
    thresholds: config.thresholds ?? {}
  };
  const report = await new ExpertQAEngine({ registry, config }).audit(context);

  return Object.freeze({
    ...report,
    engine: "JB Expert QA — Project Auditor",
    version: ENGINE_VERSION,
    target: Object.freeze({ project: basename(root) }),
    projectScan: scan.summary,
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
      networkRequests: 0,
      dependencyAdvisoryLookup: false,
      secretsCopiedToReport: false,
      limitations: Object.freeze([
        "Static pattern checks require manual review and can produce false positives.",
        "Dependency CVEs and current package versions are not checked because no advisory service is queried.",
        "The scanner does not execute project code, install dependencies, or connect to the database.",
        ...(scanComplete ? [] : ["The scan is incomplete; the result is blocked until omitted files can be inspected."])
      ])
    })
  });
}
