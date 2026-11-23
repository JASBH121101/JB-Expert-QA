import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createStaticSecurityQaEngineAdapter,
  registerStaticSecurityQaEngine,
  StaticSecurityQaAdapterError,
  STATIC_SECURITY_QA_ADAPTER_ID,
  STATIC_SECURITY_QA_ADAPTER_VERSION,
  STATIC_SECURITY_QA_ADAPTER_CAPABILITIES
} from "../src/engine-registry/adapters/static-security-qa.js";
import { createQaEngineRegistry } from "../src/engine-registry/index.js";
import {
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION,
  QA_ENGINE_ORCHESTRATOR_RISK
} from "../src/engine-registry/orchestrator.js";

async function fixtureProject() {
  const root = await mkdtemp(join(tmpdir(), "jbqa-static-security-adapter-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.js"), [
    'const endpoint = "http://api.production.example.com/v1";',
    'const resetToken = Math.random().toString(36);',
    'res.setHeader("Access-Control-Allow-Origin", "*");',
    'res.setHeader("Access-Control-Allow-Credentials", "true");'
  ].join("\n"), "utf8");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "jbqa-static-security-fixture",
    version: "1.0.0",
    private: true,
    dependencies: { lodash: "4.17.21" }
  }), "utf8");
  return root;
}

test("Static Security QA adapter publishes a stable read-only path manifest", () => {
  const adapter = createStaticSecurityQaEngineAdapter();
  assert.equal(adapter.id, STATIC_SECURITY_QA_ADAPTER_ID);
  assert.equal(adapter.version, STATIC_SECURITY_QA_ADAPTER_VERSION);
  assert.equal(adapter.category, "security");
  assert.equal(adapter.targetType, "path");
  assert.equal(adapter.executionMode, "in-process");
  assert.deepEqual(adapter.capabilities, [
    "static-security-analysis",
    "secret-pattern-detection",
    "dependency-risk-analysis",
    "security-defense-rules",
    "read-only"
  ]);
  assert.ok(Object.isFrozen(adapter));
  assert.ok(Object.isFrozen(STATIC_SECURITY_QA_ADAPTER_CAPABILITIES));
  assert.match(adapter.description, /read-only/iu);
});

test("registration adds metadata only and does not inspect a project", () => {
  const registry = createQaEngineRegistry();
  const metadata = registerStaticSecurityQaEngine(registry);
  assert.equal(metadata.id, STATIC_SECURITY_QA_ADAPTER_ID);
  assert.equal(registry.has(STATIC_SECURITY_QA_ADAPTER_ID), true);
  assert.deepEqual(registry.find({ category: "security" }).map((item) => item.id), [
    STATIC_SECURITY_QA_ADAPTER_ID
  ]);
});

test("duplicate registration, invalid registry and unsupported manifest fields are rejected", () => {
  const registry = createQaEngineRegistry();
  registerStaticSecurityQaEngine(registry);
  assert.throws(
    () => registerStaticSecurityQaEngine(registry),
    (error) => error instanceof StaticSecurityQaAdapterError && error.code === "DUPLICATE_ENGINE"
  );
  assert.throws(
    () => registerStaticSecurityQaEngine({}),
    (error) => error instanceof StaticSecurityQaAdapterError && error.code === "INVALID_REGISTRY"
  );
});

