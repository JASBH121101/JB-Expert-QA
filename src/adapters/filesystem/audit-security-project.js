import { basename, resolve } from "node:path";
import { ExpertQAEngine } from "../../core/engine.js";
import { validateEngineConfig } from "../../core/config.js";
import { RuleRegistry } from "../../core/rule-registry.js";
import { ENGINE_VERSION } from "../../core/version.js";
import securityConfig from "../../../config/security-audit.config.json" with { type: "json" };
import { scanProject } from "./scan-project.js";
import { codeQualityRules, securityRules, dependencyRules } from "../../specialists/project-rules.js";
import { scanNpmAdvisories } from "../advisories/osv.js";
import { securityDefenseRules } from "../../specialists/security-rules.js";
import { astSecurityRules } from "../../specialists/ast-security-rules.js";

export async function auditSecurityProject(rootPath, {
  config = securityConfig,
  scanOptions = {},
  onlineAdvisories = false,
  fetchImpl = globalThis.fetch,
  ruleIds
} = {}) {
  if (typeof rootPath !== "string" || !rootPath.trim()) {
    throw new TypeError("A project directory path is required");
  }

  const root = resolve(rootPath);
  if (typeof onlineAdvisories !== "boolean") throw new TypeError("onlineAdvisories must be a boolean");
  if (fetchImpl !== undefined && typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const validatedConfig = validateEngineConfig(config);
  const scan = await scanProject(root, { ...validatedConfig.scan, ...scanOptions });
  const advisoryOptions = onlineAdvisories
    ? { ...validatedConfig.advisories, enabled: true, required: true }
    : validatedConfig.advisories;
  const dependencyAdvisories = await scanNpmAdvisories(scan, advisoryOptions, { fetchImpl });
  const incompleteReasons = [];

  if (scan.summary.truncated) incompleteReasons.push("file-count or directory-depth limit reached");
  if (scan.summary.oversizedFiles > 0) incompleteReasons.push(scan.summary.oversizedFiles + " oversized file(s) skipped");
  if (scan.summary.unreadableFiles > 0) incompleteReasons.push(scan.summary.unreadableFiles + " unreadable file(s) skipped");
  const hasDeclaredNpmDependencies = scan.manifests.some((manifest) =>
    manifest.path === "package.json" && manifest.data &&
    ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((section) =>
      Object.keys(manifest.data[section] ?? {}).length > 0
    )
  );
  if (dependencyAdvisories.enabled && hasDeclaredNpmDependencies && !dependencyAdvisories.complete) {
    incompleteReasons.push("dependency advisory coverage is incomplete");
  }

  const registry = new RuleRegistry();
  registry.register(codeQualityRules[0]);
  for (const rule of securityRules) registry.register(rule);
  for (const rule of securityDefenseRules) registry.register(rule);
  for (const rule of astSecurityRules) registry.register(rule);
  for (const rule of dependencyRules) registry.register(rule);

  const report = await new ExpertQAEngine({
    registry,
    config: validatedConfig
  }).audit({
    projectFiles: scan.files,
    packageManifests: scan.manifests,
    projectScan: scan,
    thresholds: validatedConfig.thresholds,
    dependencyAdvisoryScan: dependencyAdvisories
  }, {
    ...(ruleIds === undefined ? {} : { ruleIds })
  });

  const astParseSkips = report.diagnostics.filter((item) => item.id.startsWith("AST-PARSE-")).length;
  const astUnsupportedFiles = report.diagnostics.filter((item) => item.id.startsWith("AST-UNSUPPORTED-")).length;
  const astPropagationLimits = report.diagnostics.filter((item) => item.id.startsWith("AST-TAINT-LIMIT-")).length;
  if (astParseSkips > 0) {
    incompleteReasons.push(astParseSkips + " JavaScript file(s) could not be parsed for AST analysis");
  }
  if (astUnsupportedFiles > 0) {
    incompleteReasons.push(astUnsupportedFiles + " code file(s) use a language not yet supported by AST analysis");
  }
  if (astPropagationLimits > 0) {
    incompleteReasons.push(astPropagationLimits + " JavaScript file(s) reached the AST data-flow propagation limit");
  }

  return Object.freeze({
    ...report,
    engine: "JB Expert QA — Security Auditor",
    version: ENGINE_VERSION,
    target: Object.freeze({ project: basename(root) }),
    projectScan: scan.summary,
    dependencyAdvisories,
    securityAssessment: Object.freeze({
      mode: "local-static",
      complete: incompleteReasons.length === 0,
      incompleteReasons: Object.freeze(incompleteReasons),
      networkRequests: dependencyAdvisories.networkRequests ?? 0,
      onlineDependencyAdvisories: dependencyAdvisories.enabled,
      astAnalysis: Object.freeze({
        parser: "Acorn",
        extensions: Object.freeze([".js", ".mjs", ".cjs"]),
        parseSkips: astParseSkips,
        unsupportedFiles: astUnsupportedFiles,
        propagationLimitFiles: astPropagationLimits,
        complete: astParseSkips === 0 && astUnsupportedFiles === 0 && astPropagationLimits === 0,
        dataFlow: "intra-file variable alias tracking",
        interprocedural: false
      }),
      databaseConnections: 0,
      projectCodeExecuted: false,
      credentialContentsRead: false,
      limitations: Object.freeze([
        "Static rules are evidence-based heuristics and can produce false positives or miss vulnerabilities.",
        "This assessment does not perform authenticated penetration testing, exploit requests, or database access.",
        ...(dependencyAdvisories.enabled ? [
          "When online advisories are enabled, only exact npm package names and versions from the lockfile are sent to OSV.dev; application source files and credential contents are not transmitted.",
          ...(dependencyAdvisories.complete ? [] : ["Dependency advisory coverage is incomplete; inspect dependencyAdvisories before relying on the score."])
        ] : ["Online OSV.dev dependency lookup is disabled unless explicitly enabled."]),
        "A clean static report is not proof that the application is secure; deployment configuration and runtime controls require separate validation.",
        "AST data-flow currently covers JavaScript .js, .mjs, and .cjs files and tracks simple same-file aliases; it does not yet model cross-file or interprocedural flows, TypeScript/JSX syntax, or sanitizer semantics.",
        "Framework middleware and controls implemented in external services may not be fully visible to the analyzer."
      ])
    })
  });
}
