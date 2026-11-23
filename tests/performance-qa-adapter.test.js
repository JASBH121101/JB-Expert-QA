import assert from "node:assert/strict";
import test from "node:test";
import {
  createPerformanceQaEngineAdapter,
  registerPerformanceQaEngine,
  PerformanceQaAdapterError,
  PERFORMANCE_QA_ADAPTER_ID,
  PERFORMANCE_QA_ADAPTER_VERSION,
  PERFORMANCE_QA_ADAPTER_CAPABILITIES
} from "../src/engine-registry/adapters/performance-qa.js";
import { createQaEngineRegistry } from "../src/engine-registry/index.js";
import {
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION,
  QA_ENGINE_ORCHESTRATOR_RISK
} from "../src/engine-registry/orchestrator.js";

function completeReport(overrides = {}) {
  return {
    engine: "JB Expert QA",
    version: "1.0.0",
    generatedAt: "2026-11-23T18:00:00.000Z",
    scoring: {
      score: 92,
      minimumScore: 80,
      passed: true,
      blockedByCritical: false,
      blockedByExecutionErrors: false
    },
    summary: {
      rulesExecuted: 4,
      rulesWithErrors: 0,
      specialists: ["performance"]
    },
    execution: [
      { ruleId: "performance.large-transfer", status: "success" },
      { ruleId: "performance.slow-resource", status: "success" },
      { ruleId: "performance.image-dimensions", status: "success" },
      { ruleId: "performance.large-dom", status: "success" }
    ],
    diagnostics: [
      {
        ruleId: "performance.large-transfer",
        severity: "medium",
        title: "Large resource transfer",
        description: "A resource transferred 900 KB.",
        location: "https://cdn.example.test/private-resource?token=do-not-disclose",
        evidence: { transferSizeBytes: 921600, initiatorType: "img", url: "https://cdn.example.test/private?token=do-not-disclose" }
      },
      {
        ruleId: "performance.slow-resource",
        severity: "high",
        title: "Slow-loading resource",
        description: "A resource took 3100 ms to load.",
        location: "https://cdn.example.test/private-resource?token=do-not-disclose",
        evidence: { durationMs: 3100, initiatorType: "script", url: "https://cdn.example.test/private?token=do-not-disclose" }
      },
      {
        ruleId: "performance.image-dimensions",
        severity: "low",
        title: "Image dimensions are not reserved",
        description: "An image does not declare both width and height.",
        location: "img.hero",
        evidence: { hasWidth: true, hasHeight: false }
      },
      {
        ruleId: "performance.large-dom",
        severity: "medium",
        title: "Large DOM tree",
        description: "The page contains 1800 DOM elements.",
        evidence: { domNodeCount: 1800, threshold: 1500 }
      }
    ],
    evidence: {
      sameOriginOnly: false,
      blockedRequests: 0,
      failedRequests: 0,
      httpErrors: 0,
      interactionStatesChecked: 0,
      axeScanCompleted: false,
      screenshotPath: null,
      networkDnsPolicy: {
        dnsRevalidatedBeforeEachHttpRequest: true,
        browserConnectionDnsPinned: false
      }
    },
    ...overrides
  };
}

test("Performance QA publishes a stable specialist-browser manifest", () => {
  const adapter = createPerformanceQaEngineAdapter();
  assert.equal(adapter.id, PERFORMANCE_QA_ADAPTER_ID);
  assert.equal(adapter.version, PERFORMANCE_QA_ADAPTER_VERSION);
  assert.equal(adapter.category, "performance");
  assert.equal(adapter.targetType, "url");
  assert.equal(adapter.executionMode, "browser");
  assert.deepEqual(adapter.capabilities, [
    "browser-resource-performance-audit",
    "large-transfer-detection",
    "slow-resource-detection",
    "image-dimension-stability",
    "dom-size-analysis",
    "bounded-findings",
    "public-target-url-safety"
  ]);
  assert.ok(Object.isFrozen(adapter));
  assert.ok(Object.isFrozen(PERFORMANCE_QA_ADAPTER_CAPABILITIES));
  assert.match(adapter.description, /no authentication, interactions, screenshots or baseline writes/iu);
});

test("registration adds metadata only and performs no navigation or network request", () => {
  const registry = createQaEngineRegistry();
  const metadata = registerPerformanceQaEngine(registry);
  assert.equal(metadata.id, PERFORMANCE_QA_ADAPTER_ID);
  assert.equal(registry.has(PERFORMANCE_QA_ADAPTER_ID), true);
  assert.deepEqual(registry.find({ category: "performance" }).map((item) => item.id), [
    PERFORMANCE_QA_ADAPTER_ID
  ]);
});

