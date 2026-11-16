import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createThreatLab, THREAT_LAB_REPORT_SCHEMA } from "../../src/index.js";

const targetRoot = resolve(process.env.NEXORA_CONFIGURABLE_CATALOG_ROOT ?? "");
const targetSha = process.env.NEXORA_CONFIGURABLE_CATALOG_SHA ?? "branch-head";
const safety = {
  safe: true,
  network: false,
  destructive: false,
  executesSample: false
};

const scenarios = [
  {
    id: "nexora.catalog.data-contract",
    category: "catalog-integrity",
    description: "Validate demo business profiles, product fields, category references, image URLs, and unique identifiers.",
    difficulty: "basic",
    file: "demo/tests/catalog-data.test.js"
  },
  {
    id: "nexora.catalog.storage-and-escaping",
    category: "client-storage",
    description: "Validate safe HTML escaping, copy-on-write product persistence, and normalized WhatsApp contact links.",
    difficulty: "intermediate",
    file: "demo/tests/store.test.js"
  },
  {
    id: "nexora.catalog.setup-template-contract",
    category: "configurable-catalog",
    description: "Validate the setup wizard, five-number limit, editable templates, dynamic fields, unit dimensions, currencies, optional photos, and public-field rules.",
    difficulty: "advanced",
    file: "demo/tests/setup-contract.test.js"
  },
  {
    id: "nexora.catalog.admin-responsive",
    category: "responsive-interface",
    description: "Validate that administration layouts and tables remain constrained to the available mobile viewport.",
    difficulty: "expert",
    file: "demo/tests/admin-responsive.test.js"
  }
];

function runLocalTest(file) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ["--test", file], {
    cwd: targetRoot,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env }
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  const passed = !result.error && result.status === 0;

  return {
    status: passed ? "pass" : "fail",
    summary: passed
      ? file + " passed against the checked-out NEXORA prototype."
      : file + " failed against the checked-out NEXORA prototype.",
    findings: passed ? [] : [{
      code: "NEXORA_CATALOG_DEMO_TEST_FAILED",
      message: String(result.error?.message ?? output.slice(-1200) ?? "Node test process failed")
    }],
    metrics: {
      sourceFile: file,
      exitCode: result.status,
      durationMs: Date.now() - started,
      localProcess: true
    }
  };
}

test("Threat Lab validates the NEXORA Configurable Catalog prototype within its four-tier scope", async () => {
  assert.ok(process.env.NEXORA_CONFIGURABLE_CATALOG_ROOT, "NEXORA_CONFIGURABLE_CATALOG_ROOT is required");
  assert.ok(existsSync(join(targetRoot, "demo/tests")), "NEXORA demo test directory is missing");
  for (const scenario of scenarios) {
    assert.ok(existsSync(join(targetRoot, scenario.file)), "Missing NEXORA fixture: " + scenario.file);
  }

  const lab = createThreatLab({ name: "NEXORA Configurable Catalog Lab", version: "1.0.0" });
  lab.registerTarget({
    id: "nexora-configurable-catalog",
    kind: "frontend-catalog-prototype",
    version: targetSha,
    capabilities: ["editable-templates", "dynamic-fields", "localStorage-demo", "responsive-ui"],
    adapter: {
      async runScenario({ scenario }) {
        const selected = scenarios.find((item) => item.id === scenario.id);
        if (!selected) return { status: "skip", summary: "No local demo test is mapped to this scenario." };
        return runLocalTest(selected.file);
      }
    }
  });

  for (const scenario of scenarios) {
    lab.registerScenario({ ...scenario, appliesTo: ["nexora-configurable-catalog"], safety });
  }

  const report = await lab.run({
    targetIds: ["nexora-configurable-catalog"],
    scenarioIds: scenarios.map((scenario) => scenario.id),
    difficulty: "expert",
    metadata: {
      profile: "nexora-configurable-catalog-prototype",
      checkoutRef: "feature/nexora-configurable-catalog",
      externalNetwork: false,
      serverAuthentication: false,
      persistence: "browser-localStorage-demo-only"
    }
  });

  assert.equal(report.schema, THREAT_LAB_REPORT_SCHEMA);
  assert.deepEqual(report.totals, { pass: 4, fail: 0, skip: 0 });
  assert.deepEqual(report.assessment.targets[0].coveredLevels, [
    "basic", "intermediate", "advanced", "expert"
  ]);
  assert.equal(report.assessment.targets[0].ready, true);
  console.log(JSON.stringify(report, null, 2));
});
