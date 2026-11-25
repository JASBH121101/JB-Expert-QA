const DEFAULT_SIGNALS = Object.freeze(["SIGINT", "SIGTERM"]);
const SIGNAL_PATTERN = /^SIG[A-Z0-9]{1,8}$/u;

export class HostSignalLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostSignalLifecycleError";
    this.code = code;
  }
}

function readOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostSignalLifecycleError("INVALID_OPTIONS", "options must be a plain object");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new HostSignalLifecycleError("INVALID_OPTIONS", "options must be a plain object");
  }
  const allowed = new Set(["host", "signalSource", "signals", "onError"]);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new HostSignalLifecycleError("UNSUPPORTED_OPTION", "options contain an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new HostSignalLifecycleError("ACCESSOR_NOT_ALLOWED", "options cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

/**
 * Explicitly attach host shutdown to selected process-like signals.
 * This adapter does not start the host, call process.exit, or attach global
 * listeners at import time. The embedding application owns signal installation.
 */
export function attachHostSignalLifecycle(options = {}) {
  const config = readOptions(options);
  const host = config.host;
  const source = config.signalSource;
  if (!host || typeof host !== "object" || typeof host.close !== "function") {
    throw new HostSignalLifecycleError("INVALID_HOST", "host must expose close()");
  }
  if (!source || typeof source.on !== "function" || typeof source.off !== "function") {
    throw new HostSignalLifecycleError("INVALID_SIGNAL_SOURCE", "signalSource must expose on() and off()");
  }
  const signals = config.signals === undefined ? DEFAULT_SIGNALS : config.signals;
  if (!Array.isArray(signals) || signals.length < 1 || signals.length > 4 ||
      signals.some(signal => typeof signal !== "string" || !SIGNAL_PATTERN.test(signal)) ||
      new Set(signals).size !== signals.length) {
    throw new HostSignalLifecycleError("INVALID_SIGNALS", "signals must be a unique list of valid signal names");
  }
  const onError = config.onError;
  if (onError !== undefined && typeof onError !== "function") {
    throw new HostSignalLifecycleError("INVALID_ERROR_HANDLER", "onError must be a function");
  }

  let state = "attached";
  let shutdownSignal = null;
  let shutdownPromise = null;
  let closeErrorCode = null;
  const handlers = new Map();

  function status() {
    return Object.freeze({
      state,
      attachedSignals: Object.freeze(state === "attached" ? [...signals] : []),
      shutdownSignal,
      closeErrorCode
    });
  }

  function handleSignal(signal) {
    if (shutdownPromise) return shutdownPromise;
    shutdownSignal = signal;
    state = "shutting-down";
    shutdownPromise = Promise.resolve().then(() => host.close()).then(
      () => {
        state = "closed";
        return status();
      },
      error => {
        state = "failed";
        closeErrorCode = typeof error?.code === "string" ? error.code.slice(0, 80) : "HOST_CLOSE_FAILED";
        try { onError?.(error, signal); } catch {}
        return status();
      }
    );
    return shutdownPromise;
  }

  for (const signal of signals) {
    const handler = () => { void handleSignal(signal); };
    handlers.set(signal, handler);
    try {
      source.on(signal, handler);
    } catch (error) {
      for (const [attachedSignal, attachedHandler] of handlers) {
        try { source.off(attachedSignal, attachedHandler); } catch {}
      }
      throw new HostSignalLifecycleError("SIGNAL_ATTACH_FAILED", "failed to attach signal listener");
    }
  }

  function detach() {
    if (state === "attached") state = "detached";
    for (const [signal, handler] of handlers) {
      try { source.off(signal, handler); } catch {}
    }
    handlers.clear();
    return status();
  }

  return Object.freeze({
    getStatus: status,
    detach,
    shutdown: () => shutdownPromise ?? Promise.resolve(status())
  });
}
