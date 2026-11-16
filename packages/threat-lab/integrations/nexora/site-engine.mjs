import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createThreatLab, THREAT_LAB_REPORT_SCHEMA } from "../../src/index.js";

const targetRoot = resolve(process.env.NEXORA_SITE_ENGINE_ROOT ?? "");
const targetSha = process.env.NEXORA_SITE_ENGINE_SHA ?? "branch-head";
const phpBinary = process.env.PHP_BINARY ?? "php";
const safety = {
  safe: true,
  network: false,
  destructive: false,
  executesSample: false
};

const scenarios = [
  {
    id: "nexora.site.setup.preflight",
    category: "installation-safety",
    description: "Validate the Laravel setup preflight and server requirement diagnostics.",
    difficulty: "basic",
    filter: "test_setup_page_displays_server_preflight_checks",
    timeoutMs: 120000
  },
  {
    id: "nexora.site.setup.single-installation",
    category: "installation-integrity",
    description: "Prevent a second setup attempt from creating another owner or replacing the active installation.",
    difficulty: "intermediate",
    filter: "test_second_setup_attempt_cannot_create_another_owner",
    timeoutMs: 120000
  },
  {
    id: "nexora.site.authorization.unknown-deny",
    category: "authorization-boundaries",
    description: "Deny unknown permission and field identifiers even when an employee override tries to allow them.",
    difficulty: "advanced",
    filter: "test_unknown_permission_and_field_identifiers_are_denied_even_with_overrides",
    timeoutMs: 120000
  },
  {
    id: "nexora.site.authorization.field-preservation",
    category: "authorization-and-data-integrity",
    description: "Prevent an employee from reading or editing protected fields and preserve their stored values during an otherwise valid product update.",
    difficulty: "expert",
    filter: "test_employee_cannot_read_or_edit_denied_product_fields_and_update_preserves_them",
    timeoutMs: 180000
  },
  {
    id: "nexora.site.exports.private-price-boundary",
    category: "export-security",
    description: "Reject an export that attempts to include prices hidden by the employee role, without recording a completed export.",
    difficulty: "extreme",
    filter: "test_export_employee_cannot_include_prices_when_the_role_denies_price_visibility",
    timeoutMs: 180000
  },
  {
    id: "nexora.site.full-local-regression",
    category: "compound-regression",
    description: "Run the complete isolated Laravel feature and unit suite across setup, permissions, catalogue visibility, inventory boundaries, export controls, and library invariants.",
    difficulty: "superextreme",
    filter: null,
    timeoutMs: 360000
  }
];

function runPhpTest(filter, timeoutMs) {
  const started = Date.now();
  const args = ["artisan", "test"];
  if (filter) args.push("--filter", filter);

  const result = spawnSync(phpBinary, args, {
    cwd: targetRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 5 * 1024 * 1024,
    env: {
      ...process.env,
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

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  const passed = !result.error && result.status === 0;

  return {
    status: passed ? "pass" : "fail",
    summary: passed
      ? (filter ? filter : "Full Laravel suite") + " passed with an ephemeral SQLite database."
      : (filter ? filter : "Full Laravel suite") + " failed with an ephemeral SQLite database.",
    findings: passed ? [] : [{
      code: "NEXORA_SITE_ENGINE_PHPUNIT_FAILED",
      message: String(result.error?.message ?? output.slice(-1600) ?? "PHP test process failed")
    }],
    metrics: {
      testFilter: filter ?? "full-suite",
      exitCode: result.status,
      durationMs: Date.now() - started,
      database: "sqlite-memory",
      localProcess: true
    }
  };
}

test("Threat Lab validates NEXORA Site Engine through six real Laravel test scenarios", async () => {
  assert.ok(process.env.NEXORA_SITE_ENGINE_ROOT, "NEXORA_SITE_ENGINE_ROOT is required");
  assert.ok(existsSync(join(targetRoot, "artisan")), "NEXORA Laravel artisan entry point is missing");
  assert.ok(existsSync(join(targetRoot, "vendor/autoload.php")), "Composer dependencies have not been installed");
  for (const file of [
    "tests/Feature/SetupHealthTest.php",
    "tests/Feature/PermissionEngineTest.php",
    "tests/Feature/ExportEngineTest.php",
    "tests/Feature/PublicSiteEngineTest.php",
    "phpunit.xml"
  ]) {
    assert.ok(existsSync(join(targetRoot, file)), "Missing NEXORA Site Engine test fixture: " + file);
  }

  const phpunitConfig = readFileSync(join(targetRoot, "phpunit.xml"), "utf8");
  assert.match(phpunitConfig, /name="DB_CONNECTION" value="sqlite"/);
  assert.match(phpunitConfig, /name="DB_DATABASE" value=":memory:"/);

  const lab = createThreatLab({ name: "NEXORA Site Engine Lab", version: "1.0.0" });
  lab.registerTarget({
    id: "nexora-site-engine",
    kind: "laravel-site-engine",
    version: targetSha,
    capabilities: ["owner-setup", "role-permissions", "public-catalogue", "exports", "isolated-database"],
    adapter: {
      async runScenario({ scenario }) {
        const selected = scenarios.find((item) => item.id === scenario.id);
        if (!selected) return { status: "skip", summary: "No Laravel test is mapped to this scenario." };
        return runPhpTest(selected.filter, selected.timeoutMs);
      }
    }
  });

  for (const scenario of scenarios) {
    lab.registerScenario({
      id: scenario.id,
      category: scenario.category,
      description: scenario.description,
      difficulty: scenario.difficulty,
      appliesTo: ["nexora-site-engine"],
      safety
    });
  }

  const report = await lab.run({
    targetIds: ["nexora-site-engine"],
    scenarioIds: scenarios.map((scenario) => scenario.id),
    difficulty: "superextreme",
    metadata: {
      profile: "nexora-laravel-site-engine",
      checkoutRef: "feature/nexora-site-engine-certification",
      database: "sqlite-memory",
      externalNetwork: false,
      productionMutation: false
    }
  });

  assert.equal(report.schema, THREAT_LAB_REPORT_SCHEMA);
  assert.deepEqual(report.totals, { pass: 6, fail: 0, skip: 0 });
  assert.deepEqual(report.assessment.targets[0].coveredLevels, [
    "basic", "intermediate", "advanced", "expert", "extreme", "superextreme"
  ]);
  assert.equal(report.assessment.targets[0].ready, true);
  console.log(JSON.stringify(report, null, 2));
});