test("duplicate registration and untrusted registry shapes are rejected", () => {
  const registry = createQaEngineRegistry();
  registerPerformanceQaEngine(registry);
  assert.throws(
    () => registerPerformanceQaEngine(registry),
    (error) => error instanceof PerformanceQaAdapterError && error.code === "DUPLICATE_ENGINE"
  );
  assert.throws(
    () => registerPerformanceQaEngine({}),
    (error) => error instanceof PerformanceQaAdapterError && error.code === "INVALID_REGISTRY"
  );
  assert.throws(
    () => registerPerformanceQaEngine(Object.create({ register() {}, has() {} })),
    (error) => error instanceof PerformanceQaAdapterError && error.code === "INVALID_REGISTRY"
  );
});

test("URL and timeout validation rejects unsafe schemes, credentials and unsupported fields", async () => {
  const adapter = createPerformanceQaEngineAdapter();
  await assert.rejects(
    adapter.run({ url: "" }),
    (error) => error instanceof PerformanceQaAdapterError && error.code === "INVALID_TARGET"
  );
  await assert.rejects(
    adapter.run({ url: "file:///etc/passwd" }),
    (error) => error instanceof PerformanceQaAdapterError && error.code === "UNSUPPORTED_PROTOCOL"
  );
  await assert.rejects(
    adapter.run({ url: "https://user:password@example.com/" }),
    (error) => error instanceof PerformanceQaAdapterError && error.code === "EMBEDDED_CREDENTIALS"
  );
  await assert.rejects(
    adapter.run({ url: "https://example.com/", allowPrivateNetworks: true }),
    (error) => error instanceof PerformanceQaAdapterError && error.code === "UNSUPPORTED_FIELD"
  );
  await assert.rejects(
    adapter.run({ url: "https://example.com/", timeout: 999 }),
    (error) => error instanceof PerformanceQaAdapterError && error.code === "INVALID_TIMEOUT"
  );
  await assert.rejects(
    adapter.run({ url: "https://example.com/", timeout: 30001 }),
    (error) => error instanceof PerformanceQaAdapterError && error.code === "INVALID_TIMEOUT"
  );
});

