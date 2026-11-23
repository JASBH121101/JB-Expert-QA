import assert from "node:assert/strict";
import { test } from "node:test";
import * as engine from "../src/index.js";
import { EXPERT_QA_PACKAGE_VERSION } from "../package-version.js";

test("the npm package exposes the complete canonical JB Expert QA API", () => {
  const required = [
    "ExpertQAEngine",
    "RuleRegistry",
    "validateEngineConfig",
    "responsiveRules",
    "uiUxRules",
    "accessibilityRules",
    "performanceRules",
    "functionalRules",
    "consistencyRules",
    "codeQualityRules",
    "securityRules",
    "dependencyRules",
    "databaseRules",
    "deadCodeRules",
    "securityDefenseRules",
    "securityRuntimeRules",
    "scanProject",
    "auditProject",
    "auditDatabaseProject",
    "databaseSpecialistRules",
    "auditSecurityProject",
    "auditSecurityUrl",
    "auditUrl",
    "auditViewports",
    "createAuditEngineRegistry",
    "createQaEngineRegistry",
    "createApiTestingEngineAdapter",
    "registerApiTestingEngine",
    "ApiTestingAdapterError",
    "API_TESTING_ADAPTER_ID",
    "API_TESTING_ADAPTER_VERSION",
    "API_TESTING_ADAPTER_OPERATIONS",
    "QaEngineRegistryError",
    "QA_ENGINE_ADAPTER_CONTRACT",
    "buildDashboardAnalytics",
    "buildConsolidatedReport",
    "createDashboardServer",
    "startDashboard",
    "AUDIT_ENGINE_IDS",
    "DEFAULT_VIEWPORTS",
    "comparePngBuffers",
    "comparePngFiles",
    "createGeminiProvider",
    "createCloudflareProvider",
    "createAiProviderRouter",
    "reviewScreenshot",
    "reviewViewportScreenshots",
    "createRemediationPlan",
    "runAutopilot",
    "createAutonomousExecutionEngine",
    "createInMemoryExecutionLedger",
    "createJsonlExecutionLedger",
    "verifyExecutionLedger",
    "evaluatePatchPaths",
    "validateUnifiedPatch",
    "createSecurityAssessment",
    "createSecurityBridgeCoordinator",
    "createSecurityBridgeServer"
  ];
  for (const name of required) {
    assert.ok(name in engine, "complete package export is missing: " + name);
  }
  assert.equal(typeof engine.auditUrl, "function");
  assert.equal(typeof engine.auditViewports, "function");
  assert.equal(typeof engine.createAuditEngineRegistry, "function");
  assert.equal(typeof engine.createQaEngineRegistry, "function");
  assert.equal(typeof engine.createApiTestingEngineAdapter, "function");
  assert.equal(typeof engine.registerApiTestingEngine, "function");
  assert.equal(engine.API_TESTING_ADAPTER_ID, "jb.api-testing-engine");
  assert.equal(engine.API_TESTING_ADAPTER_VERSION, "0.1.0");
  assert.ok(engine.API_TESTING_ADAPTER_OPERATIONS.includes("rate-limit"));
  assert.equal(engine.QA_ENGINE_ADAPTER_CONTRACT, "jb.qa-engine-adapter/v1");
  assert.equal(typeof engine.buildDashboardAnalytics, "function");
  assert.equal(typeof engine.buildConsolidatedReport, "function");
  assert.equal(typeof engine.createDashboardServer, "function");
  assert.equal(typeof engine.startDashboard, "function");
  assert.deepEqual(engine.AUDIT_ENGINE_IDS, ["static", "live-site", "responsive", "accessibility", "performance", "security", "visual"]);
  assert.equal(typeof engine.comparePngBuffers, "function");
  assert.ok(Array.isArray(engine.responsiveRules));
  assert.ok(Array.isArray(engine.accessibilityRules));
  assert.equal(EXPERT_QA_PACKAGE_VERSION, "0.2.0");
});

test("the bundled engine keeps the default configuration and every specialist group", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { resolve, dirname } = await import("node:path");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const config = JSON.parse(await readFile(resolve(root, "config/default.config.json"), "utf8"));
  assert.equal(config.profile, "general-web");
  assert.ok(config.weights.responsive > 0);
  assert.ok(config.weights.accessibility > 0);
  assert.ok((await readFile(resolve(root, "src/adapters/playwright/interactions.js"), "utf8")).includes("exploreInteractionStates"));
  assert.ok((await readFile(resolve(root, "src/adapters/visual/png-diff.js"), "utf8")).includes("comparePngBuffers"));
  assert.ok((await readFile(resolve(root, "src/ai/visual-review.js"), "utf8")).includes("reviewViewportScreenshots"));
  assert.ok((await readFile(resolve(root, "src/agent/autopilot.js"), "utf8")).includes("runAutopilot"));
});


test("standalone Expert QA package connects API Testing Engine through the central registry", async () => {
  let calls = 0;
  const registry = engine.createQaEngineRegistry();
  const metadata = engine.registerApiTestingEngine(registry, {
    allowedOrigins: ["https://standalone-adapter.test"],
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.equal(metadata.id, "jb.api-testing-engine");
  assert.deepEqual(registry.find({ category: "api" }).map((item) => item.id), ["jb.api-testing-engine"]);
  assert.equal(calls, 0, "registration must not send API requests");

  const result = await registry.getRunner(metadata.id)({
    operation: "request",
    request: { method: "GET", url: "https://standalone-adapter.test/health" }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true });
  assert.equal(calls, 1);
});
