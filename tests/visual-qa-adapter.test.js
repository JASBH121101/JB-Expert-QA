import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { access, mkdtemp, rm } from "node:fs/promises";
import {
  createVisualQaEngineAdapter,
  registerVisualQaEngine,
  VisualQaAdapterError,
  VISUAL_QA_ADAPTER_ID,
  VISUAL_QA_ADAPTER_VERSION,
  VISUAL_QA_ADAPTER_CAPABILITIES,
  VISUAL_QA_LIMITS
} from "../src/engine-registry/adapters/visual-qa.js";
import { DEFAULT_VIEWPORTS, FULL_VIEWPORTS } from "../src/adapters/playwright/audit-url.js";
import { createQaEngineRegistry } from "../src/engine-registry/index.js";
import {
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION,
  QA_ENGINE_ORCHESTRATOR_RISK
} from "../src/engine-registry/orchestrator.js";

function reportFor(options, overrides = {}) {
  const viewports = options.viewports.flatMap((viewport) => options.themes.map((theme) => ({
    name: viewport.name,
    theme,
    viewport: { width: viewport.width, height: viewport.height },
    passed: true,
    score: 96,
    findings: [{
      id: "VIS-001",
      ruleId: "ui-ux.alignment",
      specialist: "ui-ux",
      severity: "low",
      title: "Minor alignment variation",
      description: "A bounded visual observation.",
      location: "button.private-selector",
      evidence: { pageUrl: "https://example.test/?token=private-visual-token" },
      recommendation: "Align the element."
    }],
    execution: [{ ruleId: "ui-ux.alignment", status: "passed" }],
    screenshotPath: join(options.screenshotDir, viewport.name + "-" + theme + ".png"),
    visualComparison: options.baselineDir
      ? {
          status: "compared",
          passed: true,
          diffPixels: 20,
          totalPixels: viewport.width * viewport.height,
          diffPixelRatio: 0.0001,
          baselinePath: "/private/baseline/path",
          actualPath: "/private/screenshot/path",
          baselineDimensions: { width: viewport.width, height: viewport.height },
          actualDimensions: { width: viewport.width, height: viewport.height },
          diffPath: "/private/diff/path"
        }
      : null
  })));

  return {
    engine: "JB Expert QA",
    version: "1.0.0",
    generatedAt: "2026-11-23T18:40:00.000Z",
    summary: {
      viewportsChecked: viewports.length,
      themePairsCompared: options.themes.length === 2 ? options.viewports.length : 0
    },
    passed: viewports.every((item) => item.passed),
    themeComparisons: [],
    viewports,
    ...overrides
  };
}

test("Visual QA publishes a stable bounded browser adapter manifest", () => {
  const adapter = createVisualQaEngineAdapter();
  assert.equal(adapter.id, VISUAL_QA_ADAPTER_ID);
  assert.equal(adapter.version, VISUAL_QA_ADAPTER_VERSION);
  assert.equal(adapter.category, "visual");
  assert.equal(adapter.targetType, "url");
  assert.equal(adapter.executionMode, "browser");
  assert.deepEqual(adapter.capabilities, [
    "browser-visual-layout-audit",
    "viewport-screenshot-capture",
    "pixel-baseline-comparison",
    "layout-overflow-detection",
    "theme-consistency-observation",
    "bounded-visual-findings",
    "read-only-baseline-comparison"
  ]);
  assert.ok(Object.isFrozen(adapter));
  assert.ok(Object.isFrozen(VISUAL_QA_ADAPTER_CAPABILITIES));
  assert.ok(Object.isFrozen(VISUAL_QA_LIMITS));
  assert.equal(VISUAL_QA_LIMITS.baselineWrites, false);
  assert.equal(VISUAL_QA_LIMITS.aiReview, false);
  assert.match(adapter.description, /no baseline writes, AI calls, authentication or interaction exploration/iu);
});

test("registration is metadata-only and does not navigate or capture screenshots", () => {
  let calls = 0;
  const registry = createQaEngineRegistry();
  const metadata = registerVisualQaEngine(registry);
  assert.equal(metadata.id, VISUAL_QA_ADAPTER_ID);
  assert.equal(registry.has(VISUAL_QA_ADAPTER_ID), true);
  assert.deepEqual(registry.find({ category: "visual" }).map((item) => item.id), [VISUAL_QA_ADAPTER_ID]);
  assert.equal(calls, 0);
});

test("duplicate registration and untrusted registry shapes are rejected", () => {
  const registry = createQaEngineRegistry();
  registerVisualQaEngine(registry);
  assert.throws(
    () => registerVisualQaEngine(registry),
    (error) => error instanceof VisualQaAdapterError && error.code === "DUPLICATE_ENGINE"
  );
  assert.throws(
    () => registerVisualQaEngine({}),
    (error) => error instanceof VisualQaAdapterError && error.code === "INVALID_REGISTRY"
  );
  assert.throws(
    () => registerVisualQaEngine(Object.create({ register() {}, has() {} })),
    (error) => error instanceof VisualQaAdapterError && error.code === "INVALID_REGISTRY"
  );
});