test("command and execution option accessors are rejected without invocation", async () => {
  const adapter = createPerformanceQaEngineAdapter();
  let invoked = false;
  const command = { url: "https://example.com/" };
  Object.defineProperty(command, "timeout", {
    enumerable: true,
    get() {
      invoked = true;
      return 5000;
    }
  });
  await assert.rejects(
    adapter.run(command),
    (error) => error instanceof PerformanceQaAdapterError && error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(invoked, false);

  await assert.rejects(
    adapter.run({ url: "https://example.com/" }, { runAxe: true }),
    (error) => error instanceof PerformanceQaAdapterError && error.code === "UNSUPPORTED_FIELD"
  );
});

test("pre-aborted signals prevent browser startup", async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = createPerformanceQaEngineAdapter();
  await assert.rejects(
    adapter.run({ url: "https://example.com/" }, { signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
});

test("performance adapter delegates to the canonical specialist with isolated bounded options", async () => {
  let received;
  const adapter = createPerformanceQaEngineAdapter({
    audit: async (url, options) => {
      received = { url, options };
      return completeReport();
    }
  });

  const result = await adapter.run({ url: "https://example.test/performance", timeout: 12000 });
  assert.equal(received.url, "https://example.test/performance");
  assert.deepEqual(received.options, {
    specialist: "performance",
    timeout: 12000,
    headless: true,
    runAxe: false,
    allowPrivateNetworks: false,
    sameOriginOnly: false,
    interactionExploration: false,
    screenshotPath: null,
    screenshotFullPage: false,
    viewport: { width: 1365, height: 900 },
    colorScheme: "light"
  });
  assert.equal(result.adapter, PERFORMANCE_QA_ADAPTER_ID);
  assert.equal(result.complete, true);
  assert.equal(result.assessmentStatus, "complete");
  assert.equal(result.scoring.passed, true);
  assert.deepEqual(result.summary.observations, {
    largeTransfers: 1,
    slowResources: 1,
    imagesWithoutReservedDimensions: 1,
    largeDomTrees: 1,
    observedTransferBytes: 921600,
    slowestResourceMs: 3100,
    largestDomNodeCount: 1800
  });
  assert.equal(result.findings.length, 4);
  assert.equal(result.findings[0].metrics.transferSizeBytes, 921600);
  const output = JSON.stringify(result);
  assert.equal(output.includes("do-not-disclose"), false);
  assert.equal(output.includes("cdn.example.test"), false);
  assert.equal(output.includes("img.hero"), false);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.findings));
});

test("performance adapter caps findings and reports incomplete specialist execution", async () => {
  const diagnostics = Array.from({ length: 45 }, (_, index) => ({
    ruleId: "performance.large-transfer",
    severity: "medium",
    title: "Large resource transfer",
    description: "A bounded diagnostic.",
    evidence: { transferSizeBytes: 500000 + index, initiatorType: "img" }
  }));
  const adapter = createPerformanceQaEngineAdapter({
    audit: async () => completeReport({
      summary: { rulesExecuted: 4, rulesWithErrors: 1, specialists: ["performance"] },
      diagnostics
    })
  });
  const result = await adapter.run({ url: "https://example.test/" });
  assert.equal(result.complete, false);
  assert.equal(result.assessmentStatus, "inconclusive");
  assert.equal(result.scoring.passed, false);
  assert.equal(result.findings.length, 30);
  assert.equal(result.findingsTruncated, true);
  assert.equal(result.summary.findings, 45);
  assert.equal(result.summary.rulesWithErrors, 1);
});

test("performance adapter refuses reports outside the isolated canonical contract", async () => {
  const adapter = createPerformanceQaEngineAdapter({
    audit: async () => completeReport({
      summary: { rulesExecuted: 4, rulesWithErrors: 0, specialists: ["accessibility"] }
    })
  });
  await assert.rejects(
    adapter.run({ url: "https://example.test/" }),
    (error) => error instanceof PerformanceQaAdapterError && error.code === "UNSAFE_AUDIT_RESULT"
  );
});

test("private destinations are rejected by the canonical URL safety guard without leaking query data", async () => {
  const adapter = createPerformanceQaEngineAdapter();
  const secret = "performance-query-secret-123";
  await assert.rejects(
    adapter.run({ url: "http://127.0.0.1/?token=" + secret }),
    (error) => error instanceof PerformanceQaAdapterError &&
      error.code === "AUDIT_FAILED" &&
      !error.message.includes(secret)
  );
});

test("orchestrator requires an exact policy grant and external approval before performance execution", async () => {
  let auditCalls = 0;
  const registry = createQaEngineRegistry();
  const adapter = createPerformanceQaEngineAdapter({
    audit: async () => {
      auditCalls += 1;
      return completeReport();
    }
  });
  registry.register(adapter);
  registry.seal();

  const actionType = getQaEngineActionType(PERFORMANCE_QA_ADAPTER_ID);
  const denied = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "performance-deny-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: []
    },
    requestApproval: async () => ({ approved: true, approvalId: "must-not-be-requested" })
  });
  const deniedResult = await denied.execute({
    id: "performance-denied-plan",
    actions: [{ id: "performance-denied-action", type: actionType, input: { url: "https://example.test/" } }]
  });
  assert.equal(deniedResult.status, "blocked");
  assert.equal(auditCalls, 0);
  assert.equal(denied.verifyLedger().valid, true);

  const approvalRejected = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "performance-approval-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: [{ type: actionType, maxRisk: QA_ENGINE_ORCHESTRATOR_RISK }]
    },
    requestApproval: async () => ({ approved: false })
  });
  const rejectedResult = await approvalRejected.execute({
    id: "performance-rejected-plan",
    actions: [{ id: "performance-rejected-action", type: actionType, input: { url: "https://example.test/" } }]
  });
  assert.equal(rejectedResult.status, "blocked");
  assert.equal(auditCalls, 0);
  assert.equal(approvalRejected.verifyLedger().valid, true);

  const approved = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "performance-approved-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: [{ type: actionType, maxRisk: QA_ENGINE_ORCHESTRATOR_RISK }]
    },
    requestApproval: async () => ({ approved: true, approvalId: "performance-approval-1" })
  });
  const approvedResult = await approved.execute({
    id: "performance-approved-plan",
    actions: [{ id: "performance-approved-action", type: actionType, input: { url: "https://example.test/" } }]
  });
  assert.equal(approvedResult.status, "succeeded");
  assert.equal(approvedResult.actions[0].output.adapter, PERFORMANCE_QA_ADAPTER_ID);
  assert.equal(auditCalls, 1);
  assert.equal(approved.verifyLedger().valid, true);
});
