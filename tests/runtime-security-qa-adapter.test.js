import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeSecurityQaEngineAdapter,
  registerRuntimeSecurityQaEngine,
  RuntimeSecurityQaAdapterError,
  RUNTIME_SECURITY_QA_ADAPTER_ID,
  RUNTIME_SECURITY_QA_ADAPTER_VERSION,
  RUNTIME_SECURITY_QA_ADAPTER_CAPABILITIES
} from "../src/engine-registry/adapters/runtime-security-qa.js";
import { createQaEngineRegistry } from "../src/engine-registry/index.js";
import {
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION,
  QA_ENGINE_ORCHESTRATOR_RISK
} from "../src/engine-registry/orchestrator.js";

test("Runtime Security QA publishes a stable passive-browser manifest", () => {
  const adapter = createRuntimeSecurityQaEngineAdapter();
  assert.equal(adapter.id, RUNTIME_SECURITY_QA_ADAPTER_ID);
  assert.equal(adapter.version, RUNTIME_SECURITY_QA_ADAPTER_VERSION);
  assert.equal(adapter.category, "security");
  assert.equal(adapter.targetType, "url");
  assert.equal(adapter.executionMode, "browser");
  assert.deepEqual(adapter.capabilities, [
    "runtime-security-analysis",
    "transport-security-observation",
    "security-header-audit",
    "cookie-attribute-audit",
    "mixed-content-observation",
    "passive-browser-observation"
  ]);
  assert.ok(Object.isFrozen(adapter));
  assert.ok(Object.isFrozen(RUNTIME_SECURITY_QA_ADAPTER_CAPABILITIES));
  assert.match(adapter.description, /passive browser observation/iu);
});

test("registration adds metadata only and makes no browser or network request", () => {
  const registry = createQaEngineRegistry();
  const metadata = registerRuntimeSecurityQaEngine(registry);
  assert.equal(metadata.id, RUNTIME_SECURITY_QA_ADAPTER_ID);
  assert.equal(registry.has(RUNTIME_SECURITY_QA_ADAPTER_ID), true);
  assert.deepEqual(registry.find({ category: "security" }).map((item) => item.id), [
    RUNTIME_SECURITY_QA_ADAPTER_ID
  ]);
});

test("duplicate registration and untrusted registry shapes are rejected", () => {
  const registry = createQaEngineRegistry();
  registerRuntimeSecurityQaEngine(registry);
  assert.throws(
    () => registerRuntimeSecurityQaEngine(registry),
    (error) => error instanceof RuntimeSecurityQaAdapterError && error.code === "DUPLICATE_ENGINE"
  );
  assert.throws(
    () => registerRuntimeSecurityQaEngine({}),
    (error) => error instanceof RuntimeSecurityQaAdapterError && error.code === "INVALID_REGISTRY"
  );
  assert.throws(
    () => registerRuntimeSecurityQaEngine(Object.create({ register() {}, has() {} })),
    (error) => error instanceof RuntimeSecurityQaAdapterError && error.code === "INVALID_REGISTRY"
  );
});

test("URL and timeout validation rejects unsafe schemes, credentials and unsupported fields", async () => {
  const adapter = createRuntimeSecurityQaEngineAdapter();
  await assert.rejects(
    adapter.run({ url: "" }),
    (error) => error instanceof RuntimeSecurityQaAdapterError && error.code === "INVALID_TARGET"
  );
  await assert.rejects(
    adapter.run({ url: "file:///etc/passwd" }),
    (error) => error instanceof RuntimeSecurityQaAdapterError && error.code === "UNSUPPORTED_PROTOCOL"
  );
  await assert.rejects(
    adapter.run({ url: "https://user:password@example.com/" }),
    (error) => error instanceof RuntimeSecurityQaAdapterError && error.code === "EMBEDDED_CREDENTIALS"
  );
  await assert.rejects(
    adapter.run({ url: "https://example.com/", allowPrivateNetworks: true }),
    (error) => error instanceof RuntimeSecurityQaAdapterError && error.code === "UNSUPPORTED_FIELD"
  );
  await assert.rejects(
    adapter.run({ url: "https://example.com/", timeout: 999 }),
    (error) => error instanceof RuntimeSecurityQaAdapterError && error.code === "INVALID_TIMEOUT"
  );
  await assert.rejects(
    adapter.run({ url: "https://example.com/", timeout: 60001 }),
    (error) => error instanceof RuntimeSecurityQaAdapterError && error.code === "INVALID_TIMEOUT"
  );
});

test("command and execution option accessors are rejected without invocation", async () => {
  const adapter = createRuntimeSecurityQaEngineAdapter();
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
    (error) => error instanceof RuntimeSecurityQaAdapterError && error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(invoked, false);

  await assert.rejects(
    adapter.run({ url: "https://example.com/" }, { allowPrivateNetworks: true }),
    (error) => error instanceof RuntimeSecurityQaAdapterError && error.code === "UNSUPPORTED_FIELD"
  );
});

test("pre-aborted signals prevent browser startup", async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = createRuntimeSecurityQaEngineAdapter();
  await assert.rejects(
    adapter.run({ url: "https://example.com/" }, { signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
});

test("private destinations are rejected before Chromium can contact them and errors are redacted", async () => {
  const adapter = createRuntimeSecurityQaEngineAdapter();
  const secret = "runtime-query-secret-123";
  for (const url of [
    "http://127.0.0.1/?token=" + secret,
    "http://localhost/?token=" + secret,
    "http://192.168.1.10/?token=" + secret,
    "http://169.254.169.254/latest/meta-data/?token=" + secret
  ]) {
    await assert.rejects(
      adapter.run({ url }),
      (error) => error instanceof RuntimeSecurityQaAdapterError &&
        error.code === "AUDIT_FAILED" &&
        !error.message.includes(secret) &&
        !error.message.includes(url)
    );
  }
});

test("orchestrator blocks a runtime audit without an exact policy rule or approval", async () => {
  const registry = createQaEngineRegistry();
  registerRuntimeSecurityQaEngine(registry);
  registry.seal();

  const actionType = getQaEngineActionType(RUNTIME_SECURITY_QA_ADAPTER_ID);
  let approvalRequests = 0;
  const orchestrator = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "runtime-security-deny-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: []
    },
    requestApproval: async () => {
      approvalRequests += 1;
      return { approved: true, approvalId: "must-not-be-requested" };
    }
  });

  const result = await orchestrator.execute({
    id: "runtime-security-deny-plan",
    actions: [{
      id: "runtime-security-action",
      type: actionType,
      input: { url: "https://example.com/" }
    }]
  });
  assert.equal(result.status, "blocked");
  assert.equal(approvalRequests, 0);
  assert.equal(orchestrator.verifyLedger().valid, true);
});

test("orchestrator requires an external approval receipt before invoking the browser adapter", async () => {
  const registry = createQaEngineRegistry();
  registerRuntimeSecurityQaEngine(registry);
  registry.seal();
  const actionType = getQaEngineActionType(RUNTIME_SECURITY_QA_ADAPTER_ID);
  const orchestrator = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "runtime-security-approval-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: [{ type: actionType, maxRisk: QA_ENGINE_ORCHESTRATOR_RISK }]
    },
    requestApproval: async () => ({ approved: false })
  });
  const result = await orchestrator.execute({
    id: "runtime-security-approval-plan",
    actions: [{
      id: "runtime-security-action",
      type: actionType,
      input: { url: "https://example.com/" }
    }]
  });
  assert.equal(result.status, "blocked");
  assert.equal(orchestrator.verifyLedger().valid, true);
});
