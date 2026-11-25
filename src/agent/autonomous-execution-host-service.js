import { attachHostSignalLifecycle } from "./autonomous-host-signal-lifecycle.js";

export class AutonomousExecutionHostServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AutonomousExecutionHostServiceError";
    this.code = code;
  }
}

function readOptions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AutonomousExecutionHostServiceError("INVALID_OPTIONS", "options must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AutonomousExecutionHostServiceError("INVALID_OPTIONS", "options must be a plain object");
  }
  const allowed = new Set(["host", "signalSource", "signals", "onError"]);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new AutonomousExecutionHostServiceError("UNSUPPORTED_OPTION", "options contain an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new AutonomousExecutionHostServiceError("ACCESSOR_NOT_ALLOWED", "options cannot contain accessors");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function readMethod(target, name) {
  const descriptor = target && Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
    throw new AutonomousExecutionHostServiceError(
      "INVALID_HOST",
      "host must expose a trusted " + name + "() method"
    );
  }
  return descriptor.value.bind(target);
}

/**
 * Binds an already constructed autonomous execution host to a local service
 * process lifecycle. Construction is inert. start() explicitly starts the
 * host and installs only the selected signal handlers; stop() detaches those
 * handlers and awaits the host's ordered graceful close.
 *
 * This adapter does not install OS services, change restart policy, call
 * process.exit(), or recover interrupted jobs. The external service manager
 * owns boot, crash-restart and process supervision policy.
 */
export function createAutonomousExecutionHostService(options = {}) {
  const config = readOptions(options);
  const host = config.host;
  if (host === null || typeof host !== "object" || Array.isArray(host)) {
    throw new AutonomousExecutionHostServiceError("INVALID_HOST", "host is required");
  }
  const startHost = readMethod(host, "start");
  const closeHost = readMethod(host, "close");
  const getHostStatus = readMethod(host, "getStatus");
  const signalSource = config.signalSource;
  if (signalSource === null || typeof signalSource !== "object" ||
      typeof signalSource.on !== "function" || typeof signalSource.off !== "function") {
    throw new AutonomousExecutionHostServiceError(
      "INVALID_SIGNAL_SOURCE",
      "signalSource must expose on() and off()"
    );
  }
  if (config.onError !== undefined && typeof config.onError !== "function") {
    throw new AutonomousExecutionHostServiceError("INVALID_ERROR_HANDLER", "onError must be a function");
  }

  let state = "idle";
  let signalLifecycle = null;
  let closePromise = null;

  function getStatus() {
    const hostStatus = getHostStatus();
    let signalStatus = null;
    try {
      signalStatus = signalLifecycle?.getStatus() ?? null;
    } catch {}

    let effectiveState = state;
    if (signalStatus?.state === "failed" || hostStatus?.state === "failed") {
      effectiveState = "failed";
    } else if (signalStatus?.state === "closed" || hostStatus?.state === "closed") {
      effectiveState = "closed";
    } else if (signalStatus?.state === "shutting-down" || hostStatus?.state === "closing") {
      effectiveState = "stopping";
    }

    return Object.freeze({
      state: effectiveState,
      started: effectiveState === "running",
      host: hostStatus,
      signalLifecycle: signalStatus
    });
  }

  function start() {
    if (getStatus().state === "running") return getStatus();
    if (state !== "idle") {
      throw new AutonomousExecutionHostServiceError(
        "SERVICE_TERMINAL",
        "a stopped or failed host service cannot be restarted"
      );
    }

    signalLifecycle = attachHostSignalLifecycle({
      host,
      signalSource,
      ...(config.signals === undefined ? {} : { signals: config.signals }),
      ...(config.onError === undefined ? {} : { onError: config.onError })
    });

    try {
      startHost();
      state = "running";
      return getStatus();
    } catch (error) {
      signalLifecycle.detach();
      signalLifecycle = null;
      state = "failed";
      throw error;
    }
  }

  function stop() {
    if (closePromise) return closePromise;
    if (state === "closed") return Promise.resolve(getStatus());

    const currentSignalStatus = signalLifecycle?.getStatus();
    if (currentSignalStatus &&
        (currentSignalStatus.state === "shutting-down" ||
         currentSignalStatus.state === "closed" ||
         currentSignalStatus.state === "failed")) {
      signalLifecycle.detach();
      closePromise = signalLifecycle.shutdown().then(
        () => {
          state = "closed";
          return getStatus();
        },
        error => {
          state = "failed";
          throw error;
        }
      );
      return closePromise;
    }

    state = "stopping";
    signalLifecycle?.detach();
    closePromise = (async () => {
      try {
        await closeHost();
        state = "closed";
        return getStatus();
      } catch (error) {
        state = "failed";
        throw error;
      }
    })();
    return closePromise;
  }

  return Object.freeze({
    getStatus,
    start,
    stop,
    host
  });
}
