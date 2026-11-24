import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createLocalProcessEngineRunner } from "../src/agent/execution-process-runner.js";
import {
  createLinuxCgroupV2ResourceController,
  LinuxCgroupV2ResourceControllerError
} from "../src/agent/linux-cgroup-v2-resource-controller.js";

test("Linux cgroup v2 controller validates host-owned configuration without mutating the host", () => {
  assert.throws(
    () => createLinuxCgroupV2ResourceController({ cgroupRoot: "relative/path" }),
    (error) => error instanceof LinuxCgroupV2ResourceControllerError &&
      error.code === "INVALID_CGROUP_ROOT"
  );
  assert.throws(
    () => createLinuxCgroupV2ResourceController({
      cgroupRoot: "relative/path",
      limits: { cpuQuotaMicros: 0 }
    }),
    (error) => error.code === "INVALID_CPU_LIMIT"
  );
  if (process.platform === "linux") {
    assert.throws(
      () => createLinuxCgroupV2ResourceController({ cgroupRoot: "/sys/fs/cgroup" }),
      (error) => error.code === "CGROUP_ROOT_NOT_DELEGATED" ||
        error.code === "CGROUP_ROOT_UNAVAILABLE"
    );
  } else {
    assert.throws(
      () => createLinuxCgroupV2ResourceController({ cgroupRoot: "/sys/fs/cgroup/delegated" }),
      (error) => error.code === "UNSUPPORTED_PLATFORM"
    );
  }
});

test("Linux cgroup v2 limits reject unsafe memory, CPU, swap and PID budgets", () => {
  for (const limits of [
    { maxMemoryBytes: 1024 },
    { cpuQuotaMicros: 0 },
    { cpuPeriodMicros: 1000001 },
    { maxProcesses: 0 },
    { maxSwapBytes: -1 },
    { cleanupTimeoutMs: 50 }
  ]) {
    assert.throws(
      () => createLinuxCgroupV2ResourceController({ cgroupRoot: "relative/path", limits }),
      (error) => error instanceof LinuxCgroupV2ResourceControllerError &&
        error.code.startsWith("INVALID_")
    );
  }
});

const cgroupTestRoot = process.env.JBQA_CGROUP_V2_TEST_ROOT;
test("real Linux cgroup v2 scope applies limits and kills adapter descendants", {
  skip: process.platform !== "linux" || typeof cgroupTestRoot !== "string" || !cgroupTestRoot
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jbqa-cgroup-v2-integration-"));
  const modulePath = join(directory, "runner.mjs");
  const source = [
    'import { spawn } from "node:child_process";',
    'export async function run() {',
    '  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
    '    stdio: "ignore", detached: false',
    '  });',
    '  return { descendantPid: child.pid };',
    '}'
  ].join("\n");
  await writeFile(modulePath, source, "utf8");

  const controller = createLinuxCgroupV2ResourceController({
    cgroupRoot: cgroupTestRoot,
    limits: {
      maxMemoryBytes: 268435456,
      cpuQuotaMicros: 50000,
      cpuPeriodMicros: 100000,
      maxProcesses: 8,
      maxSwapBytes: 0,
      cleanupTimeoutMs: 5000
    }
  });
  const runner = createLocalProcessEngineRunner({
    engineId: "jb.test.cgroup",
    moduleRoot: directory,
    modulePath,
    cwd: directory,
    timeoutMs: 5000,
    resourceController: controller,
    requireResourceContainment: true
  });

  try {
    const result = await runner.run({ test: "descendant-cleanup" });
    assert.ok(Number.isSafeInteger(result.descendantPid));
    assert.equal(controller.getStatus().activeScopes, 0);
    assert.equal(runner.getStatus().resourceContainment.configured, true);
    assert.equal(runner.getStatus().resourceContainment.activeUsage, null);
  } finally {
    await runner.close();
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});
