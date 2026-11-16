import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createThreatLab } from "../src/index.js";

const CATALOG_ROOT = process.env.NEXORA_CATALOG_ROOT ?? "";
const SITE_ROOT = process.env.NEXORA_SITE_ENGINE_ROOT ?? "";
const CATALOG_SHA = process.env.NEXORA_CATALOG_SHA ?? "";
const SITE_SHA = process.env.NEXORA_SITE_ENGINE_SHA ?? "";

const EXPECTED_CATALOG_SHA = "88c4876c9678b93dadde55f79fe9d04890900741";
const EXPECTED_SITE_SHA = "3f68126ecc58b088c071007c5116bc95426d159b";

const profileEnvironmentReady =
  CATALOG_ROOT !== ""
  && SITE_ROOT !== ""
  && existsSync(path.join(CATALOG_ROOT, "demo", "tests"))
  && existsSync(path.join(SITE_ROOT, "vendor", "bin", "phpunit"));

const safety = Object.freeze({
  safe: true,
  network: false,
  destructive: false,
  executesSample: false
});

const MAX_OUTPUT = 1600;

function commandOutcome(commands, cwd, timeoutMs = 180_000) {
  const completed = [];
  for (const command of commands) {
    const result = spawnSync(command.binary, command.args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    completed.push({
      command: [command.binary, ...command.args].join(" "),
      exitCode: result.status,
      signal: result.signal ?? null,
      error: result.error?.message ?? null,
      outputTail: output.slice(-MAX_OUTPUT)
    });
    if (result.error || result.status !== 0) {
      return {
        status: "fail",
        summary: "Pinned NEXORA profile command failed",
        metrics: { commandsRun: completed, networkRequests: 0, cwd },
        findings: [{
          code: "NEXORA_PROFILE_COMMAND_FAILED",
          message: result.error?.message ?? ("Exit code " + result.status)
        }]
      };
    }
  }
  return {
    status: "pass",
    summary: "Pinned NEXORA profile checks completed successfully",
    metrics: {
      commandsRun: completed.map(({ command, exitCode }) => ({ command, exitCode })),
      commandCount: completed.length,
      networkRequests: 0,
      cwd
    },
    findings: []
  };
}

function runCatalogScenario(scenario) {
  const testsDirectory = path.join(CATALOG_ROOT, "demo", "tests");
  const allTestFiles = readdirSync(testsDirectory)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join("demo", "tests", name));

  const plans = {
    "nexora.catalog.basic.data-integrity": [
      { binary: process.execPath, args: ["--test", "demo/tests/catalog-data.test.js"] }
    ],
    "nexora.catalog.intermediate.setup-contract": [
      { binary: process.execPath, args: ["--test", "demo/tests/setup-contract.test.js"] }
    ],
    "nexora.catalog.advanced.local-storage-contract": [
      { binary: process.execPath, args: ["--test", "demo/tests/store.test.js"] }
    ],
    "nexora.catalog.expert.responsive-admin": [
      { binary: process.execPath, args: ["--test", "demo/tests/admin-responsive.test.js"] }
    ],
    "nexora.catalog.extreme.full-demo-regression": [
      { binary: process.execPath, args: ["--test", ...allTestFiles] }
    ],
    "nexora.catalog.superextreme.prototype-boundaries": [
      { binary: process.execPath, args: ["--test", ...allTestFiles] }
    ]
  };

  const commands = plans[scenario.id];
  if (!commands) {
    return { status: "skip", summary: "No catalog prototype handler exists for this scenario", metrics: {}, findings: [] };
  }

  const result = commandOutcome(commands, CATALOG_ROOT);
  if (result.status !== "pass" || scenario.id !== "nexora.catalog.superextreme.prototype-boundaries") {
    return result;
  }

  const setupHtml = readFileSync(path.join(CATALOG_ROOT, "demo", "setup.html"), "utf8");
  const setupJs = readFileSync(path.join(CATALOG_ROOT, "demo", "assets", "js", "setup.js"), "utf8");
  const safetyChecks = {
    noRealPasswordField: !/type=["']password["']/i.test(setupHtml),
    explicitlyDemoOnly: setupJs.includes('mode:"demo-local-only"'),
    browserLocalStorageOnly: setupJs.includes("localStorage.setItem(STORE_KEY")
  };
  const passed = Object.values(safetyChecks).every(Boolean);

  return {
    status: passed ? "pass" : "fail",
    summary: passed
      ? "Full demo suite passed and the prototype boundary remains explicit: localStorage only, no real password collection"
      : "The catalog prototype exceeded its documented demo-only boundary",
    metrics: { ...result.metrics, safetyChecks, networkRequests: 0 },
    findings: passed ? [] : [{
      code: "NEXORA_CATALOG_PROTOTYPE_BOUNDARY_MISMATCH",
      safetyChecks
    }]
  };
}

function runSiteEngineScenario(scenario) {
  const plans = {
    "nexora.site.basic.owner-installation": [
      {
        binary: "php",
        args: [
          "vendor/bin/phpunit",
          "--filter",
          "test_setup_creates_one_owner_and_seeds_the_selected_template_atomically",
          "tests/Feature/SetupHealthTest.php"
        ]
      }
    ],
    "nexora.site.intermediate.public-catalogue": [
      { binary: "php", args: ["vendor/bin/phpunit", "tests/Feature/PublicSiteEngineTest.php"] }
    ],
    "nexora.site.advanced.permission-isolation": [
      { binary: "php", args: ["vendor/bin/phpunit", "tests/Feature/PermissionEngineTest.php"] }
    ],
    "nexora.site.expert.export-authorization": [
      { binary: "php", args: ["vendor/bin/phpunit", "tests/Feature/ExportEngineTest.php"] }
    ],
    "nexora.site.extreme.domain-and-tls-boundaries": [
      { binary: "php", args: ["vendor/bin/phpunit", "tests/Feature/SiteDomainControllerTest.php"] },
      { binary: "php", args: ["vendor/bin/phpunit", "tests/Feature/PublishedDomainMiddlewareTest.php"] }
    ],
    "nexora.site.superextreme.full-feature-and-unit-suite": [
      { binary: "php", args: ["vendor/bin/phpunit"] }
    ]
  };

  const commands = plans[scenario.id];
  if (!commands) {
    return { status: "skip", summary: "No Laravel Site Engine handler exists for this scenario", metrics: {}, findings: [] };
  }
  const timeout = scenario.id.endsWith("superextreme.full-feature-and-unit-suite") ? 300_000 : 180_000;
  return commandOutcome(commands, SITE_ROOT, timeout);
}

test("Threat Lab certifies NEXORA Catalog prototype and Laravel Site Engine independently", {
  skip: profileEnvironmentReady ? false : "Dedicated NEXORA profile CI environment is not configured"
}, async () => {
  assert.equal(CATALOG_SHA, EXPECTED_CATALOG_SHA, "catalog source pin changed; update this test and its CI checkout together");
  assert.equal(SITE_SHA, EXPECTED_SITE_SHA, "Site Engine source pin changed; update this test and its CI checkout together");

  const lab = createThreatLab({ name: "JB Threat Lab — NEXORA Profiles", version: "0.3.0" });
  lab.registerTarget({
    id: "nexora-configurable-catalog",
    kind: "frontend-catalog-prototype",
    version: CATALOG_SHA,
    capabilities: ["editable-templates", "product-data-contract", "local-storage-demo", "responsive-preview"],
    adapter: { async runScenario({ scenario }) { return runCatalogScenario(scenario); } }
  });
  lab.registerTarget({
    id: "nexora-site-engine",
    kind: "laravel-catalog-application",
    version: SITE_SHA,
    capabilities: ["owner-installation", "published-site", "authorization", "exports", "verified-domain-boundary"],
    adapter: { async runScenario({ scenario }) { return runSiteEngineScenario(scenario); } }
  });

  const catalogScenarios = [
    ["nexora.catalog.basic.data-integrity", "basic", "Validate the prototype's business and product fixture integrity."],
    ["nexora.catalog.intermediate.setup-contract", "intermediate", "Validate wizard, editable templates, unit dimensions, field visibility and demo-only setup constraints."],
    ["nexora.catalog.advanced.local-storage-contract", "advanced", "Validate browser storage isolation, HTML escaping and WhatsApp link normalization."],
    ["nexora.catalog.expert.responsive-admin", "expert", "Validate constrained and responsive admin layout behavior."],
    ["nexora.catalog.extreme.full-demo-regression", "extreme", "Run all prototype demo suites together as a cross-file regression."],
    ["nexora.catalog.superextreme.prototype-boundaries", "superextreme", "Run the full demo suite and verify the prototype does not collect real passwords or claim server persistence."]
  ];
  for (const [id, difficulty, description] of catalogScenarios) {
    lab.registerScenario({
      id, category: "nexora-catalog-prototype", description, difficulty,
      appliesTo: ["nexora-configurable-catalog"], safety,
      tags: ["pinned-source", "offline", "prototype-boundary"]
    });
  }

  const siteScenarios = [
    ["nexora.site.basic.owner-installation", "basic", "Verify atomic installation creates one authenticated owner and seeds the selected template."],
    ["nexora.site.intermediate.public-catalogue", "intermediate", "Verify published-only catalogue, public product details, private-field exclusion and sitemap behavior."],
    ["nexora.site.advanced.permission-isolation", "advanced", "Verify role permissions, explicit overrides, unknown identifiers and inactive-user denial."],
    ["nexora.site.expert.export-authorization", "expert", "Verify export field visibility and independent create/download authorization."],
    ["nexora.site.extreme.domain-and-tls-boundaries", "extreme", "Verify owner-only domain management, DNS TXT/TLS behavior through deterministic fakes and published-host enforcement."],
    ["nexora.site.superextreme.full-feature-and-unit-suite", "superextreme", "Run the complete Laravel Feature and Unit suite against in-memory SQLite."]
  ];
  for (const [id, difficulty, description] of siteScenarios) {
    lab.registerScenario({
      id, category: "nexora-laravel-site-engine", description, difficulty,
      appliesTo: ["nexora-site-engine"], safety,
      tags: ["pinned-source", "offline", "disposable-database", "fake-dns-tls"]
    });
  }

  const catalogReport = await lab.run({
    targetIds: ["nexora-configurable-catalog"],
    scenarioIds: catalogScenarios.map(([id]) => id),
    metadata: {
      source: "JASBH121101/Nexora",
      ref: "feature/nexora-configurable-catalog",
      sha: CATALOG_SHA,
      profile: "frontend-prototype",
      networkRequests: 0
    }
  });
  const siteReport = await lab.run({
    targetIds: ["nexora-site-engine"],
    scenarioIds: siteScenarios.map(([id]) => id),
    metadata: {
      source: "JASBH121101/Nexora",
      ref: "docs/nexora-approved-upgrades-2026-11",
      sha: SITE_SHA,
      profile: "laravel-site-engine",
      database: "sqlite-memory",
      dnsTls: "deterministic-fakes",
      networkRequests: 0
    }
  });

  assert.deepEqual(catalogReport.totals, { pass: 6, fail: 0, skip: 0 });
  assert.equal(catalogReport.assessment.targets[0].ready, true);
  assert.deepEqual(catalogReport.assessment.targets[0].coveredLevels, [
    "basic", "intermediate", "advanced", "expert", "extreme", "superextreme"
  ]);

  assert.deepEqual(siteReport.totals, { pass: 6, fail: 0, skip: 0 });
  assert.equal(siteReport.assessment.targets[0].ready, true);
  assert.deepEqual(siteReport.assessment.targets[0].coveredLevels, [
    "basic", "intermediate", "advanced", "expert", "extreme", "superextreme"
  ]);
});
