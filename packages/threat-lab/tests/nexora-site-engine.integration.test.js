import test from "node:test";
import assert from "node:assert/strict";
import { createThreatLab } from "../src/index.js";
import { createNexoraSiteEngineAdapter } from "../src/adapters/nexora.js";

const rootPath = process.env.NEXORA_SITE_ENGINE_ROOT;
const revision = process.env.NEXORA_SITE_ENGINE_REVISION ?? "unpinned-local-checkout";

if (!rootPath) {
  test.skip("NEXORA Site Engine Laravel checkout is not mounted in this runner", () => {});
} else {
  test("Threat Lab validates six tiers of the pinned NEXORA Laravel Site Engine", async () => {
    const lab = createThreatLab({ name: "JB Threat Lab", version: "0.3.0" });
    lab.registerTarget({
      id: "nexora-site-engine",
      kind: "laravel-catalog-application",
      version: revision,
      capabilities: ["installation", "public-site", "inventory-basic", "exports", "permission-engine", "domain-dns-tls"],
      adapter: createNexoraSiteEngineAdapter({ rootPath })
    });

    const scenarios = [
      ["nexora.site.installation-and-template-seeding", "basic", "Validate disposable installation state, owner setup, template seeding, and setup cancellation."],
      ["nexora.site.public-data-boundaries", "intermediate", "Validate published-only public data, private-field exclusion, price precision, sitemap, and robots rules."],
      ["nexora.site.role-and-field-authorization", "advanced", "Validate role permissions, explicit overrides, unknown identifiers and inactive-user denial."],
      ["nexora.site.export-and-inventory-authorization", "expert", "Validate export field visibility, independent create/download authorization and least-privilege inventory assistance."],
      ["nexora.site.extreme.domain-and-tls-boundaries", "extreme", "Validate owner-only domain management, fake DNS/TLS verification and published-host enforcement."],
      ["nexora.site.superextreme.full-feature-and-unit-suite", "superextreme", "Run the complete Laravel Feature and Unit suite using PHPUnit's SQLite in-memory configuration."]
    ];

    for (const [id, difficulty, description] of scenarios) {
      lab.registerScenario({
        id,
        category: "nexora-site-engine",
        description,
        difficulty,
        appliesTo: ["nexora-site-engine"],
        safety: { safe: true, network: false, destructive: false, executesSample: false },
        tags: ["nexora", "laravel-feature-test", "sqlite-memory", "offline-fixture", "fake-dns-tls"]
      });
    }

    const report = await lab.run({
      targetIds: ["nexora-site-engine"],
      scenarioIds: scenarios.map(([id]) => id),
      metadata: {
        product: "NEXORA Site Engine",
        revision,
        execution: "PHPUnit feature and unit suites",
        database: "SQLite in-memory",
        dnsTls: "deterministic-fakes",
        deployment: "none"
      }
    });

    assert.deepEqual(report.totals, { pass: 6, fail: 0, skip: 0 }, JSON.stringify(report.results, null, 2));
    const target = report.assessment.targets[0];
    assert.deepEqual(target.coveredLevels, [
      "basic", "intermediate", "advanced", "expert", "extreme", "superextreme"
    ]);
    assert.deepEqual(target.missingLevels, []);
    assert.equal(target.ready, true, "ready applies only to the six registered Site Engine scenarios, including the full-suite gate");
    assert.ok(report.results.every((item) => item.metrics.exitCode === 0));
    assert.ok(report.results.every((item) => item.metrics.database === "sqlite-memory"));
  });
}
