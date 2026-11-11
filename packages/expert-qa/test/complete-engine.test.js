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
    "auditSecurityProject",
    "auditSecurityUrl",
    "auditUrl",
    "auditViewports",
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
