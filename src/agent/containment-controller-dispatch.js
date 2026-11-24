import {
  createContainmentPolicy,
  ContainmentPolicyError
} from "./containment-policy.js";
import { detectContainmentCapabilities } from "./containment-capability-detection.js";
import { createLinuxCgroupV2ResourceController } from "./linux-cgroup-v2-resource-controller.js";
import { createWindowsJobObjectResourceController } from "./windows-job-object-resource-controller.js";

const PROBE_KEYS = new Set(["platform", "exists", "readText", "cgroupRoot", "powershellCandidates"]);
const ENGINE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const REQUEST_ID_PATTERN = /^[0-9a-f-]{36}$/iu;

export class ContainmentControllerDispatchError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ContainmentControllerDispatchError";
    this.code = code;
  }
}

function readRecord(value, label, allowedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContainmentControllerDispatchError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContainmentControllerDispatchError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new ContainmentControllerDispatchError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ContainmentControllerDispatchError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function normalizeProbeOptions(value) {
  const options = readRecord(value, "capabilityProbeOptions", PROBE_KEYS);
  if (options.platform !== undefined &&
      (typeof options.platform !== "string" || options.platform.length > 32)) {
    throw new ContainmentControllerDispatchError("INVALID_PROBE_PLATFORM", "capability probe platform is invalid");
  }
  for (const name of ["exists", "readText"]) {
    if (options[name] !== undefined && typeof options[name] !== "function") {
      throw new ContainmentControllerDispatchError("INVALID_CAPABILITY_PROBE", name + " must be a function");
    }
  }
  if (options.cgroupRoot !== undefined && typeof options.cgroupRoot !== "string") {
    throw new ContainmentControllerDispatchError("INVALID_CAPABILITY_PROBE", "capability probe cgroupRoot must be a string");
  }
  if (options.powershellCandidates !== undefined &&
      (!Array.isArray(options.powershellCandidates) ||
       options.powershellCandidates.some((item) => typeof item !== "string"))) {
    throw new ContainmentControllerDispatchError("INVALID_CAPABILITY_PROBE", "powershellCandidates must be an array of paths");
  }
  return options;
}

function createUncontainedScope(activeScopes, request) {
  const input = readRecord(request, "scope request", new Set(["engineId", "requestId"]));
  if (typeof input.engineId !== "string" || !ENGINE_ID_PATTERN.test(input.engineId) ||
      typeof input.requestId !== "string" || !REQUEST_ID_PATTERN.test(input.requestId)) {
    throw new ContainmentControllerDispatchError("INVALID_SCOPE_REQUEST", "scope identity is invalid");
  }

  let closed = false;
  const scope = Object.freeze({
    async attachProcess(pid) {
      if (closed || !Number.isSafeInteger(pid) || pid < 1) {
        throw new ContainmentControllerDispatchError("INVALID_SCOPE_ATTACHMENT", "process attachment is invalid");
      }
      return Object.freeze({ attached: false, contained: false, pid });
    },
    async terminateAll() {
      return Object.freeze({ terminated: false, contained: false });
    },
    getUsage() {
      return Object.freeze({ state: "unenforced", contained: false });
    },
    async close() {
      if (!closed) {
        closed = true;
        activeScopes.delete(scope);
      }
      return Object.freeze({ closed: true, contained: false });
    }
  });
  activeScopes.add(scope);
  return scope;
}

/**
 * Selects and initializes the native OS resource controller from a normalized
 * cross-platform policy and read-only host capability discovery.
 *
 * Linux requires a host-prepared delegated cgroup v2 child path in cgroupRoot.
 * Windows uses the native Job Object adapter. No host configuration is
 * modified. Uncontained execution is possible only when the policy explicitly
 * sets allowUncontainedFallback: true and required: false.
 *
 * capabilityProbeOptions is intended for controlled host integration and
 * deterministic tests. Native adapters still validate their own OS boundary.
 */
export function createContainmentControllerDispatcher(options = {}) {
  let config;
  try {
    config = readRecord(options, "options", new Set([
      "policy",
      "cgroupRoot",
      "capabilityProbeOptions"
    ]));
  } catch (error) {
    if (error instanceof ContainmentControllerDispatchError) throw error;
    throw new ContainmentControllerDispatchError("INVALID_OPTIONS", "dispatcher options are invalid", error);
  }

  let policy;
  try {
    policy = createContainmentPolicy(config.policy ?? {});
  } catch (error) {
    if (error instanceof ContainmentPolicyError) {
      throw new ContainmentControllerDispatchError(error.code, error.message, error);
    }
    throw new ContainmentControllerDispatchError("INVALID_POLICY", "containment policy could not be normalized", error);
  }

  const probeOptions = normalizeProbeOptions(config.capabilityProbeOptions ?? {});
  let capabilities;
  let capabilityProbeError = null;
  try {
    capabilities = detectContainmentCapabilities(probeOptions);
  } catch (error) {
    capabilityProbeError = error;
    capabilities = Object.freeze({
      schemaVersion: 1,
      platform: probeOptions.platform ?? process.platform,
      linuxCgroupV2: Object.freeze({
        detected: false,
        controllers: Object.freeze([]),
        requiredControllersAvailable: false,
        writableControlFileDetected: false
      }),
      windowsJobObjects: Object.freeze({
        platformSupported: false,
        powershellAvailable: false
      })
    });
  }

  let nativeController = null;
  let fallbackReason = null;
  try {
    if (capabilityProbeError) {
      throw new ContainmentControllerDispatchError(
        "CAPABILITY_PROBE_FAILED",
        "host containment capabilities could not be inspected",
        capabilityProbeError
      );
    }
    if (capabilities.platform === "linux") {
      const linux = capabilities.linuxCgroupV2;
      if (!linux?.detected || !linux.requiredControllersAvailable || !linux.writableControlFileDetected) {
        throw new ContainmentControllerDispatchError(
          "LINUX_CGROUP_CAPABILITIES_INCOMPLETE",
          "Linux cgroup v2 CPU, memory and pids prerequisites are not available"
        );
      }
      if (typeof config.cgroupRoot !== "string" || !config.cgroupRoot.startsWith("/")) {
        throw new ContainmentControllerDispatchError(
          "LINUX_DELEGATED_ROOT_REQUIRED",
          "Linux containment requires an absolute host-configured delegated cgroup v2 child path"
        );
      }
      nativeController = createLinuxCgroupV2ResourceController({
        cgroupRoot: config.cgroupRoot,
        limits: {
          maxMemoryBytes: policy.limits.memoryBytes,
          cpuQuotaMicros: policy.limits.cpuPercent * 1000,
          cpuPeriodMicros: 100000,
          maxProcesses: policy.limits.processCount
        }
      });
    } else if (capabilities.platform === "win32") {
      const windows = capabilities.windowsJobObjects;
      if (!windows?.platformSupported || !windows.powershellAvailable) {
        throw new ContainmentControllerDispatchError(
          "WINDOWS_JOB_OBJECT_CAPABILITIES_INCOMPLETE",
          "Windows Job Object support or PowerShell was not detected"
        );
      }
      nativeController = createWindowsJobObjectResourceController({
        limits: {
          maxMemoryBytes: policy.limits.memoryBytes,
          cpuRatePercent: policy.limits.cpuPercent,
          maxProcesses: policy.limits.processCount
        }
      });
    } else {
      throw new ContainmentControllerDispatchError(
        "UNSUPPORTED_CONTAINMENT_PLATFORM",
        "no native resource containment adapter is available for this operating system"
      );
    }

    const status = nativeController.getStatus();
    if (status?.available !== true || typeof status.mode !== "string") {
      throw new ContainmentControllerDispatchError(
        "NATIVE_CONTROLLER_NOT_READY",
        "the native OS resource controller did not report an available enforcement mode"
      );
    }
  } catch (error) {
    fallbackReason = error?.code ?? "NATIVE_CONTROLLER_INITIALIZATION_FAILED";
    nativeController = null;
    if (!policy.allowUncontainedFallback || policy.required) {
      if (error instanceof ContainmentControllerDispatchError) throw error;
      throw new ContainmentControllerDispatchError(
        "NATIVE_CONTROLLER_INITIALIZATION_FAILED",
        "the native OS resource controller could not be initialized",
        error
      );
    }
  }

  const fallbackScopes = new Set();
  let closed = false;
  let closePromise = null;

  function getStatus() {
    const nativeStatus = nativeController ? nativeController.getStatus() : null;
    return Object.freeze({
      schemaVersion: 1,
      state: closed ? "closed" : nativeController ? "ready" : "fallback",
      accepting: !closed && (nativeController === null || nativeStatus.accepting !== false),
      platform: capabilities.platform,
      mode: nativeController ? nativeStatus.mode : "uncontained-fallback",
      available: nativeController !== null,
      enforced: nativeController !== null,
      required: policy.required,
      allowUncontainedFallback: policy.allowUncontainedFallback,
      fallbackReason,
      activeScopes: nativeController ? nativeStatus.activeScopes : fallbackScopes.size,
      capabilities,
      policy
    });
  }

  function createScope(request) {
    if (closed) {
      throw new ContainmentControllerDispatchError("CONTROLLER_CLOSED", "containment dispatcher is closed");
    }
    if (nativeController) return nativeController.createScope(request);
    return createUncontainedScope(fallbackScopes, request);
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      if (nativeController) {
        await nativeController.close();
      } else {
        await Promise.all([...fallbackScopes].map((scope) => scope.close()));
      }
      return getStatus();
    })();
    return closePromise;
  }

  return Object.freeze({
    getPolicy: () => policy,
    getCapabilities: () => capabilities,
    getStatus,
    createScope,
    close
  });
}
