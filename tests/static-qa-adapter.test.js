import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createStaticQaEngineAdapter,
  registerStaticQaEngine,
  StaticQaAdapterError,
  STATIC_QA_ADAPTER_ID,
  STATIC_QA_ADAPTER_VERSION,
  STATIC_QA_ADAPTER_CAPABILITIES
} from "../src/engine-registry/adapters/static-qa.js";
import { createQaEngineRegistry } from "../src/engine-registry/index.js";
import {
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION,
  QA_ENGINE_ORCHESTRATOR_RISK
} from "../src/engine-registry/orchestrator.js";

async function fixtureProject() {
  const root = await mkdtemp(join(tmpdir(), "jbqa-static-adapter-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.js"), "export const staticQaFixture = true;\n", "utf8");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "jbqa-static-adapter-fixture",
    version: "1.0.0",
    private: true
  }), "utf8");
  return root;
}

test("Static QA adapter publishes a stable read-only path manifest", () => {
  const adapter = createStaticQaEngineAdapter();
  assert.equal(adapter.id, STATIC_QA_ADAPTER_ID);
  assert.equal(adapter.version, STATIC_QA_ADAPTER_VERSION);
  assert.equal(adapter.category, "audit");
  assert.equal(adapter.targetType, "path");
  assert.equal(adapter.executionMode, "in-process");
  assert.deepEqual(adapter.capabilities, [
    "project-source-audit",
    "dependency-manifest-audit",
    "dead-code-audit",
    "language-audit",
    "read-only"
  ]);
  assert.ok(Object.isFrozen(adapter));
  assert.ok(Object.isFrozen(STATIC_QA_ADAPTER_CAPABILITIES));
  assert.match(adapter.description, /read-only/iu);
});

test("registration adds metadata without scanning a project", () => {
  const registry = createQaEngineRegistry();
  const metadata = registerStaticQaEngine(registry);
  assert.equal(metadata.id, STATIC_QA_ADAPTER_ID);
  assert.equal(registry.has(STATIC_QA_ADAPTER_ID), true);
  assert.deepEqual(registry.find({ category: "audit" }).map((item) => item.id), [STATIC_QA_ADAPTER_ID]);
});

test("duplicate registration, invalid registry and unknown manifest options are rejected", () => {
  const registry = createQaEngineRegistry();
  registerStaticQaEngine(registry);
  assert.throws(
    () => registerStaticQaEngine(registry),
    (error) => error instanceof StaticQaAdapterError && error.code === "DUPLICATE_ENGINE"
  );
  assert.throws(
    () => registerStaticQaEngine({}),
    (error) => error instanceof StaticQaAdapterError && error.code === "INVALID_REGISTRY"
  );
});

test("static command validates target, options and rejects accessors", async () => {
  const adapter = createStaticQaEngineAdapter();
  await assert.rejects(
    adapter.run({ path: "" }),
    (error) => error instanceof StaticQaAdapterError && error.code === "INVALID_TARGET"
  );
  await assert.rejects(
    adapter.run({ path: "./project", unexpected: true }),
    (error) => error instanceof StaticQaAdapterError && error.code === "UNSUPPORTED_FIELD"
  );
  await assert.rejects(
    adapter.run({ path: "./project", scanOptions: { maxFiles: 2501 } }),
    (error) => error instanceof StaticQaAdapterError && error.code === "INVALID_SCAN_LIMIT"
  );
  let invoked = false;
  const input = { path: "./project" };
  Object.defineProperty(input, "scanOptions", {
    enumerable: true,
    get() {
      invoked = true;
      return {};
    }
  });
  await assert.rejects(
    adapter.run(input),
    (error) => error instanceof StaticQaAdapterError && error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(invoked, false);
});

test("pre-aborted signals stop before the static filesystem audit starts", async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = createStaticQaEngineAdapter();
  await assert.rejects(
    adapter.run({ path: "./does-not-matter" }, { signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
});

test("static audit returns a bounded summary and keeps advisory lookups offline", async () => {
  const root = await fixtureProject();
  try {
    const adapter = createStaticQaEngineAdapter();
    const result = await adapter.run({
      path: root,
      scanOptions: {
        maxFiles: 100,
        maxFileBytes: 100_000,
        maxTotalBytes: 500_000,
        maxDepth: 8
      }
    });

    assert.equal(result.adapter, STATIC_QA_ADAPTER_ID);
    assert.equal(result.readOnly, true);
    assert.equal(typeof result.scoring.passed, "boolean");
    assert.ok(Number.isFinite(result.scoring.score));
    assert.ok(result.summary.rulesExecuted > 0);
    assert.ok(result.analysisScope.filesAnalyzed >= 2);
    assert.equal(result.dependencyAdvisories.enabled, false);
    assert.equal(result.dependencyAdvisories.networkRequests, 0);
    assert.ok(result.findings.length <= 25);
    assert.equal(result.findingsTruncated, result.summary.findings > 25);
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 32768);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestrator runs Static QA only through an explicit high-risk approval and permission", async () => {
  const root = await fixtureProject();
  try {
    let approvalCount = 0;
    const registry = createQaEngineRegistry();
    registerStaticQaEngine(registry);
    registry.seal();

    const actionType = getQaEngineActionType(STATIC_QA_ADAPTER_ID);
    const orchestrator = createQaEngineOrchestrator({
      registry,
      policy: {
        id: "static-qa-orchestrator-policy",
        grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
        rules: [{ type: actionType, maxRisk: QA_ENGINE_ORCHESTRATOR_RISK }],
        limits: {
          maxActions: 2,
          maxExecutionMs: 30000,
          maxActionMs: 25000,
          approvalTimeoutMs: 5000,
          maxInputBytes: 4096,
          maxOutputBytes: 32768
        }
      },
      requestApproval: async (request) => {
        approvalCount += 1;
        assert.equal(request.actionType, actionType);
        assert.equal(request.risk, "high");
        return { approved: true, approvalId: "static-qa-approval-1" };
      }
    });

    const result = await orchestrator.execute({
      id: "static-qa-plan",
      actions: [{
        id: "static-qa-project-audit",
        type: actionType,
        input: { path: root }
      }]
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.actions[0].output.readOnly, true);
    assert.equal(result.actions[0].output.dependencyAdvisories.networkRequests, 0);
    assert.equal(approvalCount, 1);
    assert.equal(orchestrator.verifyLedger().valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