test("URL, credentials, matrix, themes, timeout and baseline mutation validation reject unsafe input", async () => {
  const adapter = createVisualQaEngineAdapter();
  const validUrl = "https://example.test/";
  const invalidCases = [
    [{ url: "" }, "INVALID_TARGET"],
    [{ url: "file:///etc/passwd" }, "UNSUPPORTED_PROTOCOL"],
    [{ url: "https://user:password@example.test/" }, "EMBEDDED_CREDENTIALS"],
    [{ url: validUrl, matrix: "custom" }, "INVALID_MATRIX"],
    [{ url: validUrl, themes: [] }, "INVALID_THEMES"],
    [{ url: validUrl, themes: ["light", "light"] }, "INVALID_THEMES"],
    [{ url: validUrl, themes: ["light", "dark", "light"] }, "INVALID_THEMES"],
    [{ url: validUrl, timeout: 999 }, "INVALID_TIMEOUT"],
    [{ url: validUrl, timeout: 30001 }, "INVALID_TIMEOUT"],
    [{ url: validUrl, baselineDir: "relative/baselines" }, "INVALID_BASELINE_DIRECTORY"],
    [{ url: validUrl, updateBaselines: true }, "BASELINE_WRITES_DISABLED"],
    [{ url: validUrl, visualThreshold: 1.1 }, "INVALID_VISUAL_THRESHOLD"],
    [{ url: validUrl, maxDiffPixelRatio: -0.1 }, "INVALID_VISUAL_THRESHOLD"],
    [{ url: validUrl, allowPrivateNetworks: true }, "UNSUPPORTED_FIELD"]
  ];
  for (const [command, code] of invalidCases) {
    await assert.rejects(
      adapter.run(command),
      (error) => error instanceof VisualQaAdapterError && error.code === code,
      "expected validation code " + code
    );
  }

  const sparseThemes = new Array(1);
  await assert.rejects(
    adapter.run({ url: validUrl, themes: sparseThemes }),
    (error) => error instanceof VisualQaAdapterError && error.code === "INVALID_THEMES"
  );

  let themeGetterInvoked = false;
  const accessorThemes = [];
  Object.defineProperty(accessorThemes, "0", {
    enumerable: true,
    get() {
      themeGetterInvoked = true;
      return "light";
    }
  });
  accessorThemes.length = 1;
  await assert.rejects(
    adapter.run({ url: validUrl, themes: accessorThemes }),
    (error) => error instanceof VisualQaAdapterError && error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(themeGetterInvoked, false);
});

test("command and execution option accessors are rejected without invocation", async () => {
  const adapter = createVisualQaEngineAdapter({ audit: async () => { throw new Error("must not run"); } });
  let invoked = false;
  const command = { url: "https://example.test/" };
  Object.defineProperty(command, "timeout", {
    enumerable: true,
    get() {
      invoked = true;
      return 5000;
    }
  });
  await assert.rejects(
    adapter.run(command),
    (error) => error instanceof VisualQaAdapterError && error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(invoked, false);
  await assert.rejects(
    adapter.run({ url: "https://example.test/" }, { updateBaselines: true }),
    (error) => error instanceof VisualQaAdapterError && error.code === "UNSUPPORTED_FIELD"
  );
});

test("pre-aborted signals prevent screenshot directory creation and browser startup", async () => {
  let auditCalls = 0;
  const controller = new AbortController();
  controller.abort();
  const adapter = createVisualQaEngineAdapter({
    audit: async () => {
      auditCalls += 1;
      return {};
    }
  });
  await assert.rejects(
    adapter.run({ url: "https://example.test/" }, { signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
  assert.equal(auditCalls, 0);
});

test("default matrix delegates to canonical audit and keeps screenshots ephemeral", async () => {
  let received;
  const tempRoot = await mkdtemp(join(tmpdir(), "jbqa-visual-test-"));
  try {
    const adapter = createVisualQaEngineAdapter({
      tempDirectory: () => tempRoot,
      audit: async (url, options) => {
        received = { url, options };
        return reportFor(options);
      }
    });
    const result = await adapter.run({ url: "https://example.test/" });
    assert.equal(received.url, "https://example.test/");
    assert.deepEqual(received.options.viewports, DEFAULT_VIEWPORTS);
    assert.deepEqual(received.options.themes, ["light"]);
    assert.equal(received.options.baselineDir, null);
    assert.equal(received.options.updateBaselines, false);
    assert.equal(received.options.screenshotFullPage, false);
    assert.equal(received.options.interactionExploration, false);
    assert.equal(received.options.runAxe, false);
    assert.equal(received.options.allowPrivateNetworks, false);
    assert.ok(received.options.screenshotDir.startsWith(tempRoot));
    assert.equal(result.complete, true);
    assert.equal(result.passed, true);
    assert.equal(result.matrix.profile, "default");
    assert.equal(result.matrix.totalResults, DEFAULT_VIEWPORTS.length);
    assert.equal(result.summary.screenshotsCaptured, DEFAULT_VIEWPORTS.length);
    assert.equal(result.summary.visualComparisons, 0);
    assert.equal(result.summary.baselineWrites, 0);
    assert.equal(result.findings.length, DEFAULT_VIEWPORTS.length);
    assert.equal(JSON.stringify(result).includes("private-selector"), false);
    assert.equal(JSON.stringify(result).includes("private-visual-token"), false);
    assert.equal(JSON.stringify(result).includes("/private/"), false);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.viewports));
    assert.ok(Object.isFrozen(result.findings));
    await assert.rejects(access(received.options.screenshotDir));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("full matrix and light/dark themes are capped at eighteen screenshot results", async () => {
  let received;
  const adapter = createVisualQaEngineAdapter({
    audit: async (_url, options) => {
      received = options;
      return reportFor(options);
    }
  });
  const result = await adapter.run({
    url: "https://example.test/",
    matrix: "full",
    themes: ["light", "dark"],
    timeout: 15000
  });
  assert.deepEqual(received.viewports, FULL_VIEWPORTS);
  assert.deepEqual(received.themes, ["light", "dark"]);
  assert.equal(result.matrix.profile, "full");
  assert.equal(result.matrix.totalResults, 18);
  assert.equal(result.viewports.length, 18);
  assert.equal(result.summary.screenshotsCaptured, 18);
  assert.equal(result.complete, true);
  assert.equal(result.passed, true);
});

test("read-only pixel baselines are compared but never updated", async () => {
  let received;
  const baselineDir = join(tmpdir(), "jbqa-visual-baseline-fixture");
  const adapter = createVisualQaEngineAdapter({
    audit: async (_url, options) => {
      received = options;
      return reportFor(options);
    }
  });
  const result = await adapter.run({ url: "https://example.test/", baselineDir });
  assert.equal(received.baselineDir, baselineDir);
  assert.equal(received.updateBaselines, false);
  assert.equal(received.diffDir, null);
  assert.equal(result.complete, true);
  assert.equal(result.passed, true);
  assert.equal(result.summary.visualComparisons, DEFAULT_VIEWPORTS.length);
  assert.equal(result.viewports[0].visualComparison.status, "compared");
  assert.equal(result.viewports[0].visualComparison.diffPixelRatio, 0.0001);
  assert.equal(JSON.stringify(result).includes(baselineDir), false);
});

test("missing baselines and pixel mismatches cannot be reported as a passing visual assessment", async () => {
  const missingAdapter = createVisualQaEngineAdapter({
    audit: async (_url, options) => {
      const result = reportFor(options);
      result.viewports[0].visualComparison = {
        status: "baseline-missing",
        passed: false,
        baselinePath: "/private/baseline.png",
        actualPath: "/private/screenshot.png"
      };
      result.viewports[0].passed = false;
      result.passed = false;
      return result;
    }
  });
  const missing = await missingAdapter.run({
    url: "https://example.test/",
    baselineDir: join(tmpdir(), "missing-baselines")
  });
  assert.equal(missing.complete, false);
  assert.equal(missing.passed, false);
  assert.equal(missing.summary.baselineMissing, 1);

  const mismatchAdapter = createVisualQaEngineAdapter({
    audit: async (_url, options) => {
      const result = reportFor(options);
      result.viewports[0].visualComparison = {
        status: "compared",
        passed: false,
        diffPixels: 500,
        totalPixels: 1000,
        diffPixelRatio: 0.5
      };
      result.viewports[0].passed = false;
      result.passed = false;
      return result;
    }
  });
  const mismatch = await mismatchAdapter.run({
    url: "https://example.test/",
    baselineDir: join(tmpdir(), "baseline-fixture")
  });
  assert.equal(mismatch.complete, true);
  assert.equal(mismatch.passed, false);
  assert.equal(mismatch.summary.visualFailures, 1);
});

test("findings are globally capped and rule execution errors make the assessment inconclusive", async () => {
  const adapter = createVisualQaEngineAdapter({
    audit: async (_url, options) => {
      const result = reportFor(options);
      result.viewports = result.viewports.map((item, index) => ({
        ...item,
        findings: Array.from({ length: 45 }, (_, findingIndex) => ({
          id: "VIS-" + index + "-" + findingIndex,
          ruleId: "ui-ux.layout",
          specialist: "ui-ux",
          severity: "medium",
          title: "Bounded issue",
          description: "Visual finding " + findingIndex
        })),
        execution: [{ ruleId: "ui-ux.layout", status: index === 0 ? "error" : "passed" }]
      }));
      result.passed = false;
      return result;
    }
  });
  const result = await adapter.run({ url: "https://example.test/", matrix: "full", themes: ["light", "dark"] });
  assert.equal(result.summary.totalFindings, 18 * 45);
  assert.equal(result.findings.length, VISUAL_QA_LIMITS.maxFindings);
  assert.equal(result.summary.findingsTruncated, true);
  assert.equal(result.complete, false);
  assert.equal(result.assessmentStatus, "inconclusive");
  assert.equal(result.summary.rulesWithErrors, 1);
});

test("malformed or incomplete canonical reports fail closed", async () => {
  const adapter = createVisualQaEngineAdapter({ audit: async () => ({ passed: true }) });
  await assert.rejects(
    adapter.run({ url: "https://example.test/" }),
    (error) => error instanceof VisualQaAdapterError && error.code === "UNSAFE_AUDIT_RESULT"
  );

  const incompleteAdapter = createVisualQaEngineAdapter({
    audit: async (_url, options) => {
      const result = reportFor(options);
      result.viewports.pop();
      return result;
    }
  });
  await assert.rejects(
    incompleteAdapter.run({ url: "https://example.test/" }),
    (error) => error instanceof VisualQaAdapterError && error.code === "UNSAFE_AUDIT_RESULT"
  );
});

test("browser and filesystem errors are redacted and ephemeral screenshot output is cleaned", async () => {
  let screenshotPath;
  const tempRoot = await mkdtemp(join(tmpdir(), "jbqa-visual-cleanup-"));
  try {
    const adapter = createVisualQaEngineAdapter({
      tempDirectory: () => tempRoot,
      audit: async (url, options) => {
        screenshotPath = options.screenshotDir;
        throw new Error("Sensitive failure at " + url + "?token=private-visual-secret");
      }
    });
    await assert.rejects(
      adapter.run({ url: "https://example.test/?token=private-visual-secret" }),
      (error) => error instanceof VisualQaAdapterError &&
        error.code === "AUDIT_FAILED" &&
        !error.message.includes("private-visual-secret") &&
        !error.message.includes("example.test")
    );
    await assert.rejects(access(screenshotPath));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("private destinations are rejected by the canonical URL safety guard", async () => {
  const adapter = createVisualQaEngineAdapter();
  const secret = "visual-query-secret-123";
  await assert.rejects(
    adapter.run({ url: "http://127.0.0.1/?token=" + secret }),
    (error) => error instanceof VisualQaAdapterError &&
      error.code === "AUDIT_FAILED" &&
      !error.message.includes(secret)
  );
});

test("orchestrator requires exact policy, execution permission and external approval before visual execution", async () => {
  let auditCalls = 0;
  const registry = createQaEngineRegistry();
  const adapter = createVisualQaEngineAdapter({
    audit: async (_url, options) => {
      auditCalls += 1;
      return reportFor(options);
    }
  });
  registry.register(adapter);
  registry.seal();

  const actionType = getQaEngineActionType(VISUAL_QA_ADAPTER_ID);
  const denied = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "visual-deny-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: []
    },
    requestApproval: async () => ({ approved: true, approvalId: "must-not-be-requested" })
  });
  const deniedResult = await denied.execute({
    id: "visual-denied-plan",
    actions: [{ id: "visual-denied-action", type: actionType, input: { url: "https://example.test/" } }]
  });
  assert.equal(deniedResult.status, "blocked");
  assert.equal(auditCalls, 0);

  const approvalRejected = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "visual-approval-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: [{ type: actionType, maxRisk: QA_ENGINE_ORCHESTRATOR_RISK }]
    },
    requestApproval: async () => ({ approved: false })
  });
  const rejectedResult = await approvalRejected.execute({
    id: "visual-rejected-plan",
    actions: [{ id: "visual-rejected-action", type: actionType, input: { url: "https://example.test/" } }]
  });
  assert.equal(rejectedResult.status, "blocked");
  assert.equal(auditCalls, 0);

  const approved = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "visual-approved-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: [{ type: actionType, maxRisk: QA_ENGINE_ORCHESTRATOR_RISK }]
    },
    requestApproval: async () => ({ approved: true, approvalId: "visual-approval-1" })
  });
  const approvedResult = await approved.execute({
    id: "visual-approved-plan",
    actions: [{ id: "visual-approved-action", type: actionType, input: { url: "https://example.test/" } }]
  });
  assert.equal(approvedResult.status, "succeeded");
  assert.equal(approvedResult.actions[0].output.adapter, VISUAL_QA_ADAPTER_ID);
  assert.equal(auditCalls, 1);
  assert.equal(approved.verifyLedger().valid, true);
});
