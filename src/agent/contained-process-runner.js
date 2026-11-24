import { createContainmentControllerDispatcher } from "./containment-controller-dispatch.js";
import { createLocalProcessEngineRunner } from "./execution-process-runner.js";

const RUNNER_KEYS = new Set([
  "engineId",
  "moduleRoot",
  "modulePath",
  "exportName",
  "cwd",
  "timeoutMs",
  "killGraceMs",
  "maxInputBytes",
  "maxOutputBytes"
]);
const CONTAINMENT_KEYS = new Set([
  "policy",
  "cgroupRoot",
  "capabilityProbeOptions"
]);
const EVENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/u;

export class ContainedProcessEngineRunnerError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ContainedProcessEngineRunnerError";
    this.code = code;
  }
}

function readRecord(value, label, allowedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContainedProcessEngineRunnerError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContainedProcessEngineRunnerError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new ContainedProcessEngineRunnerError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ContainedProcessEngineRunnerError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function readEventJournal(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContainedProcessEngineRunnerError("INVALID_EVENT_JOURNAL", "eventJournal must expose a trusted recordEvent() method");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "recordEvent");
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
    throw new ContainedProcessEngineRunnerError("INVALID_EVENT_JOURNAL", "eventJournal must expose an own recordEvent() method");
  }
  return descriptor.value.bind(value);
}

function safeEventCode(error) {
  return typeof error?.code === "string" && EVENT_CODE_PATTERN.test(error.code)
    ? error.code
    : "CONTAINMENT_OPERATION_FAILED";
}

/**
 * Creates a local process runner whose OS resource controller is selected
 * and owned by a containment dispatcher.
 *
 * The factory owns both lifecycles: it closes the process runner first, then
 * closes the dispatcher. Resource policy is explicit; fallback remains
 * disabled unless containment.policy.allowUncontainedFallback is true.
 *
 * An optional execution event journal receives only fixed lifecycle metadata
 * and engine/execution identifiers. Inputs, outputs, PIDs and free-form errors
 * are never written to the journal. Observer failures never block execution.
 */
