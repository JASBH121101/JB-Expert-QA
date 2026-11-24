import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Read-only host capability discovery. This reports platform prerequisites,
 * not successful resource enforcement; controllers must verify enforcement.
 */
export function detectContainmentCapabilities(options = {}) {
  const platform = options.platform ?? os.platform();
  const exists = options.exists ?? existsSync;
  const readText = options.readText ?? ((file) => readFileSync(file, "utf8"));
  const cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
  const powershellCandidates = options.powershellCandidates ?? [
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
  ];

  let cgroupV2 = false;
  let controllers = [];
  let cgroupWritable = false;
  if (platform === "linux") {
    try {
      cgroupV2 = exists(path.join(cgroupRoot, "cgroup.controllers"));
      if (cgroupV2) {
        controllers = readText(path.join(cgroupRoot, "cgroup.controllers"))
          .trim().split(/\s+/u).filter(Boolean).sort();
        cgroupWritable = exists(path.join(cgroupRoot, "cgroup.subtree_control"));
      }
    } catch {
      cgroupV2 = false;
      controllers = [];
      cgroupWritable = false;
    }
  }

  const powershellAvailable = platform === "win32" &&
    powershellCandidates.some((candidate) => exists(candidate));

  const capabilities = {
    schemaVersion: 1,
    platform,
    linuxCgroupV2: Object.freeze({
      detected: cgroupV2,
      controllers: Object.freeze(controllers),
      requiredControllersAvailable: ["cpu", "memory", "pids"].every((name) => controllers.includes(name)),
      writableControlFileDetected: cgroupWritable
    }),
    windowsJobObjects: Object.freeze({
      platformSupported: platform === "win32",
      powershellAvailable
    }),
    detectedAt: null
  };
  return Object.freeze(capabilities);
}
