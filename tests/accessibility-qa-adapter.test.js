import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccessibilityQaEngineAdapter,
  registerAccessibilityQaEngine,
  AccessibilityQaAdapterError,
  ACCESSIBILITY_QA_ADAPTER_ID,
  ACCESSIBILITY_QA_ADAPTER_VERSION,
  ACCESSIBILITY_QA_ADAPTER_CAPABILITIES
} from "../src/engine-registry/adapters/accessibility-qa.js";
import { createQaEngineRegistry } from "../src/engine-registry/index.js";
import {
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION,
  QA_ENGINE_ORCHESTRATOR_RISK
} from "../src/engine-registry/orchestrator.js";

test("Accessibility QA publishes a stable specialist-browser manifest", () => {
  const adapter = createAccessibilityQaEngineAdapter();
  assert.equal(adapter.id, ACCESSIBILITY_QA_ADAPTER_ID);
  assert.equal(adapter.version, ACCESSIBILITY_QA_ADAPTER_VERSION);
  assert.equal(adapter.category, "accessibility");
  assert.equal(adapter.targetType, "url");
  assert.equal(adapter.executionMode, "browser");
  assert.deepEqual(adapter.capabilities, [
    "wcag-automated-audit",
    "axe-core",
    "image-alternative-text",
    "programmatic-form-labels",
    "document-language",
    "heading-hierarchy",
    "same-origin-browser-audit"
  ]);
  assert.ok(Object.isFrozen(adapter));
  assert.ok(Object.isFrozen(ACCESSIBILITY_QA_ADAPTER_CAPABILITIES));
  assert.match(adapter.description, /same-origin requests only/iu);
});

test("registration adds metadata only and makes no browser or network request", () => {
  const registry = createQaEngineRegistry();
  const metadata = registerAccessibilityQaEngine(registry);
  assert.equal(metadata.id, ACCESSIBILITY_QA_ADAPTER_ID);
  assert.equal(registry.has(ACCESSIBILITY_QA_ADAPTER_ID), true);
  assert.deepEqual(registry.find({ category: "accessibility" }).map((item) => item.id), [
    ACCESSIBILITY_QA_ADAPTER_ID
  ]);
});

test("duplicate registration and untrusted registry shapes are rejected", () => {
  const registry = createQaEngineRegistry();
  registerAccessibilityQaEngine(registry);
  assert.throws(
    () => registerAccessibilityQaEngine(registry),
    (error) => error instanceof AccessibilityQaAdapterError && error.code === "DUPLICATE_ENGINE"
  );
  assert.throws(
    () => registerAccessibilityQaEngine({}),
    (error) => error instanceof AccessibilityQaAdapterError && error.code === "INVALID_REGISTRY"
  );
  assert.throws(
    () => registerAccessibilityQaEngine(Object.create({ register() {}, has() {} })),
    (error) => error instanceof AccessibilityQaAdapterError && error.code === "INVALID_REGISTRY"
  );
});

test("URL and timeout validation rejects unsafe schemes, credentials and unsupported fields", async () => {
  const adapter = createAccessibilityQaEngineAdapter();
  await assert.rejects(
    adapter.run({ url: "" }),
    (error) => error instanceof AccessibilityQaAdapterError && error.code === "INVALID_TARGET"
  );
  await assert.rejects(
    adapter.run({ url: "file:///etc/passwd" }),
    (error) => error instanceof AccessibilityQaAdapterError && error.code === "UNSUPPORTED_PROTOCOL"
  );
  await assert.rejects(
    adapter.run({ url: "https://user:password@example.com/" }),
    (error) => error instanceof AccessibilityQaAdapterError && error.code === "EMBEDDED_CREDENTIALS"
  );
  await assert.rejects(
    adapter.run({ url: "https://example.com/", allowPrivateNetworks: true }),
    (error) => error instanceof AccessibilityQaAdapterError && error.code === "UNSUPPORTED_FIELD"
  );
  await assert.rejects(
    adapter.run({ url: "https://example.com/", timeout: 999 }),
    (error) => error instanceof AccessibilityQaAdapterError && error.code === "INVALID_TIMEOUT"
  );
  await assert.rejects(
    adapter.run({ url: "https://example.com/", timeout: 30001 }),
    (error) => error instanceof AccessibilityQaAdapterError && error.code === "INVALID_TIMEOUT"
  );
});

test("command and execution option accessors are rejected without invocation", async () => {
  const adapter = createAccessibilityQaEngineAdapter();
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
    (error) => error instanceof AccessibilityQaAdapterError && error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(invoked, false);

  await assert.rejects(
    adapter.run({ url: "https://example.com/" }, { runAxe: false }),
    (error) => error instanceof AccessibilityQaAdapterError && error.code === "UNSUPPORTED_FIELD"
  );
});

test("pre-aborted signals prevent browser startup", async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = createAccessibilityQaEngineAdapter();
  await assert.rejects(
    adapter.run({ url: "https://example.com/" }, { signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
});

test("private and reserved destinations are rejected without leaking query data", async () => {
  const adapter = createAccessibilityQaEngineAdapter();
  const secret = "accessibility-query-secret-123";
  for (const url of [
    "http://127.0.0.1/?token=" + secret,
    "http://localhost/?token=" + secret,
    "http://192.168.1.10/?token=" + secret,
    "http://169.254.169.254/latest/meta-data/?token=" + secret,
    "http://[::1]/?token=" + secret
  ]) {
    await assert.rejects(
      adapter.run({ url }),
      (error) => error instanceof AccessibilityQaAdapterError &&
        error.code === "AUDIT_FAILED" &&
        !error.message.includes(secret) &&
        !error.message.includes(url)
    );
  }
});

test("orchestrator blocks an accessibility audit without an exact policy rule or approval", async () => {
  const registry = createQaEngineRegistry();
  registerAccessibilityQaEngine(registry);
  registry.seal();

  const actionType = getQaEngineActionType(ACCESSIBILITY_QA_ADAPTER_ID);
  let approvalRequests = 0;
  const orchestrator = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "accessibility-deny-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: []
    },
    requestApproval: async () => {
      approvalRequests += 1;
      return { approved: true, approvalId: "must-not-be-requested" };
    }
  });

  const result = await orchestrator.execute({
    id: "accessibility-deny-plan",
    actions: [{
      id: "accessibility-action",
      type: actionType,
      input: { url: "https://example.com/" }
    }]
  });
  assert.equal(result.status, "blocked");
  assert.equal(approvalRequests, 0);
  assert.equal(orchestrator.verifyLedger().valid, true);
});

test("orchestrator requires external approval before invoking the accessibility browser adapter", async () => {
  const registry = createQaEngineRegistry();
  registerAccessibilityQaEngine(registry);
  registry.seal();

  const actionType = getQaEngineActionType(ACCESSIBILITY_QA_ADAPTER_ID);
  const orchestrator = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "accessibility-approval-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: [{ type: actionType, maxRisk: QA_ENGINE_ORCHESTRATOR_RISK }]
    },
    requestApproval: async () => ({ approved: false })
  });

  const result = await orchestrator.execute({
    id: "accessibility-approval-plan",
    actions: [{
      id: "accessibility-action",
      type: actionType,
      input: { url: "https://example.com/" }
    }]
  });
  assert.equal(result.status, "blocked");
  assert.equal(orchestrator.verifyLedger().valid, true);
});
