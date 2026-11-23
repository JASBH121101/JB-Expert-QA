const RUNTIME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;

export class AutonomousExecutionRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AutonomousExecutionRuntimeError";
    this.code = code;
  }
}

function readRecord(value, label, allowedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AutonomousExecutionRuntimeError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AutonomousExecutionRuntimeError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new AutonomousExecutionRuntimeError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new AutonomousExecutionRuntimeError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function readMethod(target, name) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
    throw new AutonomousExecutionRuntimeError(
      "INVALID_ORCHESTRATOR",
      "orchestrator must expose a trusted " + name + "() method"
    );
  }
  return descriptor.value.bind(target);
}

function normalizeExecutionOptions(value) {
  const options = readRecord(value, "execution options", new Set(["signal", "executionId"]));
  if (options.signal !== undefined) {
    const signal = options.signal;
    if (!signal || typeof signal.aborted !== "boolean" ||
        typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function") {
      throw new AutonomousExecutionRuntimeError("INVALID_SIGNAL", "signal must be an AbortSignal");
    }
  }
  if (options.executionId !== undefined &&
      (typeof options.executionId !== "string" || !RUNTIME_ID_PATTERN.test(options.executionId))) {
    throw new AutonomousExecutionRuntimeError("INVALID_EXECUTION_ID", "executionId has an invalid format");
  }
  return Object.freeze({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.executionId === undefined ? {} : { executionId: options.executionId })
  });
}

/**
 * Creates the in-process host runtime around an already configured QA
 * orchestrator. This layer owns runtime admission and shutdown only; the
 * orchestrator remains the sole authority for engine dispatch, policy,
 * permissions, approval and the execution ledger.
 *
 * The runtime is disabled unless the host explicitly passes enabled: true.
 * It does not create workers, a queue, durable jobs or an implicit approval
 * provider. Those concerns belong to separate runtime layers.
 */
export function createAutonomousExecutionRuntime(options = {}) {
  const config = readRecord(options, "options", new Set(["orchestrator", "enabled"]));
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new AutonomousExecutionRuntimeError("INVALID_ENABLED_FLAG", "enabled must be a boolean");
  }

  const orchestrator = config.orchestrator;
  if (!orchestrator || typeof orchestrator !== "object" || Array.isArray(orchestrator)) {
    throw new AutonomousExecutionRuntimeError("INVALID_ORCHESTRATOR", "A trusted QA engine orchestrator is required");
  }

  const listEngines = readMethod(orchestrator, "listEngines");
  const getPolicy = readMethod(orchestrator, "getPolicy");
  const verifyLedger = readMethod(orchestrator, "verifyLedger");
  const executeOrchestrated = readMethod(orchestrator, "execute");

  // Discovery is read-only. Runtime construction must never invoke an engine.
  const listedEngines = listEngines();
  if (!Array.isArray(listedEngines) || listedEngines.length > 256) {
    throw new AutonomousExecutionRuntimeError("INVALID_ENGINE_CATALOG", "orchestrator.listEngines() returned an invalid catalog");
  }
  const engines = Object.freeze([...listedEngines]);
  const policy = getPolicy();
  if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
      typeof policy.id !== "string" || !policy.id.trim()) {
    throw new AutonomousExecutionRuntimeError("INVALID_POLICY_SNAPSHOT", "orchestrator.getPolicy() returned an invalid policy snapshot");
  }

  const configuredEnabled = config.enabled === true;
  let state = configuredEnabled ? "ready" : "disabled";
  let activeExecution = null;
  let closePromise = null;

  function getStatus() {
    return Object.freeze({
      state,
      enabled: configuredEnabled,
      accepting: state === "ready",
      active: activeExecution !== null,
      engineCount: engines.length,
      policyId: policy.id
    });
  }

  async function execute(plan, executionOptions = {}) {
    if (state === "disabled") {
      throw new AutonomousExecutionRuntimeError("RUNTIME_DISABLED", "Autonomous execution runtime is disabled by default");
    }
    if (state === "closing" || state === "closed") {
      throw new AutonomousExecutionRuntimeError("RUNTIME_CLOSED", "Autonomous execution runtime is not accepting new work");
    }
    if (state === "running" || activeExecution !== null) {
      throw new AutonomousExecutionRuntimeError("RUNTIME_BUSY", "Autonomous execution runtime already has an active execution");
    }

    const normalizedOptions = normalizeExecutionOptions(executionOptions);
    state = "running";
    const currentExecution = Promise.resolve().then(() => executeOrchestrated(plan, normalizedOptions));
    activeExecution = currentExecution;

    try {
      return await currentExecution;
    } finally {
      if (activeExecution === currentExecution) activeExecution = null;
      state = state === "closing" ? "closed" : "ready";
    }
  }

  async function verifyLedgerSnapshot() {
    return verifyLedger();
  }

  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const pending = activeExecution;
      if (pending) {
        state = "closing";
        await pending.then(() => undefined, () => undefined);
      }
      state = "closed";
      return getStatus();
    })();
    return closePromise;
  }

  return Object.freeze({
    getStatus,
    listEngines: () => engines,
    getPolicy: () => policy,
    verifyLedger: verifyLedgerSnapshot,
    execute,
    close
  });
}
