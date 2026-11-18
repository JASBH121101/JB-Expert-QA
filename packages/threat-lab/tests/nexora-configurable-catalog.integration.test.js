import test from "node:test";
import { persistThreatLabReport } from "./helpers/persist-report.js";
import assert from "node:assert/strict";
import { createThreatLab } from "../src/index.js";
import { createNexoraCatalogAdapter } from "../src/adapters/nexora.js";

const rootPath = process.env.NEXORA_CATALOG_ROOT;
const revision = process.env.NEXORA_CATALOG_REVISION ?? "unpinned-local-checkout";

if (!rootPath) {
  test.skip("NEXORA Configurable Catalog product checkout is not mounted in this runner", () => {});
} else {
  test("Threat Lab validates six tiers of the pinned NEXORA Configurable Catalog prototype", async () => {
    const lab = createThreatLab({ name: "JB Threat Lab", version: "0.3.0" });
    lab.registerTarget({
      id: "nexora-configurable-catalog",
      kind: "frontend-catalog-prototype",
      version: revision,
      capabilities: ["sample-data-validation", "local-store", "template-contract", "responsive-layout", "demo-boundary"],
      adapter: createNexoraCatalogAdapter({ rootPath })
    });

    const scenarios = [
      ["nexora.catalog.sample-data", "basic", "Validate sample business/product data integrity, identifiers, and image URL shape."],
      ["nexora.catalog.setup-contract", "intermediate", "Validate the setup wizard, editable templates, dimensions, fields, optional photos and demo-only boundary."],
      ["nexora.catalog.local-store-and-escaping", "advanced", "Validate browser-localStorage isolation, HTML escaping and WhatsApp link normalization."],
      ["nexora.catalog.mobile-layout", "expert", "Validate responsive admin behavior and constrained internal scrolling."],
      ["nexora.catalog.extreme.full-demo-regression", "extreme", "Run every pinned demo contract suite together as a cross-file regression."],
      ["nexora.catalog.superextreme.prototype-boundaries", "superextreme", "Run the complete demo suite and verify the prototype does not collect real passwords or claim server persistence."]
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
      scenarioIds: scenarios.map(([id]) => id),
      metadata: {
        product: "NEXORA Configurable Catalog prototype",
        revision,
        execution: "Node.js built-in test runner",
        dataBoundary: "demo-localStorage-only"
      }
    });
    await persistThreatLabReport(report, "nexora-configurable-catalog");

    assert.deepEqual(report.totals, { pass: 6, fail: 0, skip: 0 }, JSON.stringify(report.results, null, 2));
    const target = report.assessment.targets[0];
    assert.deepEqual(target.coveredLevels, [
      "basic", "intermediate", "advanced", "expert", "extreme", "superextreme"
    ]);
    assert.deepEqual(target.missingLevels, []);
    assert.equal(target.ready, true, "ready applies only to the six registered prototype scenarios, including the demo boundary check");
    assert.ok(report.results.every((item) => item.metrics.exitCode === 0));
    assert.ok(report.results.at(-1).metrics.safetyChecks && Object.values(report.results.at(-1).metrics.safetyChecks).every(Boolean));
  });
}
