import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalProcessEngineRunner } from "../src/agent/execution-process-runner.js";
import { createQaEngineOrchestrator, getQaEngineActionType, QA_ENGINE_EXECUTION_PERMISSION } from "../src/engine-registry/orchestrator.js";
import { createQaEngineRegistry } from "../src/engine-registry/index.js";
import { createExecutionJobQueue } from "../src/agent/execution-job-queue.js";
import { createExecutionWorker } from "../src/agent/execution-worker.js";
import { createExecutionLifecycleSupervisor } from "../src/agent/execution-supervisor.js";

async function fixture(source, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "jbqa-process-runner-"));
  const modulePath = join(root, "runner.mjs");
  await writeFile(modulePath, source, "utf8");
  const runner = createLocalProcessEngineRunner({
    engineId: "jb.test.process",
    moduleRoot: root,
    modulePath,
    cwd: root,
    timeoutMs: options.timeoutMs ?? 5000,
    killGraceMs: options.killGraceMs ?? 100,
    maxInputBytes: options.maxInputBytes ?? 32768,
    maxOutputBytes: options.maxOutputBytes ?? 32768,
    ...(options.resourceController === undefined ? {} : {
      resourceController: typeof options.resourceController === "function"
        ? options.resourceController(root)
        : options.resourceController
    }),
    ...(options.requireResourceContainment === undefined ? {} : {
      requireResourceContainment: options.requireResourceContainment
    })
  });
  return {
    root,
    runner,
    async cleanup() {
      await runner.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function makePolicy() {
  return {
    id: "process-runner-test-policy",
    grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
    rules: [{ type: getQaEngineActionType("jb.test.process"), maxRisk: "high", requireApproval: true }],
    limits: {
      maxActions: 1,
      maxExecutionMs: 5000,
      maxActionMs: 4000,
      approvalTimeoutMs: 1000,
      maxInputBytes: 32768,
      maxOutputBytes: 32768
    }
  };
}

function makePlan(value) {
  return {
    id: "process-plan",
    actions: [{
      id: "process-action",
      type: getQaEngineActionType("jb.test.process"),
      input: { value }
    }]
  };
}

test("local process runner invokes a trusted module and returns bounded JSON output", async () => {
  const item = await fixture(`
    export async function run(input, { signal }) {
      return { doubled: input.value * 2, wasAborted: signal.aborted };
    }
  `);
  try {
    assert.equal(item.runner.getStatus().state, "ready");
    assert.equal(item.runner.getStatus().startedProcesses, 0);
    const output = await item.runner.run({ value: 21 });
    assert.deepEqual(output, { doubled: 42, wasAborted: false });
    const status = item.runner.getStatus();
    assert.equal(status.startedProcesses, 1);
    assert.equal(status.completedProcesses, 1);
    assert.equal(status.active, false);
  } finally {
    await item.cleanup();
  }
});

test("local process runner isolates module failures and does not expose raw error messages", async () => {
  const item = await fixture(`
    export async function run() {
      const error = new Error("private adapter detail should not cross IPC");
      error.code = "ADAPTER_FAILED";
      throw error;
    }
  `);
  try {
    await assert.rejects(
      item.runner.run({ value: "x" }),
      (error) => error.code === "ADAPTER_FAILED" &&
        !error.message.includes("private adapter detail")
    );
    assert.equal(item.runner.getStatus().failedProcesses, 1);
    assert.equal(item.runner.getStatus().active, false);
  } finally {
    await item.cleanup();
  }
});

test("local process runner applies its configured output byte limit in the child", async () => {
  const item = await fixture(`
    export async function run() {
      return { large: "x".repeat(2048) };
    }
  `, { maxOutputBytes: 128 });
  try {
    await assert.rejects(
      item.runner.run({ value: "bounded-output" }),
      (error) => error.code === "PAYLOAD_LIMIT"
    );
    assert.equal(item.runner.getStatus().failedProcesses, 1);
    assert.equal(item.runner.getStatus().active, false);
  } finally {
    await item.cleanup();
  }
});

test("local process runner force-terminates a non-cooperative adapter at its deadline", async () => {
  const item = await fixture(`
    export async function run() {
      setInterval(() => {}, 1000);
      return await new Promise(() => {});
    }
  `, { timeoutMs: 120, killGraceMs: 60 });
  try {
    await assert.rejects(
      item.runner.run({ value: "hang" }),
      (error) => error.code === "EXECUTION_TIMEOUT"
    );
    const status = item.runner.getStatus();
    assert.equal(status.active, false);
    assert.equal(status.timedOutProcesses, 1);
    assert.equal(status.forcedTerminations, 1);
  } finally {
    await item.cleanup();
  }
});

test("external AbortSignal cancels the child and a runner rejects overlapping invocations", async () => {
  const item = await fixture(`
    export async function run(_input, { signal }) {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "ABORTED" })), { once: true });
      });
      return { unreachable: true };
    }
  `, { timeoutMs: 5000, killGraceMs: 500 });
  try {
    const controller = new AbortController();
    const active = item.runner.run({ value: "wait" }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await assert.rejects(item.runner.run({ value: "overlap" }), (error) => error.code === "RUNNER_BUSY");
    controller.abort();
    await assert.rejects(active, (error) => error.code === "EXECUTION_CANCELLED");
    assert.equal(item.runner.getStatus().cancelledProcesses, 1);
    assert.equal(item.runner.getStatus().active, false);
  } finally {
    await item.cleanup();
  }
});

test("runner close force-terminates active work and permanently stops admission", async () => {
  const item = await fixture(`
    export async function run() {
      setInterval(() => {}, 1000);
      return await new Promise(() => {});
    }
  `, { timeoutMs: 5000, killGraceMs: 60 });
  try {
    const active = item.runner.run({ value: "close" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await item.runner.close();
    await assert.rejects(active, (error) => error.code === "RUNNER_CLOSED");
    assert.equal(item.runner.getStatus().state, "closed");
    assert.equal(item.runner.getStatus().active, false);
    assert.equal(item.runner.getStatus().forcedTerminations, 1);
    await assert.rejects(item.runner.run({ value: "late" }), (error) => error.code === "RUNNER_CLOSED");
  } finally {
    await item.cleanup();
  }
});

test("resource containment is required when explicitly configured", () => {
  assert.throws(
    () => createLocalProcessEngineRunner({
      engineId: "jb.test.process",
      moduleRoot: "/tmp",
      modulePath: "/tmp/runner.mjs",
      requireResourceContainment: true
    }),
    (error) => error.code === "RESOURCE_CONTAINMENT_REQUIRED"
  );
});

test("process runner attaches the child to its OS resource scope before adapter initialization", async () => {
  const state = { attachCalls: 0, closeCalls: 0, terminateCalls: 0, attachedPid: null };
  const item = await fixture(`
    import { readFileSync } from "node:fs";
    export async function run() {
      return { attachedBeforeAdapter: readFileSync("scope-attached.marker", "utf8") === "attached" };
    }
  `, {
    requireResourceContainment: true,
    resourceController: (root) => Object.freeze({
      getStatus: () => Object.freeze({ mode: "test-cgroup-provider", available: true, enforced: true }),
      createScope: ({ engineId, requestId }) => {
        assert.equal(engineId, "jb.test.process");
        assert.match(requestId, /^[0-9a-f-]{36}$/iu);
        return Object.freeze({
          attachProcess(pid) {
            state.attachCalls += 1;
            state.attachedPid = pid;
            writeFileSync(join(root, "scope-attached.marker"), "attached");
          },
          terminateAll() { state.terminateCalls += 1; },
          getUsage() { return Object.freeze({ state: "active", processCount: 1 }); },
          async close() { state.closeCalls += 1; }
        });
      }
    })
  });
  try {
    assert.equal(item.runner.getStatus().resourceContainment.required, true);
    assert.equal(item.runner.getStatus().resourceContainment.configured, true);
    assert.equal(item.runner.getStatus().resourceContainment.controller.enforced, true);
    const result = await item.runner.run({ value: "bounded" });
    assert.deepEqual(result, { attachedBeforeAdapter: true });
    assert.equal(state.attachCalls, 1);
    assert.ok(Number.isSafeInteger(state.attachedPid) && state.attachedPid > 0);
    assert.equal(state.closeCalls, 1);
  } finally {
    await item.cleanup();
  }
});

test("process runner kills the entire resource scope after cooperative grace expires", async () => {
  const state = { attachCalls: 0, closeCalls: 0, terminateCalls: 0 };
  const item = await fixture(`
    export async function run() {
      setInterval(() => {}, 1000);
      return await new Promise(() => {});
    }
  `, {
    timeoutMs: 120,
    killGraceMs: 60,
    requireResourceContainment: true,
    resourceController: () => Object.freeze({
      getStatus: () => Object.freeze({ mode: "test-cgroup-provider", available: true, enforced: true }),
      createScope: () => Object.freeze({
        attachProcess() { state.attachCalls += 1; },
        terminateAll() { state.terminateCalls += 1; },
        getUsage() { return Object.freeze({ state: "active", processCount: 1 }); },
        async close() { state.closeCalls += 1; }
      })
    })
  });
  try {
    await assert.rejects(item.runner.run({ value: "hang" }), (error) => error.code === "EXECUTION_TIMEOUT");
    assert.equal(state.attachCalls, 1);
    assert.equal(state.terminateCalls, 1);
    assert.equal(state.closeCalls, 1);
    assert.equal(item.runner.getStatus().resourceContainment.activeUsage, null);
  } finally {
    await item.cleanup();
  }
});

test("runner validates host module boundaries and rejects unsafe configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-process-root-"));
  const outside = await mkdtemp(join(tmpdir(), "jbqa-process-outside-"));
  const modulePath = join(outside, "runner.mjs");
  try {
    await writeFile(modulePath, "export function run() { return {}; }", "utf8");
    assert.throws(
      () => createLocalProcessEngineRunner({
        engineId: "jb.test.process",
        moduleRoot: root,
        modulePath
      }),
      (error) => error.code === "MODULE_OUTSIDE_ROOT"
    );
    assert.throws(
      () => createLocalProcessEngineRunner({
        engineId: "../unsafe",
        moduleRoot: root,
        modulePath
      }),
      (error) => error.code === "INVALID_ENGINE_ID"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("parent orchestrator policy and human approval gate process startup", async () => {
  const item = await fixture(`
    export async function run(input) {
      return { accepted: input.value };
    }
  `);
  try {
    const registry = createQaEngineRegistry();
    registry.register({
      id: "jb.test.process",
      name: "Process Test",
      version: "1.0.0",
      category: "audit",
      targetType: "payload",
      executionMode: "local-process",
      capabilities: ["process-isolated"],
      run: item.runner.run
    });
    registry.seal();

    const denied = createQaEngineOrchestrator({
      registry,
      policy: makePolicy()
    });
    const blocked = await denied.execute(makePlan("denied"));
    assert.equal(blocked.status, "blocked");
    assert.equal(item.runner.getStatus().startedProcesses, 0);

    const approved = createQaEngineOrchestrator({
      registry,
      policy: makePolicy(),
      requestApproval: async () => ({ approved: true, approvalId: "approval-process-1" })
    });
    const result = await approved.execute(makePlan("allowed"));
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.actions[0].output, { accepted: "allowed" });
    assert.equal(item.runner.getStatus().startedProcesses, 1);
  } finally {
    await item.cleanup();
  }
});


test("supervisor aborts a non-cooperative child and closes it before queue persistence", async () => {
  const item = await fixture(`
    export async function run() {
      setInterval(() => {}, 1000);
      return await new Promise(() => {});
    }
  `, { timeoutMs: 10000, killGraceMs: 80 });

  try {
    const queue = createExecutionJobQueue();
    const runtime = Object.freeze({
      getStatus: () => Object.freeze({ enabled: true, state: "ready" }),
      execute: async (input, options) => item.runner.run(input, { signal: options.signal }),
      close: async () => undefined
    });
    const worker = createExecutionWorker({ queue, runtime });
    const supervisor = createExecutionLifecycleSupervisor({
      queue,
      runtime,
      worker,
      processRunners: [item.runner]
    });

    supervisor.enqueue({ value: "hang" }, { id: "isolated-shutdown-job" });
    supervisor.start();
    const active = supervisor.runNext();

    const deadline = Date.now() + 5000;
    while (!item.runner.getStatus().active && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(item.runner.getStatus().active, true);

    await supervisor.close({ abortActive: true });
    const cancelled = await active;
    assert.equal(cancelled.state, "cancelled");
    assert.equal(item.runner.getStatus().state, "closed");
    assert.equal(item.runner.getStatus().active, false);
    assert.equal(supervisor.getStatus().processRunners[0].state, "closed");
    assert.equal(queue.stats().running, 0);
  } finally {
    await item.cleanup();
  }
});
