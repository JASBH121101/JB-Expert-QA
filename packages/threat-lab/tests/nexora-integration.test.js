import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createThreatLab } from "../src/index.js";

const catalogRoot = process.env.NEXORA_CATALOG_ROOT;
const siteRoot = process.env.NEXORA_SITE_ENGINE_ROOT;
const enabled = Boolean(catalogRoot && siteRoot);
const safety = Object.freeze({ safe: true, network: false, destructive: false, executesSample: false });
const TEST_ENV = {
  APP_ENV: "testing",
  APP_KEY: "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  DB_CONNECTION: "sqlite",
  DB_DATABASE: ":memory:",
  DB_URL: "",
  CACHE_STORE: "array",
  MAIL_MAILER: "array",
  QUEUE_CONNECTION: "sync",
  SESSION_DRIVER: "array",
  SESSION_ENCRYPT: "false"
};

function nodeTestFiles(root, names) {
  const directory = path.join(root, "demo", "tests");
  if (!existsSync(directory)) throw new Error("NEXORA demo test directory is missing: " + directory);
  const available = new Set(readdirSync(directory));
  const missing = names.filter((name) => !available.has(name));
  if (missing.length > 0) throw new Error("NEXORA demo tests are missing: " + missing.join(", "));
  return names.map((name) => path.join("demo", "tests", name));
}

