import assert from "node:assert/strict";
import test from "node:test";
import {
  createAutonomousExecutionRuntime,
  AutonomousExecutionRuntimeError
} from "../src/agent/execution-runtime.js";

function createOrchestrator(execute = async () => ({ status: "succeeded" })) {
  let calls = 0;
  const orchestrator = Object.freeze({
    listEngines: () => Object.freeze([
      Object.freeze({ id: "jb.test.echo", name: "Echo QA" })
    ]),
    getPolicy: () => Object.freeze({
      id: "runtime-test-policy",
      grantedPermissions: Object.freeze([]),
      allowedActions: Object.freeze([]),
      limits: Object.freeze({})
    }),
    verifyLedger: async () => Object.freeze({ valid: true, entries: 0 }),
    execute: async (...args) => {
      calls += 1;
      return execute(...args);
    }
  });
  return {
    orchestrator,
    get calls() { return calls; }
  };
}

test("runtime is disabled by default and does not invoke an engine during construction", async () => {
  const fixture = createOrchestrator();
  const runtime = createAutonomousExecutionRuntime({ orchestrator: fixture.orchestrator });

  assert.deepEqual(runtime.getStatus(), {
    state: "disabled",
    enabled: false,
    accepting: false,
    active: false,
    engineCount: 1,
    policyId: "runtime-test-policy"
  });
  assert.equal(runtime.listEngines()[0].id, "jb.test.echo");
  assert.equal(fixture.calls, 0);
  await assert.rejects(
    runtime.execute({ id: "plan-1", actions: [] }),
    (error) => error instanceof AutonomousExecutionRuntimeError && error.code === "RUNTIME_DISABLED"
  );
  assert.equal(fixture.calls, 0);
});

test("runtime requires an explicit opt-in and delegates execution only to the trusted orchestrator", async () => {
  const fixture = createOrchestrator(async (plan, options) => ({
    status: "succeeded",
    planId: plan.id,
    executionId: options.executionId
  }));
  const runtime = createAutonomousExecutionRuntime({
    orchestrator: fixture.orchestrator,
    enabled: true
  });

  assert.equal(runtime.getStatus().state, "ready");
  assert.equal(fixture.calls, 0);
  const result = await runtime.execute(
    { id: "plan-1", actions: [{ id: "action-1", type: "qa.engine.jb.test.echo", input: {} }] },
    { executionId: "runtime-execution-1" }
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.executionId, "runtime-execution-1");
  assert.equal(fixture.calls, 1);
  assert.equal(runtime.getStatus().state, "ready");
  assert.equal(runtime.getStatus().active, false);
});

test("runtime enforces a single active execution and returns to ready after completion", async () => {
  let release;
  const fixture = createOrchestrator(() => new Promise((resolve) => { release = resolve; }));
  const runtime = createAutonomousExecutionRuntime({ orchestrator: fixture.orchestrator, enabled: true });

  const first = runtime.execute({ id: "plan-1", actions: [] });
  await Promise.resolve();
  assert.equal(runtime.getStatus().state, "running");
  assert.equal(runtime.getStatus().active, true);
  await assert.rejects(
    runtime.execute({ id: "plan-2", actions: [] }),
    (error) => error.code === "RUNTIME_BUSY"
  );
  assert.equal(fixture.calls, 1);

  release({ status: "succeeded" });
  await first;
  assert.equal(runtime.getStatus().state, "ready");
  assert.equal(runtime.getStatus().active, false);
});

test("runtime rejects unsupported execution options and accessors without evaluating getters", async () => {
  const fixture = createOrchestrator();
  const runtime = createAutonomousExecutionRuntime({ orchestrator: fixture.orchestrator, enabled: true });
  let getterInvoked = false;
  const unsafeOptions = {};
  Object.defineProperty(unsafeOptions, "executionId", {
    enumerable: true,
    get() {
      getterInvoked = true;
      return "runtime-execution-2";
    }
  });

  await assert.rejects(
    runtime.execute({ id: "plan-1", actions: [] }, unsafeOptions),
    (error) => error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(getterInvoked, false);
  await assert.rejects(
    runtime.execute({ id: "plan-1", actions: [] }, { policy: { allowAll: true } }),
    (error) => error.code === "UNSUPPORTED_OPTION"
  );
  assert.equal(fixture.calls, 0);
});

test("runtime rejects invalid orchestrators and enabled configuration", () => {
  assert.throws(
    () => createAutonomousExecutionRuntime({ orchestrator: {} }),
    (error) => error instanceof AutonomousExecutionRuntimeError && error.code === "INVALID_ORCHESTRATOR"
  );
  const fixture = createOrchestrator();
  assert.throws(
    () => createAutonomousExecutionRuntime({ orchestrator: fixture.orchestrator, enabled: "yes" }),
    (error) => error.code === "INVALID_ENABLED_FLAG"
  );
});

test("close stops admission and drains the active execution before completing shutdown", async () => {
  let release;
  const fixture = createOrchestrator(() => new Promise((resolve) => { release = resolve; }));
  const runtime = createAutonomousExecutionRuntime({ orchestrator: fixture.orchestrator, enabled: true });

  const execution = runtime.execute({ id: "plan-1", actions: [] });
  await Promise.resolve();
  const closing = runtime.close();
  assert.equal(runtime.getStatus().state, "closing");
  assert.equal(runtime.getStatus().accepting, false);
  await assert.rejects(
    runtime.execute({ id: "plan-2", actions: [] }),
    (error) => error.code === "RUNTIME_CLOSED"
  );

  release({ status: "succeeded" });
  await execution;
  const closed = await closing;
  assert.equal(closed.state, "closed");
  assert.equal(closed.active, false);
  assert.deepEqual(await runtime.close(), closed);
});

test("close is safe for a runtime that was never enabled", async () => {
  const fixture = createOrchestrator();
  const runtime = createAutonomousExecutionRuntime({ orchestrator: fixture.orchestrator });
  const closed = await runtime.close();
  assert.equal(closed.state, "closed");
  assert.equal(closed.enabled, false);
  assert.equal(closed.accepting, false);
});
