import assert from "node:assert/strict";
import test from "node:test";
import {
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QaEngineOrchestratorError,
  QA_ENGINE_EXECUTION_PERMISSION,
  QA_ENGINE_ORCHESTRATOR_RISK
} from "../src/engine-registry/orchestrator.js";
import { createQaEngineRegistry } from "../src/engine-registry/index.js";

function registerEcho(registry, run = async (input) => ({ echoed: input.value })) {
  return registry.register({
    id: "jb.test.echo",
    name: "Echo QA",
    version: "1.0.0",
    category: "audit",
    targetType: "payload",
    executionMode: "in-process",
    capabilities: ["echo"],
    run
  });
}

function policy(overrides = {}) {
  return {
    id: "orchestrator-test-policy",
    grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
    rules: [{
      type: getQaEngineActionType("jb.test.echo"),
      maxRisk: QA_ENGINE_ORCHESTRATOR_RISK
    }],
    limits: {
      maxActions: 4,
      maxExecutionMs: 3000,
      maxActionMs: 1000,
      approvalTimeoutMs: 1000,
      maxInputBytes: 4096,
      maxOutputBytes: 4096
    },
    ...overrides
  };
}

function plan(input = { value: "safe" }) {
  return {
    id: "engine-plan-1",
    actions: [{
      id: "echo-action-1",
      type: getQaEngineActionType("jb.test.echo"),
      input
    }]
  };
}

test("derives stable action types and rejects malformed engine identifiers", () => {
  assert.equal(getQaEngineActionType("jb.api-testing-engine"), "qa.engine.jb.api-testing-engine");
  assert.throws(
    () => getQaEngineActionType("../shell"),
    (error) => error instanceof QaEngineOrchestratorError && error.code === "INVALID_ENGINE_ID"
  );
});

test("requires a sealed registry before constructing the orchestrator", () => {
  const registry = createQaEngineRegistry();
  registerEcho(registry);
  assert.throws(
    () => createQaEngineOrchestrator({ registry }),
    (error) => error instanceof QaEngineOrchestratorError && error.code === "REGISTRY_NOT_SEALED"
  );
});

test("construction and discovery never invoke a registered engine runner", () => {
  let calls = 0;
  const registry = createQaEngineRegistry();
  registerEcho(registry, async () => { calls += 1; return { ok: true }; });
  registry.seal();

  const orchestrator = createQaEngineOrchestrator({ registry });
  assert.equal(calls, 0);
  assert.deepEqual(orchestrator.listEngines().map((item) => item.id), ["jb.test.echo"]);
  assert.equal(calls, 0);
  assert.deepEqual(orchestrator.getPolicy().allowedActions, []);
});

test("executes only an explicitly allowlisted engine after permission and external approval", async () => {
  let receivedSignal = null;
  let calls = 0;
  const registry = createQaEngineRegistry();
  registerEcho(registry, async (input, options) => {
    calls += 1;
    receivedSignal = options.signal;
    return { echoed: input.value };
  });
  registry.seal();

  let approvalRequests = 0;
  const orchestrator = createQaEngineOrchestrator({
    registry,
    policy: policy(),
    requestApproval: async (request) => {
      approvalRequests += 1;
      assert.equal(request.actionType, getQaEngineActionType("jb.test.echo"));
      assert.equal(request.risk, "high");
      assert.equal(request.input, undefined, "approval receives a digest, not raw engine input");
      assert.equal(typeof request.inputDigest, "string");
      return { approved: true, approvalId: "approval-echo-1" };
    }
  });

  const result = await orchestrator.execute(plan());
  assert.equal(result.status, "succeeded");
  assert.equal(result.actions[0].output.echoed, "safe");
  assert.equal(approvalRequests, 1);
  assert.equal(calls, 1);
  assert.ok(receivedSignal && typeof receivedSignal.aborted === "boolean");
  assert.equal(orchestrator.verifyLedger().valid, true);
});

test("a registered engine is blocked when its exact action type is absent from policy", async () => {
  let calls = 0;
  const registry = createQaEngineRegistry();
  registerEcho(registry, async () => { calls += 1; return { ok: true }; });
  registry.seal();
  const orchestrator = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "deny-engine-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: []
    },
    requestApproval: async () => ({ approved: true, approvalId: "approval-ignored" })
  });

  const result = await orchestrator.execute(plan());
  assert.equal(result.status, "blocked");
  assert.equal(calls, 0);
});

test("an approval cannot compensate for a missing preauthorized permission", async () => {
  let calls = 0;
  let approvals = 0;
  const registry = createQaEngineRegistry();
  registerEcho(registry, async () => { calls += 1; return { ok: true }; });
  registry.seal();
  const orchestrator = createQaEngineOrchestrator({
    registry,
    policy: policy({ grantedPermissions: [] }),
    requestApproval: async () => { approvals += 1; return { approved: true, approvalId: "approval-ignored" }; }
  });

  const result = await orchestrator.execute(plan());
  assert.equal(result.status, "blocked");
  assert.equal(calls, 0);
  assert.equal(approvals, 0);
});

test("missing or denied external approval blocks the engine without invoking it", async () => {
  let calls = 0;
  const registry = createQaEngineRegistry();
  registerEcho(registry, async () => { calls += 1; return { ok: true }; });
  registry.seal();

  const noProvider = createQaEngineOrchestrator({ registry, policy: policy() });
  const noApproval = await noProvider.execute(plan());
  assert.equal(noApproval.status, "blocked");
  assert.equal(calls, 0);

  const denied = createQaEngineOrchestrator({
    registry,
    policy: policy(),
    requestApproval: async () => ({ approved: false })
  });
  const deniedResult = await denied.execute(plan());
  assert.equal(deniedResult.status, "blocked");
  assert.equal(calls, 0);
});

test("engine invocation is auditable without persisting raw inputs or outputs", async () => {
  const secret = "private-engine-payload";
  const registry = createQaEngineRegistry();
  registerEcho(registry, async (input) => ({ echoed: input.value }));
  registry.seal();
  const orchestrator = createQaEngineOrchestrator({
    registry,
    policy: policy(),
    requestApproval: async () => ({ approved: true, approvalId: "approval-audit-1" })
  });

  await orchestrator.execute(plan({ value: secret }));
  const ledger = JSON.stringify(orchestrator.getLedger());
  assert.equal(ledger.includes(secret), false);
  assert.equal(orchestrator.verifyLedger().valid, true);
});
