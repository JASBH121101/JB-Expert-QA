import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createThreatLab } from "../src/index.js";

const CATALOG_ROOT = process.env.NEXORA_CATALOG_ROOT ?? "";
const SITE_ROOT = process.env.NEXORA_SITE_ENGINE_ROOT ?? "";
const CATALOG_SHA = process.env.NEXORA_CATALOG_SHA ?? "";
const SITE_SHA = process.env.NEXORA_SITE_ENGINE_SHA ?? "";

const EXPECTED_CATALOG_SHA = "b546c2c64dffd311770ac455867fe5dd3e245138";
const EXPECTED_SITE_SHA = "b546c2c64dffd311770ac455867fe5dd3e245138";

const profileEnvironmentReady =
  CATALOG_ROOT !== ""
  && SITE_ROOT !== ""
  && existsSync(path.join(CATALOG_ROOT, "demo", "tests"))
  && existsSync(path.join(SITE_ROOT, "vendor", "bin", "phpunit"));
const profileRequired = process.env.NEXORA_PROFILE_REQUIRED === "true";

function assertPinnedCheckout(root, expectedSha, label) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  });
  assert.equal(result.error, undefined, label + " checkout revision could not be read");
  assert.equal(result.status, 0, label + " checkout revision command failed");
  assert.equal(
    result.stdout.trim(),
    expectedSha,
    label + " checkout HEAD does not match the declared source pin"
  );
}

const safety = Object.freeze({
  safe: true,
  network: false,
  destructive: false,
  executesSample: false
});

const MAX_OUTPUT = 1600;
const REPORT_DIR = process.env.NEXORA_REPORT_DIR ?? "";

function commandOutcome(commands, cwd, timeoutMs = 180_000) {
  const completed = [];
  for (const command of commands) {
    const result = spawnSync(command.binary, command.args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      // Product code under test receives only an explicit disposable test
      // environment. CI tokens, Composer credentials and GitHub headers are
      // deliberately not forwarded to child processes.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
        TMP: process.env.TMP ?? "",
        TEMP: process.env.TEMP ?? "",
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        APP_ENV: "testing",
        APP_KEY: "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        BCRYPT_ROUNDS: "4",
        CACHE_STORE: "array",
        DB_CONNECTION: "sqlite",
        DB_DATABASE: ":memory:",
        DB_URL: "",
        MAIL_MAILER: "array",
        QUEUE_CONNECTION: "sync",
        SESSION_DRIVER: "array",
        SESSION_ENCRYPT: "false"
      }
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
    "nexora.site.advanced.currency-precision": [
      { binary: "php", args: ["vendor/bin/phpunit", "tests/Unit/Library/CurrencyCatalogTest.php"] }
    ],
    "nexora.site.advanced.language-and-country-catalogs": [
      { binary: "php", args: ["vendor/bin/phpunit", "tests/Unit/Library/LibraryCatalogTest.php"] }
    ],
    "nexora.site.expert.export-authorization": [
      { binary: "php", args: ["vendor/bin/phpunit", "tests/Feature/ExportEngineTest.php"] }
    ],
    "nexora.site.expert.private-image-pipeline": [
      { binary: "php", args: ["vendor/bin/phpunit", "tests/Feature/ProductImageSecurityTest.php"] }
    ],
    "nexora.site.expert.mfa-totp-security": [
      { binary: "php", args: ["vendor/bin/phpunit", "tests/Feature/MfaTotpSecurityTest.php"] }
    ],
    "nexora.site.expert.active-session-revocation": [
      { binary: "php", args: ["vendor/bin/phpunit", "tests/Feature/UserSessionManagementTest.php"] }
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
  const timeout = scenario.id.endsWith("superextreme.full-feature-and-unit-suite") ? 360_000 : 180_000;
  return commandOutcome(commands, SITE_ROOT, timeout);
}

test("Threat Lab certifies current-main NEXORA Catalog and Site Engine including currency, locale, private images, MFA and session revocation", {
  skip: !profileEnvironmentReady && !profileRequired
    ? "Dedicated NEXORA profile CI environment is not configured"
    : false
}, async () => {
  assert.ok(profileEnvironmentReady, "Required NEXORA checkouts and installed Site Engine dependencies must exist");
  assert.equal(CATALOG_SHA, EXPECTED_CATALOG_SHA, "catalog source pin changed; update this test and its CI checkout together");
  assert.equal(SITE_SHA, EXPECTED_SITE_SHA, "Site Engine source pin changed; update this test and its CI checkout together");
  assertPinnedCheckout(CATALOG_ROOT, CATALOG_SHA, "NEXORA Configurable Catalog");
  assertPinnedCheckout(SITE_ROOT, SITE_SHA, "NEXORA Site Engine");

  const lab = createThreatLab({ name: "JB Threat Lab — NEXORA Profiles", version: "0.4.0" });
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
    capabilities: ["owner-installation", "published-site", "authorization", "exports", "verified-domain-boundary", "private-media", "mfa-totp", "active-session-revocation", "currency-catalog", "locale-catalog"],
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
    ["nexora.site.advanced.currency-precision", "advanced", "Verify ISO-style currency metadata, currency-specific precision, exact decimal validation and locale formatting."],
    ["nexora.site.advanced.language-and-country-catalogs", "advanced", "Verify locale, country, currency and calling-code catalog integrity and stable identifiers."],
    ["nexora.site.expert.export-authorization", "expert", "Verify export field visibility and independent create/download authorization."],
    ["nexora.site.expert.private-image-pipeline", "expert", "Verify raster re-encoding, private quarantine/storage, published-only delivery and field-level admin authorization."],
    ["nexora.site.expert.mfa-totp-security", "expert", "Verify encrypted TOTP enrollment, login challenge, replay rejection, one-time recovery codes and protected disable flow."],
    ["nexora.site.expert.active-session-revocation", "expert", "Verify owner-only active-session listing and individual revocation, current/revoked/expired session denial, tombstone protection and employee access denial."],
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
      ref: "main",
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
      ref: "main",
      sha: SITE_SHA,
      profile: "laravel-site-engine",
      database: "sqlite-memory",
      dnsTls: "deterministic-fakes",
      networkRequests: 0,
      explicitlyCovered: ["currency", "locale", "private-image", "mfa-totp"]
    }
  });
  if (REPORT_DIR) {
    mkdirSync(REPORT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(REPORT_DIR, "nexora-configurable-catalog-report.json"), JSON.stringify(catalogReport, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(path.join(REPORT_DIR, "nexora-site-engine-report.json"), JSON.stringify(siteReport, null, 2) + "\n", { mode: 0o600 });
  }

  assert.deepEqual(catalogReport.totals, { pass: 6, fail: 0, skip: 0 });
  assert.equal(catalogReport.assessment.targets[0].ready, true);
  assert.deepEqual(catalogReport.assessment.targets[0].coveredLevels, [
    "basic", "intermediate", "advanced", "expert", "extreme", "superextreme"
  ]);

  assert.deepEqual(siteReport.totals, { pass: 11, fail: 0, skip: 0 });
  assert.equal(siteReport.assessment.targets[0].ready, true);
  assert.equal(siteScenarios.length, 11);
  assert.deepEqual(siteReport.assessment.targets[0].coveredLevels, [
    "basic", "intermediate", "advanced", "expert", "extreme", "superextreme"
  ]);
});
