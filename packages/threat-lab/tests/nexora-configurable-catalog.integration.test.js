import test from "node:test";
import assert from "node:assert/strict";
import { createThreatLab } from "../src/index.js";
import { createNexoraCatalogAdapter } from "../src/adapters/nexora.js";

const rootPath = process.env.NEXORA_CATALOG_ROOT;
const revision = process.env.NEXORA_CATALOG_REVISION ?? "unpinned-local-checkout";

if (!rootPath) {
  test.skip("NEXORA Configurable Catalog product checkout is not mounted in this runner", () => {});
} else {
  test("Threat Lab executes NEXORA Configurable Catalog's real offline demo tests", async () => {
    const lab = createThreatLab({ name: "JB Threat Lab", version: "0.2.0" });
    lab.registerTarget({
      id: "nexora-configurable-catalog",
      kind: "frontend-catalog-prototype",
      version: revision,
      capabilities: ["sample-data-validation", "local-store", "template-contract", "responsive-layout"],
      adapter: createNexoraCatalogAdapter({ rootPath })
    });

    const scenarios = [
      ["nexora.catalog.sample-data", "basic", "Validate the sample business catalogs, product fields, identifiers, and image URL shape."],
      ["nexora.catalog.local-store-and-escaping", "intermediate", "Validate prototype-local storage isolation, HTML escaping, and WhatsApp URL formatting."],
      ["nexora.catalog.mobile-layout", "intermediate", "Validate mobile admin width constraints and internal table scrolling."],
      ["nexora.catalog.setup-contract", "advanced", "Validate template setup, dynamic fields, measurement units, optional photos, and prototype-only authentication boundaries."]
    ];

    for (const [id, difficulty, description] of scenarios) {
      lab.registerScenario({
        id,
        category: "nexora-configurable-catalog",
        description,
        difficulty,
        appliesTo: ["nexora-configurable-catalog"],
        safety: { safe: true, network: false, destructive: false, executesSample: false },
        tags: ["nexora", "catalog-prototype", "node-test", "offline-fixture"]
      });
    }

    const report = await lab.run({
      targetIds: ["nexora-configurable-catalog"],
      metadata: {
        product: "NEXORA Configurable Catalog prototype",
        revision,
        execution: "Node.js built-in test runner",
        dataBoundary: "demo-localStorage-only"
      }
    });

    assert.deepEqual(report.totals, { pass: 4, fail: 0, skip: 0 }, JSON.stringify(report.results, null, 2));
    const target = report.assessment.targets[0];
    assert.deepEqual(target.coveredLevels, ["basic", "intermediate", "advanced"]);
    assert.deepEqual(target.missingLevels, ["expert", "extreme", "superextreme"]);
    assert.equal(target.ready, false, "prototype test coverage must not imply six-tier product certification");
    assert.ok(report.results.every((item) => item.metrics.exitCode === 0));
  });
}
