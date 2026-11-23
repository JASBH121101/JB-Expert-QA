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
    "createStaticQaEngineAdapter",
    "registerStaticQaEngine",
    "createStaticSecurityQaEngineAdapter",
    "registerStaticSecurityQaEngine",
    "createRuntimeSecurityQaEngineAdapter",
    "registerRuntimeSecurityQaEngine",
    "createAccessibilityQaEngineAdapter",
    "registerAccessibilityQaEngine",
    "AccessibilityQaAdapterError",
    "ACCESSIBILITY_QA_ADAPTER_ID",
    "ACCESSIBILITY_QA_ADAPTER_VERSION",
    "ACCESSIBILITY_QA_ADAPTER_CAPABILITIES",
    "createPerformanceQaEngineAdapter",
    "registerPerformanceQaEngine",
    "PerformanceQaAdapterError",
    "PERFORMANCE_QA_ADAPTER_ID",
    "PERFORMANCE_QA_ADAPTER_VERSION",
    "PERFORMANCE_QA_ADAPTER_CAPABILITIES",
    "RuntimeSecurityQaAdapterError",
    "RUNTIME_SECURITY_QA_ADAPTER_ID",
    "RUNTIME_SECURITY_QA_ADAPTER_VERSION",
    "RUNTIME_SECURITY_QA_ADAPTER_CAPABILITIES",
    "StaticSecurityQaAdapterError",
    "STATIC_SECURITY_QA_ADAPTER_ID",
    "STATIC_SECURITY_QA_ADAPTER_VERSION",
    "STATIC_SECURITY_QA_ADAPTER_CAPABILITIES",
    "StaticQaAdapterError",
    "STATIC_QA_ADAPTER_ID",
    "STATIC_QA_ADAPTER_VERSION",
    "STATIC_QA_ADAPTER_CAPABILITIES",
    "registerApiTestingEngine",
    "createQaEngineOrchestrator",
    "getQaEngineActionType",
    "QaEngineOrchestratorError",
    "QA_ENGINE_ACTION_PREFIX",
    "QA_ENGINE_EXECUTION_PERMISSION",
    "QA_ENGINE_ORCHESTRATOR_RISK",
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
  assert.equal(typeof engine.createPerformanceQaEngineAdapter, "function");
  assert.equal(engine.PERFORMANCE_QA_ADAPTER_ID, "jb.performance-qa-engine");
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


