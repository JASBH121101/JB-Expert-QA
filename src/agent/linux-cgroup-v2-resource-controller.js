import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const REQUIRED_CONTROLLERS = Object.freeze(["cpu", "memory", "pids"]);
const CGROUP_MOUNT = "/sys/fs/cgroup";
const SCOPE_PREFIX = "jbqa-";

export class LinuxCgroupV2ResourceControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LinuxCgroupV2ResourceControllerError";
    this.code = code;
  }
}

function readRecord(value, label, allowedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LinuxCgroupV2ResourceControllerError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new LinuxCgroupV2ResourceControllerError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new LinuxCgroupV2ResourceControllerError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new LinuxCgroupV2ResourceControllerError("ACCESSOR_NOT_ALLOWED", label + " cannot contain accessors");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function readText(filePath, code) {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    throw new LinuxCgroupV2ResourceControllerError(code, "required cgroup v2 control file is unavailable");
  }
}

function writeText(filePath, value, code) {
  try {
    writeFileSync(filePath, String(value), { encoding: "utf8" });
  } catch {
    throw new LinuxCgroupV2ResourceControllerError(code, "cgroup v2 control update was rejected");
  }
}

function parseKeyValues(value) {
  const output = Object.create(null);
  for (const line of value.split(/\r?\n/u)) {
    const match = /^([a-zA-Z0-9_.]+)\s+(\d+)$/u.exec(line.trim());
    if (match) output[match[1]] = Number(match[2]);
  }
  return Object.freeze(output);
}

function populated(filePath) {
  const events = parseKeyValues(readText(filePath, "CGROUP_EVENTS_UNAVAILABLE"));
  if (events.populated !== 0 && events.populated !== 1) {
    throw new LinuxCgroupV2ResourceControllerError("CGROUP_EVENTS_INVALID", "cgroup.events did not expose a valid populated state");
  }
  return events.populated === 1;
}

function normalizeLimits(value = {}) {
  const config = readRecord(value, "limits", new Set([
    "maxMemoryBytes", "cpuQuotaMicros", "cpuPeriodMicros", "maxProcesses",
    "maxSwapBytes", "cleanupTimeoutMs", "cleanupPollIntervalMs"
  ]));
  const limits = {
    maxMemoryBytes: config.maxMemoryBytes ?? 536870912,
    cpuQuotaMicros: config.cpuQuotaMicros ?? 50000,
    cpuPeriodMicros: config.cpuPeriodMicros ?? 100000,
    maxProcesses: config.maxProcesses ?? 32,
    maxSwapBytes: config.maxSwapBytes ?? 0,
    cleanupTimeoutMs: config.cleanupTimeoutMs ?? 3000,
    cleanupPollIntervalMs: config.cleanupPollIntervalMs ?? 25
  };

  if (!Number.isSafeInteger(limits.maxMemoryBytes) ||
      limits.maxMemoryBytes < 16 * 1024 * 1024 ||
      limits.maxMemoryBytes > 1099511627776) {
    throw new LinuxCgroupV2ResourceControllerError("INVALID_MEMORY_LIMIT", "maxMemoryBytes must be between 16 MiB and 1 TiB");
  }
  if (!Number.isSafeInteger(limits.cpuPeriodMicros) ||
      limits.cpuPeriodMicros < 1000 || limits.cpuPeriodMicros > 1000000 ||
      !Number.isSafeInteger(limits.cpuQuotaMicros) ||
      limits.cpuQuotaMicros < 1000 || limits.cpuQuotaMicros > 10000000 ||
      limits.cpuQuotaMicros > limits.cpuPeriodMicros * 100) {
    throw new LinuxCgroupV2ResourceControllerError("INVALID_CPU_LIMIT", "CPU quota and period are outside supported bounds");
  }
  if (!Number.isSafeInteger(limits.maxProcesses) ||
      limits.maxProcesses < 1 || limits.maxProcesses > 65535) {
    throw new LinuxCgroupV2ResourceControllerError("INVALID_PROCESS_LIMIT", "maxProcesses must be between 1 and 65535");
  }
  if (!Number.isSafeInteger(limits.maxSwapBytes) ||
      limits.maxSwapBytes < 0 || limits.maxSwapBytes > limits.maxMemoryBytes) {
    throw new LinuxCgroupV2ResourceControllerError("INVALID_SWAP_LIMIT", "maxSwapBytes must be between zero and maxMemoryBytes");
  }
  if (!Number.isSafeInteger(limits.cleanupTimeoutMs) ||
      limits.cleanupTimeoutMs < 100 || limits.cleanupTimeoutMs > 30000 ||
      !Number.isSafeInteger(limits.cleanupPollIntervalMs) ||
      limits.cleanupPollIntervalMs < 5 || limits.cleanupPollIntervalMs > 250) {
    throw new LinuxCgroupV2ResourceControllerError("INVALID_CLEANUP_LIMIT", "cleanup timeout or poll interval is outside supported bounds");
  }
  return Object.freeze(limits);
}