test("command validation rejects unsafe shapes, accessor properties and elevated scan limits", async () => {
  const adapter = createStaticSecurityQaEngineAdapter();
  await assert.rejects(
    adapter.run({ path: "" }),
    (error) => error instanceof StaticSecurityQaAdapterError && error.code === "INVALID_TARGET"
  );
  await assert.rejects(
    adapter.run({ path: "./project", unexpected: true }),
    (error) => error instanceof StaticSecurityQaAdapterError && error.code === "UNSUPPORTED_FIELD"
  );
  await assert.rejects(
    adapter.run({ path: "./project", productionOnly: "yes" }),
    (error) => error instanceof StaticSecurityQaAdapterError && error.code === "INVALID_SCOPE"
  );
  await assert.rejects(
    adapter.run({ path: "./project", scanOptions: { maxFiles: 2501 } }),
    (error) => error instanceof StaticSecurityQaAdapterError && error.code === "INVALID_SCAN_LIMIT"
  );

  let invoked = false;
  const command = { path: "./project" };
  Object.defineProperty(command, "productionOnly", {
    enumerable: true,
    get() {
      invoked = true;
      return false;
    }
  });
  await assert.rejects(
    adapter.run(command),
    (error) => error instanceof StaticSecurityQaAdapterError && error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(invoked, false);
});

test("execution rejects unknown options and pre-aborted signals before starting a scan", async () => {
  const adapter = createStaticSecurityQaEngineAdapter();
  await assert.rejects(
    adapter.run({ path: "./not-opened" }, { surprise: true }),
    (error) => error instanceof StaticSecurityQaAdapterError && error.code === "UNSUPPORTED_FIELD"
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    adapter.run({ path: "./not-opened" }, { signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
});

test("security findings are returned in a bounded summary without leaking credential contents", async () => {
  const root = await fixtureProject();
  const secret = "ghp_" + "B".repeat(36);
  try {
    await writeFile(join(root, "src", "credentials.js"), 'const GITHUB_TOKEN = "' + secret + '";', "utf8");
    await writeFile(join(root, ".env"), "TOKEN=environment-secret-must-not-be-reported", "utf8");

    const adapter = createStaticSecurityQaEngineAdapter();
    const result = await adapter.run({ path: root });

    assert.equal(result.adapter, STATIC_SECURITY_QA_ADAPTER_ID);
    assert.equal(result.readOnly, true);
    assert.equal(result.securityAssessment.mode, "local-static");
    assert.equal(result.securityAssessment.onlineDependencyAdvisories, false);
    assert.equal(result.securityAssessment.networkRequests, 0);
    assert.equal(result.securityAssessment.databaseConnections, 0);
    assert.equal(result.securityAssessment.projectCodeExecuted, false);
    assert.equal(result.securityAssessment.credentialContentsRead, false);
    assert.equal(result.dependencyAdvisories.enabled, false);
    assert.equal(result.dependencyAdvisories.networkRequests, 0);
    assert.equal(result.projectScan.environmentFiles, 1);
    assert.equal(result.scoring.passed, false);
    assert.ok(result.summary.bySeverity.critical > 0);
    assert.ok(result.findings.some((item) => item.id.startsWith("SEC-HTTP-")));
    assert.ok(result.findings.some((item) => item.id.startsWith("SEC-SECRET-")));
    assert.ok(result.findings.length <= 25);
    assert.equal(result.findingsTruncated, result.summary.findings > 25);

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("environment-secret-must-not-be-reported"), false);
    assert.equal(serialized.includes("evidence"), false);
    assert.equal(serialized.includes("recommendation"), false);
    assert.ok(Buffer.byteLength(serialized, "utf8") < 32768);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production-only audits exclude test fixtures while preserving application files", async () => {
  const root = await fixtureProject();
  try {
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "tests", "unsafe.test.js"), [
      'const endpoint = "http://api.test.local/v1";',
      'const resetToken = Math.random().toString(36);'
    ].join("\n"), "utf8");

    const adapter = createStaticSecurityQaEngineAdapter();
    const result = await adapter.run({ path: root, productionOnly: true });
    assert.equal(result.securityAssessment.scope, "production-source");
    assert.ok(result.securityAssessment.excludedNonProductionFiles >= 1);
    assert.ok(result.findings.some((item) => item.id.startsWith("SEC-HTTP-")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incomplete scans remain explicitly incomplete and cannot be reported as passed", async () => {
  const root = await fixtureProject();
  try {
    await mkdir(join(root, "deep", "nested"), { recursive: true });
    await writeFile(join(root, "deep", "nested", "app.js"), "export const value = true;", "utf8");
    const adapter = createStaticSecurityQaEngineAdapter();
    const result = await adapter.run({
      path: root,
      scanOptions: { maxDepth: 1 }
    });
    assert.equal(result.securityAssessment.complete, false);
    assert.equal(result.scoring.passed, false);
    assert.equal(result.scoring.blockedByCritical, true);
    assert.ok(result.securityAssessment.incompleteReasons.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestrator requires exact policy permission and external approval for Static Security QA", async () => {
  const root = await fixtureProject();
  try {
    let approvalCount = 0;
    const registry = createQaEngineRegistry();
    registerStaticSecurityQaEngine(registry);
    registry.seal();

    const actionType = getQaEngineActionType(STATIC_SECURITY_QA_ADAPTER_ID);
    const orchestrator = createQaEngineOrchestrator({
      registry,
      policy: {
        id: "static-security-qa-orchestrator-policy",
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
        return { approved: true, approvalId: "static-security-qa-approval-1" };
      }
    });

    const result = await orchestrator.execute({
      id: "static-security-plan",
      actions: [{
        id: "static-security-project-audit",
        type: actionType,
        input: { path: root }
      }]
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.actions[0].output.readOnly, true);
    assert.equal(result.actions[0].output.securityAssessment.onlineDependencyAdvisories, false);
    assert.equal(result.actions[0].output.securityAssessment.databaseConnections, 0);
    assert.equal(approvalCount, 1);
    assert.equal(orchestrator.verifyLedger().valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
