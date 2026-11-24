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

/**
 * Creates a local process runner whose OS resource controller is selected
 * and owned by a containment dispatcher.
 *
 * The factory owns both lifecycles: it closes the process runner first, then
 * closes the dispatcher. Resource policy is explicit; fallback remains
 * disabled unless containment.policy.allowUncontainedFallback is true.
 *
 * runner accepts only process-runner configuration. Callers cannot inject a
 * second resource controller or override requireResourceContainment here.
 */
export function createContainedLocalProcessEngineRunner(options = {}) {
  const config = readRecord(options, "options", new Set(["runner", "containment"]));
  const runnerOptions = readRecord(config.runner, "runner", RUNNER_KEYS);
  const containmentOptions = readRecord(config.containment ?? {}, "containment", CONTAINMENT_KEYS);

  const dispatcher = createContainmentControllerDispatcher(containmentOptions);
  let processRunner;
  try {
    const policy = dispatcher.getPolicy();
    processRunner = createLocalProcessEngineRunner({
      ...runnerOptions,
      resourceController: dispatcher,
      requireResourceContainment: policy.required
    });
  } catch (error) {
    // No execution scopes exist during construction, but close the dispatcher
    // to keep ownership deterministic if a native adapter was initialized.
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
      containmentDispatcher: dispatcher.getStatus()
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
      }
      try {
        await dispatcher.close();
      } catch (error) {
        failures.push(error);
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