function executeCommands(root, scenario, commands) {
  if (!root || !existsSync(root)) {
    return {
      status: "fail",
      summary: "The pinned NEXORA checkout was not found for this target.",
      findings: [{ code: "NEXORA_CHECKOUT_MISSING", target: scenario.target }],
      metrics: { target: scenario.target, commandsExecuted: 0 }
    };
  }

  let testsExecuted = 0;
  let assertions = 0;
  const commandMetrics = [];

  for (const command of commands) {
    const startedAt = Date.now();
    const result = spawnSync(command.executable, command.args, {
      cwd: root,
      env: { ...process.env, ...TEST_ENV },
      encoding: "utf8",
      timeout: command.timeoutMs ?? 300000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    });
    const durationMs = Date.now() - startedAt;
    const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
    const phpCount = output.match(/Tests:\s*(\d+)\s+passed/i);
    const nodeCount = output.match(/(?:ℹ|#)\s*tests\s+(\d+)/i);
    const assertionCount = output.match(/\((\d+)\s+assertions?\)/i);
    testsExecuted += Number(phpCount?.[1] ?? nodeCount?.[1] ?? 0);
    assertions += Number(assertionCount?.[1] ?? 0);
    commandMetrics.push({
      command: command.label,
      exitCode: result.status,
      signal: result.signal ?? null,
      durationMs
    });

    if (result.error || result.status !== 0) {
      const outputTail = output.split("\n").slice(-35).join("\n").slice(-2200);
      return {
        status: "fail",
        summary: command.label + " failed in the isolated NEXORA checkout.",
        findings: [{
          code: "NEXORA_LOCAL_TEST_FAILED",
          target: scenario.target,
          scenario: scenario.id,
          command: command.label,
          exitCode: result.status,
          signal: result.signal ?? null,
          outputTail
        }],
        metrics: { target: scenario.target, testsExecuted, assertions, commandMetrics }
      };
    }
  }

  return {
    status: "pass",
    summary: commands.map((command) => command.label).join(" + ") + " passed in the isolated NEXORA checkout.",
    findings: [],
    metrics: {
      target: scenario.target,
      testsExecuted,
      assertions,
      commandMetrics,
      networkRequests: 0,
      productionMutations: 0
    }
  };
}

const catalogCommands = {
  "nexora.catalog.demo-baseline": (root) => [{
    label: "NEXORA demo public/admin contract tests",
    executable: process.execPath,
    args: ["--test", ...nodeTestFiles(root, ["admin-responsive.test.js", "catalog-data.test.js", "store.test.js"])]
  }],
  "nexora.catalog.dynamic-schema-privacy": (root) => [{
    label: "NEXORA dynamic schema, units and privacy contract tests",
    executable: process.execPath,
    args: ["--test", ...nodeTestFiles(root, ["setup-contract.test.js"])]
  }],
  "nexora.catalog.setup-template-persistence": () => [{
    label: "NEXORA Laravel setup/template persistence feature tests",
    executable: "php",
    args: ["artisan", "test", "--filter=SetupHealthTest"]
  }]
};

const siteCommands = {
  "nexora.site.publication-boundaries": () => [{
    label: "NEXORA published-only public Site Engine tests",
    executable: "php",
    args: ["artisan", "test", "--filter=PublicSiteEngineTest"]
  }],
  "nexora.site.domain-input-validation": () => [{
    label: "NEXORA custom-domain input validation test",
    executable: "php",
    args: ["artisan", "test", "--filter=test_invalid_hostnames_are_rejected"]
  }],
  "nexora.site.permission-boundaries": () => [{
    label: "NEXORA Permission Engine feature tests",
    executable: "php",
    args: ["artisan", "test", "--filter=PermissionEngineTest"]
  }],
  "nexora.site.export-and-inventory-authorization": () => [
    { label: "NEXORA Export Engine feature tests", executable: "php", args: ["artisan", "test", "--filter=ExportEngineTest"] },
    { label: "NEXORA basic inventory least-privilege tests", executable: "php", args: ["artisan", "test", "--filter=InventoryAssistantTest"] }
  ],
  "nexora.site.domain-dns-tls-chain": () => [
    { label: "NEXORA fake DNS/TLS ownership and readiness tests", executable: "php", args: ["artisan", "test", "--filter=SiteDomainControllerTest"] },
    { label: "NEXORA published-domain and canonical-host middleware tests", executable: "php", args: ["artisan", "test", "--filter=PublishedDomainMiddlewareTest"] }
  ],
  "nexora.site.full-regression": () => [{
    label: "NEXORA complete Laravel feature regression suite",
    executable: "php",
    args: ["artisan", "test"],
    timeoutMs: 600000
  }]
};

const lab = createThreatLab();
lab.registerTarget({
  id: "nexora-configurable-catalog",
  kind: "configurable-catalog-application",
  version: "feature/nexora-configurable-catalog@88c4876c9678b93dadde55f79fe9d04890900741",
  capabilities: ["industry-templates", "dynamic-fields", "measurement-units", "demo-ui", "setup-installer"],
  adapter: {
    async runScenario({ scenario, context }) {
      const factory = catalogCommands[scenario.id];
      if (!factory) return { status: "skip", summary: "No Configurable Catalog adapter is registered for this scenario." };
      return executeCommands(catalogRoot, { ...scenario, target: context.targetId }, factory(catalogRoot));
    }
  }
});
lab.registerTarget({
  id: "nexora-site-engine",
  kind: "laravel-public-site-engine",
  version: "docs/nexora-approved-upgrades-2026-11@3f68126ecc58b088c071007c5116bc95426d159b",
  capabilities: ["public-catalog", "owner-permissions", "exports", "basic-inventory", "domain-dns-tls"],
  adapter: {
    async runScenario({ scenario, context }) {
      const factory = siteCommands[scenario.id];
      if (!factory) return { status: "skip", summary: "No Site Engine adapter is registered for this scenario." };
      return executeCommands(siteRoot, { ...scenario, target: context.targetId }, factory(siteRoot));
    }
  }
});

const catalogScenarios = [
  ["nexora.catalog.demo-baseline", "basic", "Run real public/admin demo contract tests without treating localStorage as server persistence."],
  ["nexora.catalog.dynamic-schema-privacy", "intermediate", "Validate editable field schema, dimensional units, responsive layout and demo privacy tests."],
  ["nexora.catalog.setup-template-persistence", "advanced", "Exercise Laravel setup/template persistence feature tests on an in-memory SQLite database."]
];
const siteScenarios = [
  ["nexora.site.publication-boundaries", "basic", "Verify published-only public catalog, public fields, price formatting and product metadata."],
  ["nexora.site.domain-input-validation", "intermediate", "Reject malformed custom-domain hostnames before they enter installation configuration."],
  ["nexora.site.permission-boundaries", "advanced", "Verify role, action and field-level authorization with default-deny controls."],
  ["nexora.site.export-and-inventory-authorization", "expert", "Verify export permissions and least-privilege access to informational inventory quantities."],
  ["nexora.site.domain-dns-tls-chain", "extreme", "Exercise ownership TXT and fake DNS/TLS readiness plus published-domain middleware without public network calls."],
  ["nexora.site.full-regression", "superextreme", "Run the complete Laravel feature suite as a final compound-regression gate."]
];
for (const [id, difficulty, description] of catalogScenarios) {
  lab.registerScenario({ id, difficulty, category: "nexora-configurable-catalog", description, appliesTo: ["nexora-configurable-catalog"], safety });
}
for (const [id, difficulty, description] of siteScenarios) {
  lab.registerScenario({ id, difficulty, category: "nexora-site-engine", description, appliesTo: ["nexora-site-engine"], safety });
}

test("NEXORA Configurable Catalog and Site Engine run as separate real-product targets", {
  skip: !enabled && "Set NEXORA_CATALOG_ROOT and NEXORA_SITE_ENGINE_ROOT in the dedicated integration workflow."
}, async () => {
  assert.ok(existsSync(catalogRoot), "Configurable Catalog checkout must exist.");
  assert.ok(existsSync(siteRoot), "Site Engine checkout must exist.");

  const report = await lab.run({
    targetIds: ["nexora-configurable-catalog", "nexora-site-engine"],
    metadata: {
      profile: "nexora-real-product-integration",
      catalogCommit: "88c4876c9678b93dadde55f79fe9d04890900741",
      siteEngineCommit: "3f68126ecc58b088c071007c5116bc95426d159b",
      networkRequests: 0,
      productionMutations: 0
    }
  });

  console.log("[NEXORA adapter results]", JSON.stringify(report.results.map((result) => ({
    target: result.target.id,
    scenario: result.scenario.id,
    status: result.status,
    summary: result.summary,
    findingCodes: (result.findings ?? []).map((finding) => finding.code),
    commandMetrics: result.metrics?.commandMetrics ?? []
  }))));

  assert.deepEqual(report.totals, { pass: 9, fail: 0, skip: 9 });
  assert.equal(report.results.filter((result) => result.skipReason === "target_scope").length, 9);

  const catalog = report.assessment.targets.find((item) => item.target.id === "nexora-configurable-catalog");
  const site = report.assessment.targets.find((item) => item.target.id === "nexora-site-engine");
  assert.ok(catalog, "The Configurable Catalog target must have an independent assessment.");
  assert.ok(site, "The Site Engine target must have an independent assessment.");

  assert.deepEqual(catalog.coveredLevels, ["basic", "intermediate", "advanced"]);
  assert.deepEqual(catalog.missingLevels, ["expert", "extreme", "superextreme"]);
  assert.equal(catalog.ready, false, "The Configurable Catalog must remain uncertified above Advanced.");

  assert.deepEqual(site.coveredLevels, ["basic", "intermediate", "advanced", "expert", "extreme", "superextreme"]);
  assert.deepEqual(site.missingLevels, []);
  assert.equal(site.ready, true, "The Site Engine is ready only for the registered six-tier scenario suite.");

  console.log("[NEXORA Threat Lab]", JSON.stringify({
    totals: report.totals,
    targets: report.assessment.targets.map((item) => ({
      id: item.target.id,
      coveredLevels: item.coveredLevels,
      missingLevels: item.missingLevels,
      ready: item.ready
    }))
  }));
});
