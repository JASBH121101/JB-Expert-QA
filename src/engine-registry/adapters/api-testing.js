import {
  API_TESTING_ENGINE_ID,
  API_TESTING_ENGINE_VERSION,
  createApiRequestEngine,
  createApiAssertionsEngine,
  createApiContractTestingEngine,
  createApiSecurityTestingEngine,
  createApiWorkflowTestingEngine,
  createApiRegressionEngine,
  createApiRateLimitTestingEngine
} from "../../../packages/api-testing-engine/src/index.js";

const ADAPTER_ID = API_TESTING_ENGINE_ID;
const ADAPTER_VERSION = API_TESTING_ENGINE_VERSION;
const ADAPTER_CAPABILITIES = Object.freeze([
  "api-request", "assertions", "contracts", "passive-security",
  "workflows", "regression", "rate-limit-observation"
]);
const COMMAND_FIELDS = new Set([
  "operation", "request", "response", "assertions", "evaluationOptions",
  "contract", "validationOptions", "policy", "workflow",
  "baselineOptions", "baseline", "compareOptions", "probe"
]);
const OPERATION_FIELDS = Object.freeze({
  request: Object.freeze(["operation", "request"]),
  assertions: Object.freeze(["operation", "response", "assertions", "evaluationOptions"]),
  contract: Object.freeze(["operation", "contract", "response", "validationOptions"]),
  security: Object.freeze(["operation", "response", "policy"]),
  workflow: Object.freeze(["operation", "workflow"]),
  "regression-baseline": Object.freeze(["operation", "response", "baselineOptions"]),
  "regression-compare": Object.freeze(["operation", "baseline", "response", "compareOptions"]),
  "rate-limit": Object.freeze(["operation", "probe"])
});
const REQUIRED_OPERATION_FIELDS = Object.freeze({
  request: Object.freeze(["operation", "request"]),
  assertions: Object.freeze(["operation", "response", "assertions"]),
  contract: Object.freeze(["operation", "contract", "response"]),
  security: Object.freeze(["operation", "response"]),
  workflow: Object.freeze(["operation", "workflow"]),
  "regression-baseline": Object.freeze(["operation", "response"]),
  "regression-compare": Object.freeze(["operation", "baseline", "response"]),
  "rate-limit": Object.freeze(["operation", "probe"])
});

export const API_TESTING_ADAPTER_ID = ADAPTER_ID;
export const API_TESTING_ADAPTER_VERSION = ADAPTER_VERSION;
export const API_TESTING_ADAPTER_OPERATIONS = Object.freeze(Object.keys(OPERATION_FIELDS));