export function createContainedLocalProcessEngineRunner(options = {}) {
  const config = readRecord(options, "options", new Set(["runner", "containment", "eventJournal"]));
  const runnerOptions = readRecord(config.runner, "runner", RUNNER_KEYS);
  const containmentOptions = readRecord(config.containment ?? {}, "containment", CONTAINMENT_KEYS);
  const recordEvent = readEventJournal(config.eventJournal);

  let eventEmissionFailures = 0;
  function emitEvent(eventType, metadata = {}) {
    if (!recordEvent) return;
    try {
      const result = recordEvent({ eventType, stage: "containment", ...metadata });
      if (result && typeof result.then === "function") {
        eventEmissionFailures += 1;
        Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      eventEmissionFailures += 1;
    }
  }

  function emitFailure(engineId, executionId, error, stage = "containment") {
    emitEvent("CONTAINMENT_FAILURE", {
      engineId,
      ...(executionId ? { executionId } : {}),
      stage,
      severity: "error",
      code: safeEventCode(error)
    });
  }

  const dispatcher = createContainmentControllerDispatcher(containmentOptions);
  const controllerStatus = dispatcher.getStatus();
  if (controllerStatus.enforced) {
    const readyCode = controllerStatus.mode === "windows-job-object"
      ? "WINDOWS_JOB_OBJECT_READY"
      : "LINUX_CGROUP_V2_READY";
    emitEvent("CONTAINMENT_CONTROLLER_READY", {
      engineId: runnerOptions.engineId,
      code: readyCode
    });
  } else {
    emitEvent("CONTAINMENT_FALLBACK_ACTIVE", {
      engineId: runnerOptions.engineId,
      severity: "warning",
      code: "UNCONTAINED_FALLBACK_ACTIVE"
    });
  }

  // Observe the native controller contract without changing its enforcement
  // semantics. The process runner still performs attach-before-bootstrap.
  const observedController = Object.freeze({
    getStatus: () => dispatcher.getStatus(),
    createScope(input) {
      let scope;
      try {
        scope = dispatcher.createScope(input);
      } catch (error) {
        emitFailure(input?.engineId ?? runnerOptions.engineId, input?.requestId, error);
        throw error;
      }

      const engineId = input.engineId;
      const executionId = input.requestId;
      emitEvent("CONTAINMENT_SCOPE_CREATED", { engineId, executionId });

      return Object.freeze({
        async attachProcess(pid) {
          try {
            const result = await scope.attachProcess(pid);
            if (result?.contained === false || result?.attached === false) {
              emitEvent("CONTAINMENT_FALLBACK_USED", {
                engineId,
                executionId,
                severity: "warning",
                code: "UNCONTAINED_PROCESS_ATTACHMENT"
              });
            } else if (result?.attached === true) {
              emitEvent("CONTAINMENT_PROCESS_ATTACHED", { engineId, executionId });
            }
            return result;
          } catch (error) {
            emitFailure(engineId, executionId, error);
            throw error;
          }
        },
        async terminateAll() {
          try {
            const result = await scope.terminateAll();
            if (result?.contained === false || result?.terminated === false) {
              emitEvent("CONTAINMENT_FALLBACK_USED", {
                engineId,
                executionId,
                severity: "warning",
                code: "UNCONTAINED_PROCESS_TERMINATION"
              });
            } else if (result?.terminated === true) {
              emitEvent("CONTAINMENT_SCOPE_TERMINATED", { engineId, executionId });
            }
            return result;
          } catch (error) {
            emitFailure(engineId, executionId, error);
            throw error;
          }
        },
        getUsage() {
          return scope.getUsage();
        },
        async close() {
          try {
            const result = await scope.close();
            emitEvent("CONTAINMENT_SCOPE_CLOSED", { engineId, executionId });
            return result;
          } catch (error) {
            emitFailure(engineId, executionId, error);
            throw error;
          }
        }
      });
    }
  });

  let processRunner;
  try {
    const policy = dispatcher.getPolicy();
    processRunner = createLocalProcessEngineRunner({
      ...runnerOptions,
      resourceController: observedController,
      requireResourceContainment: policy.required
    });
  } catch (error) {
    Promise.resolve(dispatcher.close()).catch(() => undefined);
    throw new ContainedProcessEngineRunnerError(
      "PROCESS_RUNNER_INITIALIZATION_FAILED",
      "the contained process runner could not be initialized",
      error
    );
  }

  let closed = false;
  let closePromise = null;

  function getStatus() {
    return Object.freeze({
      ...processRunner.getStatus(),
      containmentDispatcher: dispatcher.getStatus(),
      eventJournal: Object.freeze({
        enabled: recordEvent !== null,
        emissionFailures: eventEmissionFailures
      })
    });
  }

  function run(input, executionOptions = {}) {
    if (closed) {
      return Promise.reject(new ContainedProcessEngineRunnerError(
        "RUNNER_CLOSED",
        "contained process runner is closed"
      ));
    }
    return processRunner.run(input, executionOptions);
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      const failures = [];
      try {
        await processRunner.close();
      } catch (error) {
        failures.push(error);
        emitFailure(runnerOptions.engineId, undefined, error, "shutdown");
      }
      try {
        await dispatcher.close();
        emitEvent("CONTAINMENT_CONTROLLER_CLOSED", { engineId: runnerOptions.engineId });
      } catch (error) {
        failures.push(error);
        emitFailure(runnerOptions.engineId, undefined, error, "shutdown");
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "contained process runner shutdown encountered multiple failures");
      }
      return getStatus();
    })();
    return closePromise;
  }

  return Object.freeze({
    engineId: runnerOptions.engineId,
    run,
    getStatus,
    close
  });
}
