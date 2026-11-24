import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { detectContainmentCapabilities } from "../src/agent/containment-capability-detection.js";

test("reports Linux cgroup v2 controller prerequisites from injected probes", () => {
  const files = new Set([
    join("/fake/cgroup", "cgroup.controllers"),
    join("/fake/cgroup", "cgroup.subtree_control")
  ]);
  const report = detectContainmentCapabilities({
    platform: "linux",
    cgroupRoot: "/fake/cgroup",
    exists: (file) => files.has(file),
    readText: () => "memory pids cpu"
  });
  assert.equal(report.linuxCgroupV2.detected, true);
  assert.deepEqual(report.linuxCgroupV2.controllers, ["cpu", "memory", "pids"]);
  assert.equal(report.linuxCgroupV2.requiredControllersAvailable, true);
  assert.equal(report.linuxCgroupV2.writableControlFileDetected, true);
  assert.equal(report.windowsJobObjects.platformSupported, false);
});

test("reports incomplete Linux controller prerequisites without claiming readiness", () => {
  const report = detectContainmentCapabilities({
    platform: "linux",
    cgroupRoot: "/fake",
    exists: (file) => file.endsWith("cgroup.controllers"),
    readText: () => "cpu pids"
  });
  assert.equal(report.linuxCgroupV2.detected, true);
  assert.equal(report.linuxCgroupV2.requiredControllersAvailable, false);
  assert.equal(report.linuxCgroupV2.writableControlFileDetected, false);
});

test("reports Windows platform and PowerShell presence separately", () => {
  const report = detectContainmentCapabilities({
    platform: "win32",
    powershellCandidates: ["/fake/powershell.exe"],
    exists: (file) => file === "/fake/powershell.exe"
  });
  assert.equal(report.windowsJobObjects.platformSupported, true);
  assert.equal(report.windowsJobObjects.powershellAvailable, true);
  assert.equal(report.linuxCgroupV2.detected, false);
});

test("degrades safely when Linux capability probing throws", () => {
  const report = detectContainmentCapabilities({
    platform: "linux",
    cgroupRoot: "/fake",
    exists: () => true,
    readText: () => { throw new Error("permission denied"); }
  });
  assert.equal(report.linuxCgroupV2.detected, false);
  assert.deepEqual(report.linuxCgroupV2.controllers, []);
  assert.equal(report.linuxCgroupV2.requiredControllersAvailable, false);
});