function validateRoot(cgroupRoot) {
  if (process.platform !== "linux") {
    throw new LinuxCgroupV2ResourceControllerError(
      "UNSUPPORTED_PLATFORM",
      "Linux cgroup v2 resource containment is available only on Linux"
    );
  }
  if (typeof cgroupRoot !== "string" || !path.isAbsolute(cgroupRoot)) {
    throw new LinuxCgroupV2ResourceControllerError("INVALID_CGROUP_ROOT", "cgroupRoot must be an absolute host-configured path");
  }

  try {
    const info = lstatSync(cgroupRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new LinuxCgroupV2ResourceControllerError("UNSAFE_CGROUP_ROOT", "cgroupRoot must be a regular delegated directory");
    }
    const root = realpathSync(cgroupRoot);
    if (!within(CGROUP_MOUNT, root)) {
      throw new LinuxCgroupV2ResourceControllerError(
        "CGROUP_ROOT_NOT_DELEGATED",
        "cgroupRoot must be a delegated child directory under /sys/fs/cgroup"
      );
    }

    const rootControllers = readText(path.join(root, "cgroup.controllers"), "CGROUP_CONTROLLERS_UNAVAILABLE")
      .split(/\s+/u).filter(Boolean);
    const childControllers = readText(path.join(root, "cgroup.subtree_control"), "CGROUP_SUBTREE_CONTROL_UNAVAILABLE")
      .split(/\s+/u).filter(Boolean);
    const missingAvailable = REQUIRED_CONTROLLERS.filter((name) => !rootControllers.includes(name));
    const missingEnabled = REQUIRED_CONTROLLERS.filter((name) => !childControllers.includes(name));
    if (missingAvailable.length || missingEnabled.length) {
      throw new LinuxCgroupV2ResourceControllerError(
        "CGROUP_CONTROLLERS_NOT_DELEGATED",
        "cpu, memory and pids controllers must already be available and enabled for this delegated subtree"
      );
    }

    return Object.freeze({ root, controllers: Object.freeze(REQUIRED_CONTROLLERS.slice()) });
  } catch (error) {
    if (error instanceof LinuxCgroupV2ResourceControllerError) throw error;
    throw new LinuxCgroupV2ResourceControllerError("CGROUP_ROOT_UNAVAILABLE", "delegated cgroup v2 root could not be inspected");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates per-execution Linux cgroup v2 scopes under a host-prepared delegated
 * subtree. It never mounts cgroupfs, enables controllers, changes parent
 * limits, invokes sudo, or modifies global host configuration.
 *
 * The delegated root must already have cpu, memory and pids enabled in
 * cgroup.subtree_control. Each scope receives hard memory, CPU-rate, process
 * count and swap limits. cgroup.kill is required to terminate the scope tree.
 */
export function createLinuxCgroupV2ResourceController(options = {}) {
  const config = readRecord(options, "options", new Set(["cgroupRoot", "limits"]));
  const rootInfo = validateRoot(config.cgroupRoot);
  const limits = normalizeLimits(config.limits);
  let closed = false;
  const scopes = new Map();

  function getStatus() {
    return Object.freeze({
      platform: "linux",
      mode: "linux-cgroup-v2",
      available: true,
      accepting: !closed,
      delegatedRoot: rootInfo.root,
      controllers: rootInfo.controllers,
      activeScopes: scopes.size,
      limits
    });
  }

  function createScope(input) {
    if (closed) {
      throw new LinuxCgroupV2ResourceControllerError("CONTROLLER_CLOSED", "resource controller is closed");
    }
    const request = readRecord(input, "scope request", new Set(["engineId", "requestId"]));
    if (typeof request.engineId !== "string" || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(request.engineId) ||
        typeof request.requestId !== "string" || !/^[0-9a-f-]{36}$/iu.test(request.requestId)) {
      throw new LinuxCgroupV2ResourceControllerError("INVALID_SCOPE_REQUEST", "scope identity is invalid");
    }

    const scopeName = SCOPE_PREFIX + randomUUID();
    const scopePath = path.join(rootInfo.root, scopeName);
    try {
      mkdirSync(scopePath, { mode: 0o700 });
    } catch {
      throw new LinuxCgroupV2ResourceControllerError("CGROUP_SCOPE_CREATE_FAILED", "a per-execution cgroup could not be created");
    }

    const controls = {
      memoryMax: path.join(scopePath, "memory.max"),
      memorySwapMax: path.join(scopePath, "memory.swap.max"),
      cpuMax: path.join(scopePath, "cpu.max"),
      pidsMax: path.join(scopePath, "pids.max"),
      cgroupProcs: path.join(scopePath, "cgroup.procs"),
      cgroupKill: path.join(scopePath, "cgroup.kill"),
      cgroupEvents: path.join(scopePath, "cgroup.events"),
      memoryCurrent: path.join(scopePath, "memory.current"),
      memoryPeak: path.join(scopePath, "memory.peak"),
      memoryEvents: path.join(scopePath, "memory.events"),
      cpuStat: path.join(scopePath, "cpu.stat"),
      pidsCurrent: path.join(scopePath, "pids.current")
    };

    let attachedPid = null;
    let scopeClosed = false;
    let terminated = false;

    try {
      for (const filePath of Object.values(controls)) {
        lstatSync(filePath);
      }
      writeText(controls.memoryMax, limits.maxMemoryBytes, "CGROUP_MEMORY_LIMIT_FAILED");
      writeText(controls.memorySwapMax, limits.maxSwapBytes, "CGROUP_SWAP_LIMIT_FAILED");
      writeText(controls.cpuMax, limits.cpuQuotaMicros + " " + limits.cpuPeriodMicros, "CGROUP_CPU_LIMIT_FAILED");
      writeText(controls.pidsMax, limits.maxProcesses, "CGROUP_PID_LIMIT_FAILED");
      const oomGroup = path.join(scopePath, "memory.oom.group");
      try { writeText(oomGroup, 1, "CGROUP_OOM_POLICY_FAILED"); } catch {}
    } catch (error) {
      try {
        if (!populated(controls.cgroupEvents)) rmdirSync(scopePath);
      } catch {}
      if (error instanceof LinuxCgroupV2ResourceControllerError) throw error;
      throw new LinuxCgroupV2ResourceControllerError(
        "CGROUP_SCOPE_CONFIGURE_FAILED",
        "per-execution cgroup controls could not be configured safely"
      );
    }

    const scope = {
      name: scopeName,
      attachProcess(pid) {
        if (scopeClosed || attachedPid !== null ||
            !Number.isSafeInteger(pid) || pid < 1) {
          throw new LinuxCgroupV2ResourceControllerError("CGROUP_ATTACH_INVALID", "process attachment is invalid or already completed");
        }
        writeText(controls.cgroupProcs, pid, "CGROUP_ATTACH_FAILED");
        const members = readText(controls.cgroupProcs, "CGROUP_ATTACH_VERIFY_FAILED")
          .split(/\s+/u).filter(Boolean);
        if (!members.includes(String(pid))) {
          throw new LinuxCgroupV2ResourceControllerError("CGROUP_ATTACH_VERIFY_FAILED", "process did not enter its cgroup before initialization");
        }
        attachedPid = pid;
        return Object.freeze({ attached: true, pid });
      },
      terminateAll() {
        if (scopeClosed || terminated) return false;
        writeText(controls.cgroupKill, 1, "CGROUP_TREE_TERMINATION_FAILED");
        terminated = true;
        return true;
      },
      getUsage() {
        if (scopeClosed) {
          return Object.freeze({ state: "closed", memoryCurrentBytes: 0, processCount: 0 });
        }
        const cpu = parseKeyValues(readText(controls.cpuStat, "CGROUP_USAGE_UNAVAILABLE"));
        const memoryEvents = parseKeyValues(readText(controls.memoryEvents, "CGROUP_USAGE_UNAVAILABLE"));
        return Object.freeze({
          state: "active",
          attachedPid,
          memoryCurrentBytes: Number(readText(controls.memoryCurrent, "CGROUP_USAGE_UNAVAILABLE")),
          memoryPeakBytes: Number(readText(controls.memoryPeak, "CGROUP_USAGE_UNAVAILABLE")),
          cpuUsageMicros: cpu.usage_usec ?? 0,
          processCount: Number(readText(controls.pidsCurrent, "CGROUP_USAGE_UNAVAILABLE")),
          memoryEvents
        });
      },
      async close() {
        if (scopeClosed) return Object.freeze({ closed: true, terminated });
        try {
          if (populated(controls.cgroupEvents)) scope.terminateAll();
          const deadline = Date.now() + limits.cleanupTimeoutMs;
          while (populated(controls.cgroupEvents)) {
            if (Date.now() >= deadline) {
              throw new LinuxCgroupV2ResourceControllerError(
                "CGROUP_CLEANUP_TIMEOUT",
                "cgroup processes did not exit within the bounded cleanup window"
              );
            }
            await sleep(limits.cleanupPollIntervalMs);
          }
          rmdirSync(scopePath);
          scopeClosed = true;
          scopes.delete(scopeName);
          return Object.freeze({ closed: true, terminated });
        } catch (error) {
          if (error instanceof LinuxCgroupV2ResourceControllerError) throw error;
          throw new LinuxCgroupV2ResourceControllerError("CGROUP_CLEANUP_FAILED", "per-execution cgroup could not be removed");
        }
      }
    };

    scopes.set(scopeName, scope);
    return Object.freeze(scope);
  }

  async function close() {
    if (closed) return getStatus();
    const failures = [];
    for (const scope of [...scopes.values()]) {
      try {
        await scope.close();
      } catch (error) {
        failures.push(error?.code ?? "CGROUP_CLEANUP_FAILED");
      }
    }
    if (failures.length) {
      throw new LinuxCgroupV2ResourceControllerError(
        "CONTROLLER_CLOSE_FAILED",
        "one or more execution cgroups could not be cleaned up: " + failures.join(",")
      );
    }
    closed = true;
    return getStatus();
  }

  return Object.freeze({ createScope, getStatus, close });
}
