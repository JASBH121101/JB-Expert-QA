import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPhase4AutonomousHostBootstrap, Phase4AutonomousHostIntegrationError } from "../src/agent/phase4-autonomous-host-bootstrap.js";
import { getQaEngineActionType, QA_ENGINE_EXECUTION_PERMISSION } from "../src/engine-registry/orchestrator.js";

const STATIC_ACTION = getQaEngineActionType("jb.static-qa-engine");
const ORIGIN = "https://api.example.test";
function makePolicy() {
  return {
    id: "phase5-block13-9-static-test-policy",
    grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
    rules: [{ type: STATIC_ACTION, maxRisk: "high" }],
    limits: { maxActions: 3, maxExecutionMs: 20000, maxActionMs: 10000, approvalTimeoutMs: 5000, maxInputBytes: 4096, maxOutputBytes: 16384 }
  };
}
function options(storageDirectory, extra = {}) {
  return {
    storageDirectory,
    enabled: true,
    signalSource: new EventEmitter(),
    apiAllowedOrigins: [ORIGIN],
    policy: makePolicy(),
    requestApproval: async request => ({ approved: true, approvalId: "lab-approval-" + request.executionId }),
    hostOptions: { pollIntervalMs: 100 },
    ...extra
  };
}
async function waitForJob(host, id, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = host.getJob(id);
    if (["completed", "failed", "interrupted"].includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("timed out waiting for autonomous host job");
}

test("Phase 4 host factory requires explicit enablement, policy, approval and exact API origins", () => {
  assert.throws(() => createPhase4AutonomousHostBootstrap({ enabled: false }), error => error instanceof Phase4AutonomousHostIntegrationError && error.code === "HOST_ENABLE_OPT_IN_REQUIRED");
  assert.throws(() => createPhase4AutonomousHostBootstrap({ enabled: true }), error => error instanceof Phase4AutonomousHostIntegrationError && error.code === "POLICY_REQUIRED");
  const minimal = { enabled: true, policy: makePolicy(), signalSource: new EventEmitter(), storageDirectory: "/tmp/jbqa-host-test", apiAllowedOrigins: [ORIGIN] };
  assert.throws(() => createPhase4AutonomousHostBootstrap(minimal), error => error instanceof Phase4AutonomousHostIntegrationError && error.code === "APPROVAL_PROVIDER_REQUIRED");
  assert.throws(() => createPhase4AutonomousHostBootstrap({ ...minimal, requestApproval: async () => ({ approved: true, approvalId: "x" }), apiAllowedOrigins: ["https://*.example.test"] }), error => error instanceof Phase4AutonomousHostIntegrationError && error.code === "INVALID_API_ORIGIN");
  assert.throws(() => createPhase4AutonomousHostBootstrap({ ...minimal, requestApproval: async () => ({ approved: true, approvalId: "x" }), apiAllowedOrigins: [] }), error => error instanceof Phase4AutonomousHostIntegrationError && error.code === "API_ORIGIN_ALLOWLIST_REQUIRED");
});

test("Phase 4 built-in catalog is wired to the host without starting runners during construction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jbqa-phase4-host-inert-"));
  const config = options(directory);
  const signalSource = config.signalSource;
  let approvals = 0;
  config.requestApproval = async () => { approvals += 1; return { approved: true, approvalId: "approval-inert" }; };
  const host = createPhase4AutonomousHostBootstrap(config);
  assert.equal(host.registry.isSealed(), true);
  assert.equal(host.registry.list().length, 8);
  assert.equal(host.orchestrator.listEngines().length, 8);
  assert.equal((await host.getStatus()).state, "idle");
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  assert.equal(approvals, 0);
  await rm(directory, { recursive: true, force: true });
});

test("real Static QA action runs through host queue, orchestrator policy and external approval", async () => {
  const storage = await mkdtemp(join(tmpdir(), "jbqa-phase4-host-storage-"));
  const project = await mkdtemp(join(tmpdir(), "jbqa-phase4-host-project-"));
  const signalSource = new EventEmitter();
  const approvals = [];
  const host = createPhase4AutonomousHostBootstrap(options(storage, {
    signalSource,
    requestApproval: async request => {
      approvals.push(request);
      assert.equal(request.actionType, STATIC_ACTION);
      assert.equal(request.risk, "high");
      assert.equal(request.input, undefined);
      assert.equal(typeof request.inputDigest, "string");
      return { approved: true, approvalId: "lab-static-approval-1" };
    }
  }));
  try {
    const preflight = await host.preflight();
    assert.equal(preflight.passed, true);
    assert.equal(preflight.engineCount, 8);
    assert.equal(preflight.allowedEngineCount, 1);
    const started = await host.start();
    assert.equal(started.state, "running");
    assert.equal((await host.getReadiness()).ready, true);
    await writeFile(join(project, "sample.js"), "export const answer = 42;\n", "utf8");
    const queued = host.enqueue({
      id: "phase5-block13-9-static-plan",
      actions: [{ id: "static-qa-run", type: STATIC_ACTION, input: { path: project } }]
    });
    const completed = await waitForJob(host, queued.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.status, "succeeded");
    assert.equal(completed.result.actions[0].status, "succeeded");
    assert.equal(completed.result.actions[0].output.adapter, "jb.static-qa-engine");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].actionType, STATIC_ACTION);
    assert.equal(host.orchestrator.verifyLedger().valid, true);
    assert.equal(host.getStatus().host.queuePersistenceEnabled, true);
  } finally {
    await host.stop();
    await rm(storage, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});
