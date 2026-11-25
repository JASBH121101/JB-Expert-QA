#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import { parse } from "acorn";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/agent/autonomous-execution-host-bootstrap.js";
const NETWORK_BUILTINS = new Set([
  "node:http", "node:https", "node:http2", "node:net", "node:tls",
  "node:dgram", "node:dns", "node:dns/promises"
]);
const GITHUB_PACKAGE_PREFIXES = ["@actions/", "@octokit/", "@github/"];
const checks = [];
const moduleFiles = new Set();
const builtinModules = new Set();
const externalModules = new Set();
const networkModules = new Set();
const unresolvedModules = new Set();
const sourceByFile = new Map();

function addCheck(id, passed, detail) {
  checks.push(Object.freeze({ id, passed: passed === true, detail }));
}

async function collectImports(node, output) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) await collectImports(item, output);
    return;
  }
  if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration") {
    if (node.source?.type === "Literal" && typeof node.source.value === "string") {
      output.push(node.source.value);
    }
  } else if (node.type === "ImportExpression") {
    if (node.source?.type === "Literal" && typeof node.source.value === "string") {
      output.push(node.source.value);
    } else {
      unresolvedModules.add("non-literal dynamic import in " + relative(ROOT, currentFile));
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    if (value && typeof value === "object") await collectImports(value, output);
  }
}
let currentFile = ENTRY;

function resolveLocalImport(fromFile, specifier) {
  const candidate = resolve(dirname(fromFile), specifier);
  const candidates = extname(candidate)
    ? [candidate]
    : [candidate + ".js", candidate + ".mjs", resolve(candidate, "index.js")];
  return candidates.find(path => {
    const rel = relative(ROOT, path);
    return !rel.startsWith(".." + sep) && rel !== "..";
  }) ?? null;
}

async function visitModule(relativePath) {
  const filePath = resolve(ROOT, relativePath);
  const rel = relative(ROOT, filePath);
  if (rel.startsWith(".." + sep) || rel === "..") {
    unresolvedModules.add("module escapes repository root: " + relativePath);
    return;
  }
  const normalized = rel.split(sep).join("/");
  if (moduleFiles.has(normalized)) return;
  moduleFiles.add(normalized);

  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    unresolvedModules.add("missing local module: " + normalized);
    return;
  }
  sourceByFile.set(normalized, source);
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    unresolvedModules.add("parse failure in " + normalized + ": " + error.message);
    return;
  }
  const imports = [];
  currentFile = normalized;
  await collectImports(ast, imports);
  for (const specifier of imports) {
    if (isBuiltin(specifier)) {
      builtinModules.add(specifier.startsWith("node:") ? specifier : "node:" + specifier);
      continue;
    }
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const localPath = resolveLocalImport(filePath, specifier);
      if (!localPath) {
        unresolvedModules.add("unresolved relative import " + specifier + " from " + normalized);
        continue;
      }
      await visitModule(relative(ROOT, localPath));
      continue;
    }
    externalModules.add(specifier);
  }
}

function readStaticExport(source, name) {
  const pattern = new RegExp("export\\s*\\{[^}]*\\b" + name + "\\b[^}]*\\}\\s*from\\s*[\\\"']([^\\\"']+)[\\\"']", "u");
  return pattern.test(source) || new RegExp("\\b" + name + "\\b", "u").test(source);
}