export class ApiTestingAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiTestingAdapterError";
    this.code = code;
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRecord(value, label, allowedKeys) {
  if (!isPlainRecord(value)) throw new ApiTestingAdapterError("INVALID_RECORD", label + " must be a plain object");
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (allowedKeys && !allowedKeys.has(key))) {
      throw new ApiTestingAdapterError("UNSUPPORTED_FIELD", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ApiTestingAdapterError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function validateCommand(input) {
  const command = readRecord(input, "command", COMMAND_FIELDS);
  if (typeof command.operation !== "string" || !Object.hasOwn(OPERATION_FIELDS, command.operation)) {
    throw new ApiTestingAdapterError("UNSUPPORTED_OPERATION", "A supported API Testing operation is required");
  }
  const allowed = new Set(OPERATION_FIELDS[command.operation]);
  for (const key of Object.keys(command)) {
    if (!allowed.has(key)) {
      throw new ApiTestingAdapterError("UNSUPPORTED_FIELD", "command contains a field not supported by operation " + command.operation);
    }
  }
  for (const key of REQUIRED_OPERATION_FIELDS[command.operation]) {
    if (key !== "operation" && !Object.hasOwn(command, key)) {
      throw new ApiTestingAdapterError("MISSING_FIELD", "command." + key + " is required for operation " + command.operation);
    }
  }
  return command;
}

function validateExecutionOptions(options, operation) {
  const normalized = readRecord(options, "execution options", new Set(["signal"]));
  if (Object.hasOwn(normalized, "signal")) {
    if (!["request", "workflow", "rate-limit"].includes(operation)) {
      throw new ApiTestingAdapterError("UNSUPPORTED_OPTION", "AbortSignal is supported only for network operations");
    }
    const signal = normalized.signal;
    if (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
        typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function") {
      throw new ApiTestingAdapterError("INVALID_SIGNAL", "execution options.signal must be an AbortSignal");
    }
  }
  return normalized;
}

function assertRegistryPort(registry) {
  if (!isPlainRecord(registry)) {
    throw new ApiTestingAdapterError("INVALID_REGISTRY", "A JB QA engine registry instance is required");
  }
  for (const key of ["register", "has"]) {
    const descriptor = Object.getOwnPropertyDescriptor(registry, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new ApiTestingAdapterError("INVALID_REGISTRY", "Registry must expose trusted register() and has() methods");
    }
  }
}

function buildRequestOptions(config) {
  const options = { allowedOrigins: config.allowedOrigins };
  for (const key of ["fetchImpl", "timeoutMs", "maxRequestBytes", "maxResponseBytes"]) {
    if (Object.hasOwn(config, key)) options[key] = config[key];
  }
  return options;
}

/** Creates a trusted adapter for the complete seven-module API Testing Engine. */
export function createApiTestingEngineAdapter(options = {}) {
  const config = readRecord(options, "adapter options", new Set([
    "allowedOrigins", "fetchImpl", "timeoutMs", "maxRequestBytes",
    "maxResponseBytes", "activeRateLimitTesting"
  ]));
  if (Object.hasOwn(config, "activeRateLimitTesting") && typeof config.activeRateLimitTesting !== "boolean") {
    throw new ApiTestingAdapterError("INVALID_RATE_LIMIT_OPT_IN", "activeRateLimitTesting must be a boolean");
  }

  const requestEngine = createApiRequestEngine(buildRequestOptions(config));
  const assertionsEngine = createApiAssertionsEngine();
  const contractEngine = createApiContractTestingEngine();
  const securityEngine = createApiSecurityTestingEngine();
  const workflowEngine = createApiWorkflowTestingEngine({ requestEngine, assertionsEngine });
  const regressionEngine = createApiRegressionEngine();
  const rateLimitEngine = createApiRateLimitTestingEngine({
    requestEngine,
    activeTesting: config.activeRateLimitTesting === true
  });

  async function run(input, options = {}) {
    const command = validateCommand(input);
    const executionOptions = validateExecutionOptions(options, command.operation);
    switch (command.operation) {
      case "request":
        return requestEngine.request(command.request, executionOptions);
      case "assertions":
        return assertionsEngine.evaluate(command.response, command.assertions, command.evaluationOptions);
      case "contract":
        return contractEngine.compile(command.contract).validate(command.response, command.validationOptions);
      case "security":
        return securityEngine.analyze(command.response, command.policy);
      case "workflow":
        return workflowEngine.run(command.workflow, executionOptions);
      case "regression-baseline":
        return regressionEngine.createBaseline(command.response, command.baselineOptions);
      case "regression-compare":
        return regressionEngine.compare(command.baseline, command.response, command.compareOptions);
      case "rate-limit":
        return rateLimitEngine.run(command.probe, executionOptions);
      default:
        throw new ApiTestingAdapterError("UNSUPPORTED_OPERATION", "Unsupported API Testing operation");
    }
  }

  return Object.freeze({
    id: ADAPTER_ID,
    name: "API Testing Engine",
    version: ADAPTER_VERSION,
    category: "api",
    targetType: "payload",
    executionMode: "in-process",
    capabilities: ADAPTER_CAPABILITIES,
    description: "Delegates bounded API requests, assertions, contracts, passive security, workflows, regression and rate-limit observations to the canonical API Testing modules.",
    run
  });
}

/** Registers trusted API metadata and handlers without invoking the runner. */
export function registerApiTestingEngine(registry, options = {}) {
  assertRegistryPort(registry);
  const adapter = createApiTestingEngineAdapter(options);
  if (registry.has(adapter.id)) {
    throw new ApiTestingAdapterError("DUPLICATE_ENGINE", "API Testing Engine is already registered");
  }
  return registry.register(adapter);
}