test("standalone package orchestrates the registered API Testing Engine through policy and approval", async () => {
  let calls = 0;
  const registry = engine.createQaEngineRegistry();
  engine.registerApiTestingEngine(registry, {
    allowedOrigins: ["https://standalone-orchestrator.test"],
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  registry.seal();

  const actionType = engine.getQaEngineActionType(engine.API_TESTING_ADAPTER_ID);
  const orchestrator = engine.createQaEngineOrchestrator({
    registry,
    policy: {
      id: "standalone-api-policy",
      grantedPermissions: [engine.QA_ENGINE_EXECUTION_PERMISSION],
      rules: [{ type: actionType, maxRisk: "high" }]
    },
    requestApproval: async () => ({ approved: true, approvalId: "standalone-approval-1" })
  });

  assert.equal(calls, 0, "construction must not invoke registered engines");
  const result = await orchestrator.execute({
    id: "standalone-api-plan",
    actions: [{
      id: "standalone-api-action",
      type: actionType,
      input: {
        operation: "request",
        request: { method: "GET", url: "https://standalone-orchestrator.test/health" }
      }
    }]
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.actions[0].output.json, { ok: true });
  assert.equal(calls, 1);
});


test("standalone Expert QA package runs the canonical Static QA adapter without external advisory lookups", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "jbqa-static-package-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "standalone.js"), "export const ready = true;\n", "utf8");

    const registry = engine.createQaEngineRegistry();
    const metadata = engine.registerStaticQaEngine(registry);
    assert.equal(metadata.id, engine.STATIC_QA_ADAPTER_ID);
    assert.equal(registry.has(engine.STATIC_QA_ADAPTER_ID), true);

    const result = await registry.getRunner(metadata.id)({ path: root });
    assert.equal(result.readOnly, true);
    assert.equal(result.dependencyAdvisories.enabled, false);
    assert.equal(result.dependencyAdvisories.networkRequests, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("standalone Expert QA package runs canonical Static Security QA offline and without source disclosure", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "jbqa-static-security-package-"));
  const sourceSecret = "standalone-private-source-value";
  const token = "ghp_" + "C".repeat(36);
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.js"), [
      'const endpoint = "http://api.production.example.com/v1";',
      'const GITHUB_TOKEN = "' + token + '";',
      'const marker = "' + sourceSecret + '";'
    ].join("\n"), "utf8");
    await writeFile(join(root, ".env"), "TOKEN=standalone-env-secret", "utf8");

    const registry = engine.createQaEngineRegistry();
    const metadata = engine.registerStaticSecurityQaEngine(registry);
    assert.equal(metadata.id, engine.STATIC_SECURITY_QA_ADAPTER_ID);

    const result = await registry.getRunner(metadata.id)({ path: root });
    assert.equal(result.readOnly, true);
    assert.equal(result.securityAssessment.onlineDependencyAdvisories, false);
    assert.equal(result.securityAssessment.networkRequests, 0);
    assert.equal(result.securityAssessment.databaseConnections, 0);
    const output = JSON.stringify(result);
    assert.equal(output.includes(token), false);
    assert.equal(output.includes(sourceSecret), false);
    assert.equal(output.includes("standalone-env-secret"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("standalone Expert QA package exposes Runtime Security QA and blocks private destinations without leaking query data", async () => {
  const registry = engine.createQaEngineRegistry();
  const metadata = engine.registerRuntimeSecurityQaEngine(registry);
  assert.equal(metadata.id, engine.RUNTIME_SECURITY_QA_ADAPTER_ID);
  assert.equal(metadata.targetType, "url");
  assert.equal(metadata.executionMode, "browser");
  const runner = registry.getRunner(metadata.id);
  const secret = "package-runtime-secret-456";
  await assert.rejects(
    runner({ url: "http://127.0.0.1/?token=" + secret }),
    (error) => error instanceof engine.RuntimeSecurityQaAdapterError &&
      error.code === "AUDIT_FAILED" &&
      !error.message.includes(secret)
  );
});


test("standalone Expert QA package exposes Accessibility QA and blocks private destinations", async () => {
  const registry = engine.createQaEngineRegistry();
  const metadata = engine.registerAccessibilityQaEngine(registry);
  assert.equal(metadata.id, engine.ACCESSIBILITY_QA_ADAPTER_ID);
  assert.equal(metadata.targetType, "url");
  assert.equal(metadata.executionMode, "browser");
  const runner = registry.getRunner(metadata.id);
  await assert.rejects(
    runner({ url: "http://127.0.0.1/?token=package-accessibility-secret" }),
    (error) => error instanceof engine.AccessibilityQaAdapterError &&
      error.code === "AUDIT_FAILED" &&
      !error.message.includes("package-accessibility-secret")
  );
});

 
test("standalone Expert QA package exposes Performance QA and blocks private destinations", async () => {
  const registry = engine.createQaEngineRegistry();
  const metadata = engine.registerPerformanceQaEngine(registry);
  assert.equal(metadata.id, engine.PERFORMANCE_QA_ADAPTER_ID);
  assert.equal(metadata.targetType, "url");
  assert.equal(metadata.executionMode, "browser");
  const runner = registry.getRunner(metadata.id);
  const secret = "package-performance-secret-123";
  await assert.rejects(
    runner({ url: "http://127.0.0.1/?token=" + secret }),
    (error) => error instanceof engine.PerformanceQaAdapterError &&
      error.code === "AUDIT_FAILED" &&
      !error.message.includes(secret)
  );
});
