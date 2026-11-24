import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWindowsJobObjectResourceController,
  WindowsJobObjectResourceControllerError
} from "../src/agent/windows-job-object-resource-controller.js";
import { createLocalProcessEngineRunner } from "../src/agent/execution-process-runner.js";

test("Windows Job Object helper startup uses the bounded 30-second CI tolerance", {
  skip: process.platform !== "win32"
}, async () => {
  const controller = createWindowsJobObjectResourceController();
  try {
    assert.equal(controller.getStatus().limits.startupTimeoutMs, 30000);
  } finally {
    await controller.close();
  }
});

test("Windows Job Object controller rejects invalid policy values", () => {
  assert.throws(
    () => createWindowsJobObjectResourceController({ limits: { cpuRatePercent: 0 } }),
    (error) => error.code === "INVALID_CPU_LIMIT"
  );
  assert.throws(
    () => createWindowsJobObjectResourceController({ limits: { maxProcesses: 0 } }),
    (error) => error.code === "INVALID_PROCESS_LIMIT"
  );
  assert.throws(
    () => createWindowsJobObjectResourceController({ limits: { maxMemoryBytes: 1024 } }),
    (error) => error.code === "INVALID_MEMORY_LIMIT"
  );
});

test("Windows Job Object controller reports unsupported platforms explicitly", () => {
  if (process.platform === "win32") return;
  assert.throws(
    () => createWindowsJobObjectResourceController(),
    (error) => error instanceof WindowsJobObjectResourceControllerError && error.code === "UNSUPPORTED_PLATFORM"
  );
});

test("Windows Job Object controller enforces native limits and terminates descendant processes", {
  skip: process.platform !== "win32"
}, async () => {
  const controller = createWindowsJobObjectResourceController({
    limits: {
      maxMemoryBytes: 512 * 1024 * 1024,
      cpuRatePercent: 50,
      maxProcesses: 8,
      cleanupTimeoutMs: 8000
    }
  });
  const scope = controller.createScope({
    engineId: "jb.test.windows-job",
    requestId: "6f53446b-bb9c-43c1-86ab-653ff34f20a4"
  });
  const source = `
    const { spawn } = require("node:child_process");
    process.stdin.once("data", () => {
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  try {
    await once(child, "spawn");
    await scope.attachProcess(child.pid);
    assert.equal(scope.getUsage().attachedPid, child.pid);
    assert.ok(scope.getUsage().committedMemoryLimitBytes >= 512 * 1024 * 1024);
    child.stdin.write("start-descendant");
    const usageDeadline = Date.now() + 5000;
    let beforeTermination = scope.getUsage();
    while (beforeTermination.processCount < 2 && Date.now() < usageDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      beforeTermination = scope.getUsage();
    }
    assert.ok(beforeTermination.processCount >= 2, "Job Object accounting must include both worker and descendant");
    const childExit = once(child, "exit");
    await scope.terminateAll();
    await childExit;
    const afterTermination = scope.getUsage();
    assert.equal(afterTermination.processCount, 0, "Job Object must have no active processes after termination");
    assert.ok(afterTermination.totalProcesses >= 2, "Job Object must have counted the worker and descendant");
    await scope.close();
    assert.equal(controller.getStatus().activeScopes, 0);
  } finally {
    try { child.kill(); } catch {}
    try { await scope.close(); } catch {}
    try { await controller.close(); } catch {}
  }
});

test("Windows Job Object controller integrates with the process runner before adapter initialization", {
  skip: process.platform !== "win32"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-windows-job-runner-"));
  const modulePath = join(root, "runner.mjs");
  await writeFile(modulePath, "export function run(input) { return { value: input.value, pid: process.pid }; }", "utf8");
  const resourceController = createWindowsJobObjectResourceController({
    limits: { maxMemoryBytes: 512 * 1024 * 1024, cpuRatePercent: 50, maxProcesses: 8 }
  });
  const runner = createLocalProcessEngineRunner({
    engineId: "jb.test.windows-runner",
    moduleRoot: root,
    modulePath,
    cwd: root,
    resourceController,
    requireResourceContainment: true
  });
  try {
    const result = await runner.run({ value: "contained" });
    assert.equal(result.value, "contained");
    assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0);
    assert.equal(runner.getStatus().activeResourceScopes, 0);
    assert.equal(resourceController.getStatus().activeScopes, 0);
  } finally {
    await runner.close();
    await resourceController.close();
    await rm(root, { recursive: true, force: true });
  }
});
