import { basename, resolve } from "node:path";
import { ExpertQAEngine } from "../../core/engine.js";
import { validateEngineConfig } from "../../core/config.js";
import { RuleRegistry } from "../../core/rule-registry.js";
import { ENGINE_VERSION } from "../../core/version.js";
import securityConfig from "../../../config/security-audit.config.json" with { type: "json" };
import { scanProject } from "./scan-project.js";
import { codeQualityRules, securityRules } from "../../specialists/project-rules.js";
import { securityDefenseRules } from "../../specialists/security-rules.js";

export async function auditSecurityProject(rootPath, {
  config = securityConfig,
  scanOptions = {}
} = {}) {
  if (typeof rootPath !== "string" || !rootPath.trim()) {
    throw new TypeError("A project directory path is required");
  }

  const root = resolve(rootPath);
  const validatedConfig = validateEngineConfig(config);
  const scan = await scanProject(root, { ...validatedConfig.scan, ...scanOptions });
  const incompleteReasons = [];

  if (scan.summary.truncated) incompleteReasons.push("file-count or directory-depth limit reached");
  if (scan.summary.oversizedFiles > 0) incompleteReasons.push(scan.summary.oversizedFiles + " oversized file(s) skipped");
  if (scan.summary.unreadableFiles > 0) incompleteReasons.push(scan.summary.unreadableFiles + " unreadable file(s) skipped");

  const registry = new RuleRegistry();
  registry.register(codeQualityRules[0]);
  for (const rule of securityRules) registry.register(rule);
  for (const rule of securityDefenseRules) registry.register(rule);

  const report = await new ExpertQAEngine({
    registry,
    config: validatedConfig
  }).audit({
    projectFiles: scan.files,
    packageManifests: scan.manifests,
    projectScan: scan,
    thresholds: validatedConfig.thresholds
  });

  return Object.freeze({
    ...report,
    engine: "JB Expert QA — Security Auditor",
    version: ENGINE_VERSION,
    target: Object.freeze({ project: basename(root) }),
    projectScan: scan.summary,
    securityAssessment: Object.freeze({
      mode: "local-static",
      complete: incompleteReasons.length === 0,
      incompleteReasons: Object.freeze(incompleteReasons),
      networkRequests: 0,
      databaseConnections: 0,
      projectCodeExecuted: false,
      credentialContentsRead: false,
      limitations: Object.freeze([
        "Static rules are evidence-based heuristics and can produce false positives or miss vulnerabilities.",
        "This assessment does not perform authenticated penetration testing, exploit requests, or database access.",
        "A clean static report is not proof that the application is secure; deployment configuration and runtime controls require separate validation.",
        "Multi-line data flow, framework middleware, and controls implemented in external services may not be fully visible to the analyzer."
      ])
    })
  });
}
