import { createAutonomousExecutionEngine } from "../agent/autonomous-execution.js";

const ENGINE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const ACTION_PREFIX = "qa.engine.";
const EXECUTION_PERMISSION = "qa:engine-execute";
const MAX_ENGINES = 256;

export const QA_ENGINE_ACTION_PREFIX = ACTION_PREFIX;
export const QA_ENGINE_EXECUTION_PERMISSION = EXECUTION_PERMISSION;
export const QA_ENGINE_ORCHESTRATOR_RISK = "high";

export class QaEngineOrchestratorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QaEngineOrchestratorError";
    this.code = code;
  }
}

function readOptions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new QaEngineOrchestratorError("INVALID_OPTIONS", "options must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new QaEngineOrchestratorError("INVALID_OPTIONS", "options must be a plain object");
  }
  const allowed = new Set(["registry", "policy", "ledger", "requestApproval", "clock", "idFactory"]);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new QaEngineOrchestratorError("UNSUPPORTED_OPTION", "options contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new QaEngineOrchestratorError("ACCESSOR_NOT_ALLOWED", "options cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function registryMethod(registry, name) {
  const descriptor = Object.getOwnPropertyDescriptor(registry, name);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
    throw new QaEngineOrchestratorError("INVALID_REGISTRY", "registry must expose a trusted " + name + "() method");
  }
  return descriptor.value.bind(registry);
}

function readSealedRegistry(registry) {
  if (registry === null || typeof registry !== "object" || Array.isArray(registry) ||
      (Object.getPrototypeOf(registry) !== Object.prototype && Object.getPrototypeOf(registry) !== null)) {
    throw new QaEngineOrchestratorError("INVALID_REGISTRY", "A JB QA engine registry instance is required");
  }

  const list = registryMethod(registry, "list");
  const getRunner = registryMethod(registry, "getRunner");
  const isSealed = registryMethod(registry, "isSealed");
  if (isSealed() !== true) {
    throw new QaEngineOrchestratorError("REGISTRY_NOT_SEALED", "Seal the engine registry before creating the orchestrator");
  }

  const metadata = list();
  if (!Array.isArray(metadata) || metadata.length > MAX_ENGINES) {
    throw new QaEngineOrchestratorError("INVALID_REGISTRY", "registry.list() returned an invalid engine collection");
  }
  const seen = new Set();
  const engines = metadata.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.id !== "string" || !ENGINE_ID_PATTERN.test(entry.id)) {
      throw new QaEngineOrchestratorError("INVALID_ENGINE_METADATA", "registry contains an invalid engine identifier");
    }
    if (seen.has(entry.id)) {
      throw new QaEngineOrchestratorError("DUPLICATE_ENGINE", "registry contains a duplicate engine identifier");
    }
    seen.add(entry.id);
    const runner = getRunner(entry.id);
    if (typeof runner !== "function") {
      throw new QaEngineOrchestratorError("INVALID_RUNNER", "registry has no trusted runner for " + entry.id);
    }
    return Object.freeze({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : entry.id,
      version: typeof entry.version === "string" ? entry.version : "",
      category: typeof entry.category === "string" ? entry.category : "",
      targetType: typeof entry.targetType === "string" ? entry.targetType : "",
      executionMode: typeof entry.executionMode === "string" ? entry.executionMode : "",
      capabilities: Object.freeze(Array.isArray(entry.capabilities) ? [...entry.capabilities] : []),
      runner
    });
  });
  return engines;
}

/** Derives the stable policy action type for one explicitly registered engine. */
export function getQaEngineActionType(engineId) {
  if (typeof engineId !== "string" || !ENGINE_ID_PATTERN.test(engineId)) {
    throw new QaEngineOrchestratorError("INVALID_ENGINE_ID", "engineId must be a valid namespaced engine identifier");
  }
  return ACTION_PREFIX + engineId;
}

/**
 * Connects a sealed, trusted engine registry to the existing policy-bounded
 * autonomous execution engine. No runner is invoked during construction.
 *
 * Every adapter is classified as high risk until a future adapter contract
 * carries independently validated risk metadata. Each invocation therefore
 * requires a matching policy rule, the qa:engine-execute permission and an
 * external approval receipt.
 */
export function createQaEngineOrchestrator(options = {}) {
  const config = readOptions(options);
  const engines = readSealedRegistry(config.registry);
  const actions = engines.map((engine) => ({
    type: getQaEngineActionType(engine.id),
    risk: QA_ENGINE_ORCHESTRATOR_RISK,
    permissions: [EXECUTION_PERMISSION],
    execute: ({ input, signal }) => engine.runner(input, { signal })
  }));

  const executionEngine = createAutonomousExecutionEngine({
    actions,
    policy: config.policy ?? {},
    ...(Object.hasOwn(config, "ledger") ? { ledger: config.ledger } : {}),
    ...(Object.hasOwn(config, "requestApproval") ? { requestApproval: config.requestApproval } : {}),
    ...(Object.hasOwn(config, "clock") ? { clock: config.clock } : {}),
    ...(Object.hasOwn(config, "idFactory") ? { idFactory: config.idFactory } : {})
  });

  const publicEngines = Object.freeze(engines.map(({ runner, ...metadata }) => Object.freeze(metadata)));
  return Object.freeze({
    listEngines() {
      return publicEngines;
    },
    getPolicy: executionEngine.getPolicy,
    getLedger: executionEngine.getLedger,
    verifyLedger: executionEngine.verifyLedger,
    execute: executionEngine.execute
  });
}
