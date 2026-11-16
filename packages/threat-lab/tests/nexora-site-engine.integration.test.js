import test from "node:test";
import assert from "node:assert/strict";
import { createThreatLab } from "../src/index.js";
import { createNexoraSiteEngineAdapter } from "../src/adapters/nexora.js";

const rootPath = process.env.NEXORA_SITE_ENGINE_ROOT;
const revision = process.env.NEXORA_SITE_ENGINE_REVISION ?? "unpinned-local-checkout";

if (!rootPath) {
  test.skip("NEXORA Site Engine Laravel checkout is not mounted in this runner", () => {});
} else {
  test("Threat Lab executes NEXORA Site Engine's real isolated Laravel feature tests", async () => {
    const lab = createThreatLab({ name: "JB Threat Lab", version: "0.2.0" });
    lab.registerTarget({
      id: "nexora-site-engine",
      kind: "laravel-catalog-application",
      version: revision,
      capabilities: ["installation", "public-site", "inventory-basic", "exports", "permission-engine"],
      adapter: createNexoraSiteEngineAdapter({ rootPath })
    });

    const scenarios = [
      ["nexora.site.installation-and-template-seeding", "basic", "Validate disposable installation state, owner setup, template seeding, and setup cancellation."],
      ["nexora.site.public-data-boundaries", "intermediate", "Validate published-only public data, private-field exclusion, price precision, sitemap, and robots rules."],
      ["nexora.site.inventory-assistant-field-isolation", "intermediate", "Validate inventory-assistant access without leaking or modifying price and description fields."],
      ["nexora.site.export-permission-and-formula-safety", "advanced", "Validate export field permissions, download authorization, history boundaries, and CSV formula neutralization."],
      ["nexora.site.role-and-field-authorization", "expert", "Validate role/action/field authorization, default deny behavior, and individual permission overrides."]
    ];

    for (const [id, difficulty, description] of scenarios) {
      lab.registerScenario({
        id,
        category: "nexora-site-engine",
        description,
        difficulty,
        appliesTo: ["nexora-site-engine"],
        safety: { safe: true, network: false, destructive: false, executesSample: false },
        tags: ["nexora", "laravel-feature-test", "sqlite-memory", "offline-fixture"]
      });
    }

    const report = await lab.run({
      targetIds: ["nexora-site-engine"],
      metadata: {
        product: "NEXORA Site Engine",
        revision,
        execution: "PHPUnit feature suite",
        database: "SQLite in-memory",
        deployment: "none"
      }
    });

    assert.deepEqual(report.totals, { pass: 5, fail: 0, skip: 0 }, JSON.stringify(report.results, null, 2));
    const target = report.assessment.targets[0];
    assert.deepEqual(target.coveredLevels, ["basic", "intermediate", "advanced", "expert"]);
    assert.deepEqual(target.missingLevels, ["extreme", "superextreme"]);
    assert.equal(target.ready, false, "Site Engine must remain uncertified at the untested high tiers");
    assert.ok(report.results.every((item) => item.metrics.exitCode === 0));
    assert.ok(report.results.every((item) => item.metrics.database === "sqlite-memory"));
  });
}