async function main() {
  const rootPackage = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
  const expertPackage = JSON.parse(await readFile(resolve(ROOT, "packages/expert-qa/package.json"), "utf8"));
  const indexSource = await readFile(resolve(ROOT, "src/index.js"), "utf8");
  const expertIndexSource = await readFile(resolve(ROOT, "packages/expert-qa/src/index.js"), "utf8");
  const dashboardSource = await readFile(resolve(ROOT, "src/dashboard/server.js"), "utf8");
  const dashboardCliSource = await readFile(resolve(ROOT, "src/dashboard-cli.js"), "utf8");
  const deploymentSource = await readFile(resolve(ROOT, "src/agent/autonomous-execution-service-deployment.js"), "utf8");
  const deploymentDoc = await readFile(resolve(ROOT, "docs/PHASE5-BLOCK13-3-SERVICE-MANAGER-DEPLOYMENT-PROFILES.md"), "utf8");
  const bootstrapTests = await readFile(resolve(ROOT, "tests/autonomous-execution-host-bootstrap.test.js"), "utf8");
  const operationsTestPath = resolve(ROOT, "tests/autonomous-execution-host-operations.test.js");
  const operationsTest = await readFile(operationsTestPath, "utf8");
  const operationsDocPath = resolve(ROOT, "docs/PHASE5-BLOCK13-7-AUTONOMOUS-OPERATIONS-VALIDATION.md");
  const operationsDoc = await readFile(operationsDocPath, "utf8");
  const packageScript = rootPackage.scripts?.["test:autonomous-host-operations"];

  await visitModule(ENTRY);
  for (const specifier of externalModules) {
    if (GITHUB_PACKAGE_PREFIXES.some(prefix => specifier.startsWith(prefix)) ||
        /github|actions|octokit/iu.test(specifier)) {
      networkModules.add("GitHub/Actions runtime dependency: " + specifier);
    }
  }
  for (const builtin of builtinModules) {
    if (NETWORK_BUILTINS.has(builtin)) networkModules.add(builtin);
  }
  for (const [file, source] of sourceByFile) {
    if (/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/u.test(source)) {
      networkModules.add("network primitive reference in " + file);
    }
  }

  addCheck("node-runtime-22-or-newer",
    Number.parseInt(process.versions.node.split(".")[0], 10) >= 22,
    { current: process.versions.node, required: ">=22" });
  addCheck("repository-and-consumer-node-constraints",
    rootPackage.engines?.node === ">=22" && expertPackage.engines?.node === ">=22",
    { repository: rootPackage.engines?.node, standalonePackage: expertPackage.engines?.node });
  addCheck("host-dependency-graph-resolves",
    unresolvedModules.size === 0,
    { unresolved: [...unresolvedModules] });
  addCheck("host-dependency-graph-has-no-third-party-imports",
    externalModules.size === 0,
    { externalImports: [...externalModules] });
  addCheck("host-dependency-graph-does-not-read-github-actions-runtime-state",
    ![...sourceByFile.values()].some(source =>
      /process\.env\.(?:GITHUB_ACTIONS|CI)\b/u.test(source)),
    { requirement: "No Actions or CI environment state is required by the host module graph" });
  addCheck("host-dependency-graph-has-no-github-actions-runtime-dependency",
    ![...externalModules].some(item => GITHUB_PACKAGE_PREFIXES.some(prefix => item.startsWith(prefix)) ||
      /github|actions|octokit/iu.test(item)),
    { externalImports: [...externalModules] });
  addCheck("host-dependency-graph-has-no-network-client-primitives",
    networkModules.size === 0,
    { findings: [...networkModules] });
  addCheck("standalone-package-bootstrap-subpath",
    expertPackage.exports?.["./autonomous-execution-host-bootstrap"] === "./src/agent/autonomous-execution-host-bootstrap.js",
    { export: expertPackage.exports?.["./autonomous-execution-host-bootstrap"] ?? null });
  addCheck("repository-api-bootstrap-export",
    readStaticExport(indexSource, "createAutonomousExecutionHostBootstrap"),
    { entry: "src/index.js" });
  addCheck("standalone-package-root-bootstrap-export",
    readStaticExport(expertIndexSource, "createAutonomousExecutionHostBootstrap"),
    { entry: "packages/expert-qa/src/index.js" });
  addCheck("service-manager-profiles-are-available-but-not-installed-automatically",
    indexSource.includes("createSystemdHostServiceProfile") &&
      indexSource.includes("createWindowsHostServiceProfile") &&
      expertPackage.exports?.["./autonomous-execution-service-deployment"] === "./src/agent/autonomous-execution-service-deployment.js" &&
      deploymentSource.includes("never installs or starts a Windows service") &&
      deploymentDoc.includes("does not install, register, start, stop, enable"),
    { platforms: ["Linux systemd", "Windows SCM / WinSW v2"], provisioning: "operator-controlled" });
  addCheck("default-dashboard-cli-requires-application-bootstrap-injection",
    !dashboardCliSource.includes("phase5HostBootstrap") &&
      dashboardCliSource.includes("startDashboard({ port: options.port })"),
    { defaultState: "host controls disconnected until trusted bootstrap is injected by the application" });
  addCheck("dashboard-default-loopback-only",
    dashboardSource.includes('const DEFAULT_DASHBOARD_HOST = "127.0.0.1"') &&
      dashboardSource.includes("server.listen(port, DEFAULT_DASHBOARD_HOST)"),
    { expectedHost: "127.0.0.1" });
  addCheck("host-bootstrap-construction-is-inert-and-explicit",
    bootstrapTests.includes("bootstrap construction is inert") &&
      bootstrapTests.includes("bootstrap starts only after preflight") &&
      bootstrapTests.includes("BOOTSTRAP_NOT_ENABLED"),
    { testFile: "tests/autonomous-execution-host-bootstrap.test.js" });
  addCheck("cross-process-independence-lab-is-present",
    operationsTest.includes("process.env.GITHUB_ACTIONS") &&
      operationsTest.includes("process.env.CI") &&
      operationsTest.includes("STORE_LOCKED") &&
      operationsTest.includes("verify-restart") &&
      packageScript === "node --test tests/autonomous-execution-host-operations.test.js",
    { testFile: "tests/autonomous-execution-host-operations.test.js", script: packageScript ?? null });
  addCheck("cross-process-independence-lab-is-documented",
    operationsDoc.includes("without relying on GitHub Actions") &&
      operationsDoc.includes("real operating-system process restart") &&
      operationsDoc.includes("Node.js 22 or newer"),
    { doc: "docs/PHASE5-BLOCK13-7-AUTONOMOUS-OPERATIONS-VALIDATION.md" });

  const sortedBuiltins = [...builtinModules].sort();
  const sortedFiles = [...moduleFiles].sort();
  const passed = checks.every(check => check.passed);
  const report = {
    schema: "jb.expert-qa.autonomous-independence-certificate/v1",
    generatedAt: new Date().toISOString(),
    sourceRevision: process.env.GITHUB_SHA ?? null,
    result: passed ? "passed" : "failed",
    score: { passed: checks.filter(check => check.passed).length, total: checks.length },
    scope: {
      runtime: "single-process local Node.js host",
      githubActionsRole: "repository CI only; not a host runtime or execution coordinator",
      remoteQueueRequired: false,
      cloudSchedulerRequired: false,
      paidApiRequiredByHostCore: false,
      dashboardRequiresApplicationBootstrapInjection: true,
      serviceManagerProvisioning: "optional and operator-controlled",
      productionOrchestratorAndApprovalProviderRequired: true,
      configuredEnginesMayRequireNetwork: true,
      multiHostOrDistributedExecutionCertified: false,
      productionOrchestratorAndApprovalProviderCertified: false
    },
    hostDependencyGraph: {
      entry: ENTRY,
      localModuleCount: sortedFiles.length,
      localModules: sortedFiles,
      nodeBuiltins: sortedBuiltins,
      thirdPartyModules: [...externalModules].sort(),
      networkFindings: [...networkModules].sort()
    },
    checks
  };

  const outputArgument = process.argv.slice(2).find(value => value.startsWith("--output="));
  if (process.argv.slice(2).some(value => value !== outputArgument)) {
    throw new Error("Only --output=<path> is supported");
  }
  const json = JSON.stringify(report, null, 2) + "\n";
  if (outputArgument) {
    const outputPath = resolve(process.cwd(), outputArgument.slice("--output=".length));
    await writeFile(outputPath, json, { encoding: "utf8", mode: 0o600 });
  }
  process.stdout.write(json);
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : "Autonomous independence certification failed") + "\n");
  process.exitCode = 1;
});
