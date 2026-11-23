import { createApiAssertionsEngine } from "./assertions.js";

const HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_KEYS = new Set(["method", "url", "headers", "json", "body", "timeoutMs", "maxResponseBytes"]);
const MAX_STEPS = 100;
const MAX_CAPTURES = 200;
const MAX_ASSERTIONS_PER_STEP = 100;
const MAX_WORKFLOW_NODES = 50000;
const MAX_WORKFLOW_DEPTH = 32;
const MAX_REPORT_STEPS = 100;

export const API_WORKFLOW_TESTING_ENGINE_ID = "jb.api-workflow-testing-engine";
export const API_WORKFLOW_TESTING_ENGINE_VERSION = "0.1.0";

const compiledDefinitions = new WeakMap();

export class ApiWorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiWorkflowError";
    this.code = code;
  }
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(label + " must be a plain object");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new TypeError(label + " cannot contain symbol properties");
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " cannot contain getters or setters");
    }
  }
}

function assertSafeData(value, label, limits = {}) {
  const maxNodes = limits.maxNodes ?? MAX_WORKFLOW_NODES;
  const maxDepth = limits.maxDepth ?? MAX_WORKFLOW_DEPTH;
  const seen = new Set();
  let nodes = 0;

  function visit(item, depth) {
    nodes += 1;
    if (nodes > maxNodes) throw new TypeError(label + " exceeds the maximum value count");
    if (depth > maxDepth) throw new TypeError(label + " exceeds the maximum nesting depth");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError(label + " contains a non-finite number");
      return;
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) throw new TypeError(label + " contains circular data");
      seen.add(item);
      const ownKeys = Reflect.ownKeys(item);
      if (ownKeys.some((key) => typeof key !== "string")) throw new TypeError(label + " arrays cannot contain symbol properties");
      const keys = ownKeys.filter((key) => key !== "length");
      if (keys.length !== item.length || keys.some((key) => !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length)) {
        throw new TypeError(label + " arrays cannot contain holes or custom properties");
      }
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError(label + " arrays cannot contain accessors");
        }
        visit(descriptor.value, depth + 1);
      }
      seen.delete(item);
      return;
    }
    if (!isRecord(item)) throw new TypeError(label + " must contain JSON-compatible plain objects only");
    if (seen.has(item)) throw new TypeError(label + " contains circular data");
    seen.add(item);
    const ownKeys = Reflect.ownKeys(item);
    if (ownKeys.some((key) => typeof key !== "string")) throw new TypeError(label + " objects cannot contain symbol properties");
    for (const key of ownKeys) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new TypeError(label + " contains a forbidden object key");
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError(label + " cannot contain getters or setters");
      }
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  }

  visit(value, 0);
}

function knownKeys(value, allowed, label) {
  assertPlainRecord(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ApiWorkflowError("UNSUPPORTED_FIELD", label + " contains an unsupported field: " + key);
  }
}

function requireString(value, label, maximum = 128) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value) {
    throw new ApiWorkflowError("INVALID_WORKFLOW", label + " must be a non-empty string of at most " + maximum + " characters");
  }
  return value;
}

function validateJsonPath(path, label) {
  requireString(path, label, 512);
  if (!path.startsWith("$")) throw new ApiWorkflowError("INVALID_REFERENCE_PATH", label + " must start with $");
  let index = 1;
  while (index < path.length) {
    if (path[index] === ".") {
      index += 1;
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(path.slice(index));
      if (!match) throw new ApiWorkflowError("INVALID_REFERENCE_PATH", label + " contains an invalid property segment");
      if (["__proto__", "prototype", "constructor"].includes(match[0])) {
        throw new ApiWorkflowError("INVALID_REFERENCE_PATH", label + " contains a forbidden property");
      }
      index += match[0].length;
    } else if (path[index] === "[") {
      const match = /^\[(\d+)\]/u.exec(path.slice(index));
      if (!match) throw new ApiWorkflowError("INVALID_REFERENCE_PATH", label + " supports numeric array indexes only in brackets");
      const position = Number(match[1]);
      if (!Number.isSafeInteger(position) || position > 1000000) {
        throw new ApiWorkflowError("INVALID_REFERENCE_PATH", label + " contains an out-of-bounds array index");
      }
      index += match[0].length;
    } else {
      throw new ApiWorkflowError("INVALID_REFERENCE_PATH", label + " contains invalid JSON path syntax");
    }
  }
  return path;
}

function resolvePath(root, path) {
  let current = root;
  let index = 1;
  while (index < path.length) {
    if (path[index] === ".") {
      index += 1;
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(path.slice(index));
      if (!match || ["__proto__", "prototype", "constructor"].includes(match[0])) return { exists: false };
      if (current === null || typeof current !== "object" || !Object.hasOwn(current, match[0])) return { exists: false };
      const descriptor = Object.getOwnPropertyDescriptor(current, match[0]);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return { exists: false };
      current = descriptor.value;
      index += match[0].length;
    } else if (path[index] === "[") {
      const match = /^\[(\d+)\]/u.exec(path.slice(index));
      if (!match) return { exists: false };
      const position = Number(match[1]);
      if (!Array.isArray(current) || position >= current.length) return { exists: false };
      const descriptor = Object.getOwnPropertyDescriptor(current, String(position));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return { exists: false };
      current = descriptor.value;
      index += match[0].length;
    } else {
      return { exists: false };
    }
  }
  return { exists: true, value: current };
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function validateReference(value, label, previousSteps, previousVariables, depth = 0) {
  if (depth > 24) throw new ApiWorkflowError("WORKFLOW_TOO_DEEP", label + " exceeds maximum binding depth");
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) validateReference(value[index], label + "[" + index + "]", previousSteps, previousVariables, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  const keys = Object.keys(value);
  if (keys.includes("$ref") || keys.includes("$var")) {
    if (keys.includes("$ref")) {
      knownKeys(value, new Set(["$ref", "path"]), label + " reference");
      const stepId = requireString(value.$ref, label + ".$ref", 64);
      if (!previousSteps.has(stepId)) {
        throw new ApiWorkflowError("FORWARD_REFERENCE", label + " references a step that has not completed earlier in the workflow");
      }
      validateJsonPath(value.path, label + ".path");
      return;
    }
    knownKeys(value, new Set(["$var"]), label + " variable");
    const name = requireString(value.$var, label + ".$var", 64);
    if (!previousVariables.has(name)) {
      throw new ApiWorkflowError("UNKNOWN_VARIABLE", label + " references a variable that has not been captured earlier");
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    validateReference(child, label + "." + key, previousSteps, previousVariables, depth + 1);
  }
}

function validateCondition(condition, label, previousSteps) {
  knownKeys(condition, new Set(["stepId", "status", "path", "equals", "exists"]), label);
  const stepId = requireString(condition.stepId, label + ".stepId", 64);
  if (!previousSteps.has(stepId)) throw new ApiWorkflowError("FORWARD_CONDITION", label + " must refer to a previous step");
  if (condition.status === undefined && condition.path === undefined) {
    throw new ApiWorkflowError("INVALID_CONDITION", label + " must define status or path");
  }
  if (condition.status !== undefined) {
    const validCode = (value) => Number.isInteger(value) && value >= 100 && value <= 599;
    if (Array.isArray(condition.status)) {
      if (condition.status.length !== 2 || !validCode(condition.status[0]) || !validCode(condition.status[1]) || condition.status[0] > condition.status[1]) {
        throw new ApiWorkflowError("INVALID_CONDITION", label + ".status must be a status code or an ordered status range");
      }
    } else if (!validCode(condition.status)) {
      throw new ApiWorkflowError("INVALID_CONDITION", label + ".status must be an HTTP status code");
    }
  }
  if (condition.path !== undefined) {
    validateJsonPath(condition.path, label + ".path");
    if (condition.equals === undefined && condition.exists === undefined) {
      throw new ApiWorkflowError("INVALID_CONDITION", label + " path conditions require equals or exists");
    }
    if (condition.equals !== undefined && condition.exists !== undefined) {
      throw new ApiWorkflowError("INVALID_CONDITION", label + " cannot combine equals and exists");
    }
    if (condition.exists !== undefined && typeof condition.exists !== "boolean") {
      throw new ApiWorkflowError("INVALID_CONDITION", label + ".exists must be boolean");
    }
  } else if (condition.equals !== undefined || condition.exists !== undefined) {
    throw new ApiWorkflowError("INVALID_CONDITION", label + " equals and exists require path");
  }
}

function validateWorkflowDefinition(workflow) {
  assertPlainRecord(workflow, "workflow");
  assertSafeData(workflow, "workflow");
  knownKeys(workflow, new Set(["schema", "workflowId", "version", "title", "stopOnFailure", "steps"]), "workflow");
  if (workflow.schema !== "jb.api-workflow/v1") {
    throw new ApiWorkflowError("UNSUPPORTED_WORKFLOW_SCHEMA", "workflow.schema must be jb.api-workflow/v1");
  }
  const workflowId = requireString(workflow.workflowId, "workflow.workflowId", 128);
  if (!/^[a-z][a-z0-9._-]*$/u.test(workflowId)) {
    throw new ApiWorkflowError("INVALID_WORKFLOW", "workflow.workflowId must be a stable lowercase identifier");
  }
  const version = requireString(workflow.version, "workflow.version", 32);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new ApiWorkflowError("INVALID_WORKFLOW", "workflow.version must use MAJOR.MINOR.PATCH");
  }
  if (workflow.title !== undefined) requireString(workflow.title, "workflow.title", 200);
  if (workflow.stopOnFailure !== undefined && typeof workflow.stopOnFailure !== "boolean") {
    throw new ApiWorkflowError("INVALID_WORKFLOW", "workflow.stopOnFailure must be boolean");
  }
  if (!Array.isArray(workflow.steps) || workflow.steps.length < 1 || workflow.steps.length > MAX_STEPS) {
    throw new ApiWorkflowError("INVALID_WORKFLOW", "workflow.steps must contain between 1 and " + MAX_STEPS + " steps");
  }

  const previousSteps = new Set();
  const previousVariables = new Set();
  const allVariables = new Set();

  for (let index = 0; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index];
    const label = "workflow.steps[" + index + "]";
    knownKeys(step, new Set(["id", "request", "capture", "assertions", "when"]), label);
    const id = requireString(step.id, label + ".id", 64);
    if (!/^[a-z][a-z0-9_-]*$/u.test(id) || previousSteps.has(id)) {
      throw new ApiWorkflowError("INVALID_STEP_ID", label + ".id must be unique and use lowercase letters, digits, underscores or hyphens");
    }
    if (step.when !== undefined) validateCondition(step.when, label + ".when", previousSteps);
    knownKeys(step.request, REQUEST_KEYS, label + ".request");

    const method = requireString(step.request.method, label + ".request.method", 16);
    if (!HTTP_METHODS.has(method)) throw new ApiWorkflowError("INVALID_METHOD", label + ".request.method must be an uppercase supported HTTP method");
    if (!Object.hasOwn(step.request, "url")) throw new ApiWorkflowError("INVALID_REQUEST", label + ".request.url is required");

    for (const key of ["headers", "json", "body", "url"]) {
      if (step.request[key] !== undefined) validateReference(step.request[key], label + ".request." + key, previousSteps, previousVariables);
    }
    if (Object.hasOwn(step.request, "json") && Object.hasOwn(step.request, "body")) {
      throw new ApiWorkflowError("INVALID_REQUEST", label + ".request cannot define both json and body");
    }
    if ((method === "GET" || method === "HEAD") &&
        (Object.hasOwn(step.request, "json") || Object.hasOwn(step.request, "body"))) {
      throw new ApiWorkflowError("INVALID_REQUEST", label + " GET and HEAD requests cannot contain a body");
    }
    for (const key of ["timeoutMs", "maxResponseBytes"]) {
      if (step.request[key] !== undefined &&
          (!Number.isSafeInteger(step.request[key]) || step.request[key] < 1)) {
        throw new ApiWorkflowError("INVALID_REQUEST", label + ".request." + key + " must be a positive safe integer");
      }
    }

    if (step.assertions !== undefined) {
      if (!Array.isArray(step.assertions) || step.assertions.length > MAX_ASSERTIONS_PER_STEP) {
        throw new ApiWorkflowError("INVALID_ASSERTIONS", label + ".assertions must contain at most " + MAX_ASSERTIONS_PER_STEP + " entries");
      }
    }

    if (step.capture !== undefined) {
      assertPlainRecord(step.capture, label + ".capture");
      const captures = Object.entries(step.capture);
      if (captures.length > MAX_CAPTURES) throw new ApiWorkflowError("CAPTURE_LIMIT", label + ".capture exceeds the capture count limit");
      for (const [name, path] of captures) {
        if (!/^[a-z][a-zA-Z0-9_-]{0,63}$/u.test(name) || allVariables.has(name)) {
          throw new ApiWorkflowError("DUPLICATE_VARIABLE", label + ".capture variable names must be unique stable identifiers");
        }
        validateJsonPath(path, label + ".capture." + name);
        allVariables.add(name);
        previousVariables.add(name);
      }
    }
    previousSteps.add(id);
  }
  return Object.freeze({
    workflowId,
    version,
    title: workflow.title ?? workflowId,
    stopOnFailure: workflow.stopOnFailure !== false,
    stepCount: workflow.steps.length
  });
}

function resolveBindings(value, responses, variables, label, depth = 0) {
  if (depth > 24) throw new ApiWorkflowError("BINDING_DEPTH", label + " exceeds maximum binding depth");
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveBindings(item, responses, variables, label + "[" + index + "]", depth + 1));
  }
  if (!isRecord(value)) return value;
  if (Object.hasOwn(value, "$ref")) {
    const response = responses.get(value.$ref);
    if (!response) throw new ApiWorkflowError("REFERENCE_UNAVAILABLE", label + " references a response that is unavailable");
    const resolved = resolvePath(response, value.path);
    if (!resolved.exists) throw new ApiWorkflowError("REFERENCE_NOT_FOUND", label + " response path was not found");
    return structuredClone(resolved.value);
  }
  if (Object.hasOwn(value, "$var")) {
    if (!variables.has(value.$var)) throw new ApiWorkflowError("VARIABLE_UNAVAILABLE", label + " references a variable that is unavailable");
    return structuredClone(variables.get(value.$var));
  }
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(output, key, {
      value: resolveBindings(child, responses, variables, label + "." + key, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return output;
}

function evaluateCondition(condition, responses, stepStates) {
  const sourceState = stepStates.get(condition.stepId);
  const response = responses.get(condition.stepId);
  if (!sourceState || sourceState.status !== "passed" || !response) return { matched: false, reason: "dependency-not-passed" };
  if (condition.status !== undefined) {
    const status = response.status;
    const statusMatch = Array.isArray(condition.status)
      ? status >= condition.status[0] && status <= condition.status[1]
      : status === condition.status;
    if (!statusMatch) return { matched: false, reason: "condition-not-met" };
  }
  if (condition.path !== undefined) {
    const result = resolvePath(response, condition.path);
    if (condition.exists !== undefined && result.exists !== condition.exists) return { matched: false, reason: "condition-not-met" };
    if (condition.equals !== undefined && (!result.exists || !deepEqual(result.value, condition.equals))) {
      return { matched: false, reason: "condition-not-met" };
    }
  }
  return { matched: true };
}

function validateRequestResponse(response) {
  assertPlainRecord(response, "Request Engine response");
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new ApiWorkflowError("INVALID_REQUEST_RESPONSE", "Request Engine returned an invalid HTTP status");
  }
  if (!isRecord(response.headers)) throw new ApiWorkflowError("INVALID_REQUEST_RESPONSE", "Request Engine returned invalid headers");
  assertPlainRecord(response.headers, "Request Engine response.headers");
  assertSafeData(response, "Request Engine response", { maxNodes: MAX_WORKFLOW_NODES, maxDepth: MAX_WORKFLOW_DEPTH });
  return response;
}

function assertionSummary(report) {
  if (!isRecord(report) || typeof report.passed !== "boolean" || !Number.isInteger(report.total)) {
    throw new ApiWorkflowError("INVALID_ASSERTION_REPORT", "Assertions Engine returned an invalid report");
  }
  return Object.freeze({
    passed: report.passed,
    total: report.total,
    passedCount: Number.isInteger(report.passedCount) ? report.passedCount : 0,
    failedCount: Number.isInteger(report.failedCount) ? report.failedCount : report.total
  });
}

function makeStepResult(step, status, started, details = {}) {
  return Object.freeze({
    id: step.id,
    status,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    ...(details.httpStatus !== undefined ? { httpStatus: details.httpStatus } : {}),
    ...(details.bytesReceived !== undefined ? { bytesReceived: details.bytesReceived } : {}),
    ...(details.assertions ? { assertions: details.assertions } : {}),
    ...(details.captureNames ? { captureNames: Object.freeze(details.captureNames) } : {}),
    ...(details.reason ? { reason: details.reason } : {}),
    ...(details.error ? { error: Object.freeze(details.error) } : {})
  });
}

export function createApiWorkflowTestingEngine({ requestEngine, assertionsEngine = createApiAssertionsEngine() } = {}) {
  if (!requestEngine || typeof requestEngine.request !== "function") {
    throw new TypeError("requestEngine must provide a request function");
  }
  if (!assertionsEngine || typeof assertionsEngine.evaluate !== "function") {
    throw new TypeError("assertionsEngine must provide an evaluate function");
  }

  async function execute(compiled, options = {}) {
    assertPlainRecord(options, "workflow run options");
    if (Object.keys(options).some((key) => key !== "signal")) {
      throw new TypeError("workflow run options only support an AbortSignal");
    }
    const signalDescriptor = Object.getOwnPropertyDescriptor(options, "signal");
    if (signalDescriptor && !Object.hasOwn(signalDescriptor, "value")) {
      throw new TypeError("workflow run options cannot contain accessors");
    }
    const signal = signalDescriptor?.value;
    if (signal !== undefined && signal !== null &&
        (typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
         typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
      throw new TypeError("workflow run options signal must be an AbortSignal");
    }

    const workflow = compiledDefinitions.get(compiled);
    if (!workflow) throw new ApiWorkflowError("INVALID_COMPILED_WORKFLOW", "Compiled workflow definition is unavailable");
    const responses = new Map();
    const variables = new Map();
    const stepStates = new Map();
    const results = [];
    const started = performance.now();
    let stopped = false;

    try {
      for (const step of workflow.steps) {
        const stepStarted = performance.now();
        if (signal?.aborted) {
          results.push(makeStepResult(step, "skipped", stepStarted, { reason: "cancelled" }));
          stepStates.set(step.id, { status: "skipped" });
          stopped = true;
          continue;
        }

        if (step.when) {
          const condition = evaluateCondition(step.when, responses, stepStates);
          if (!condition.matched) {
            results.push(makeStepResult(step, "skipped", stepStarted, { reason: condition.reason }));
            stepStates.set(step.id, { status: "skipped" });
            continue;
          }
        }

        try {
          const request = resolveBindings(step.request, responses, variables, "step." + step.id + ".request");
          const response = validateRequestResponse(await requestEngine.request(request, { signal: signal ?? undefined }));
          responses.set(step.id, response);

          let assertionResult;
          if (step.assertions?.length) {
            assertionResult = assertionSummary(assertionsEngine.evaluate(response, step.assertions));
          }

          const captureNames = [];
          if (step.capture) {
            for (const [name, path] of Object.entries(step.capture)) {
              const resolved = resolvePath(response, path);
              if (!resolved.exists) {
                throw new ApiWorkflowError("CAPTURE_NOT_FOUND", "A declared capture path was not found for step " + step.id);
              }
              assertSafeData(resolved.value, "captured value", { maxNodes: 10000, maxDepth: 24 });
              variables.set(name, structuredClone(resolved.value));
              captureNames.push(name);
            }
          }

          const hasAssertions = Array.isArray(step.assertions) && step.assertions.length > 0;
          const defaultHttpOk = response.ok === undefined
            ? response.status >= 200 && response.status < 300
            : response.ok === true;
          const passed = hasAssertions ? assertionResult.passed : defaultHttpOk;
          const status = passed ? "passed" : "failed";
          const details = {
            httpStatus: response.status,
            bytesReceived: Number.isFinite(response.bytesReceived) ? response.bytesReceived : undefined,
            assertions: assertionResult,
            captureNames,
            ...(hasAssertions || defaultHttpOk ? {} : {
              error: {
                code: "HTTP_STATUS_NOT_OK",
                message: "Response status was not successful and the step did not declare assertions."
              }
            })
          };
          results.push(makeStepResult(step, status, stepStarted, details));
          stepStates.set(step.id, { status });

          if (!passed && compiled.stopOnFailure) {
            stopped = true;
            break;
          }
        } catch (error) {
          const code = typeof error?.code === "string" ? error.code : "STEP_EXECUTION_FAILED";
          const message = error instanceof ApiWorkflowError || error?.name === "ApiTestingError"
            ? error.message
            : "Step execution failed; inspect the error code and request-engine logs.";
          results.push(makeStepResult(step, "failed", stepStarted, {
            error: { code, message: String(message).slice(0, 300) }
          }));
          stepStates.set(step.id, { status: "failed" });
          if (compiled.stopOnFailure) {
            stopped = true;
            break;
          }
        }
      }
    } finally {
      variables.clear();
      responses.clear();
    }

    const completed = results.filter((item) => item.status === "passed").length;
    const failed = results.filter((item) => item.status === "failed").length;
    const skipped = results.filter((item) => item.status === "skipped").length;
    const cancelled = Boolean(signal?.aborted);
    const status = cancelled ? "cancelled" : failed ? "failed" : "passed";

    if (stopped && results.length < workflow.steps.length) {
      for (const step of workflow.steps.slice(results.length)) {
        results.push(makeStepResult(step, "skipped", performance.now(), {
          reason: cancelled ? "cancelled" : "stopped-after-failure"
        }));
      }
    }

    return Object.freeze({
      engineId: API_WORKFLOW_TESTING_ENGINE_ID,
      engineVersion: API_WORKFLOW_TESTING_ENGINE_VERSION,
      workflowId: compiled.workflowId,
      workflowVersion: compiled.version,
      status,
      passed: status === "passed",
      totalSteps: workflow.steps.length,
      completedSteps: completed,
      failedSteps: failed,
      skippedSteps: results.filter((item) => item.status === "skipped").length,
      passRate: workflow.steps.length ? Math.round((completed / workflow.steps.length) * 10000) / 100 : 0,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      results: Object.freeze(results.slice(0, MAX_REPORT_STEPS))
    });
  }

  function compile(workflow) {
    const metadata = validateWorkflowDefinition(workflow);
    const definition = structuredClone(workflow);
    const compiled = Object.freeze({
      workflowId: metadata.workflowId,
      version: metadata.version,
      title: metadata.title,
      stopOnFailure: metadata.stopOnFailure,
      stepCount: metadata.stepCount,
      run(options = {}) {
        return execute(compiled, options);
      }
    });
    compiledDefinitions.set(compiled, definition);
    return compiled;
  }

  async function run(workflow, options = {}) {
    return compile(workflow).run(options);
  }

  return Object.freeze({
    engineId: API_WORKFLOW_TESTING_ENGINE_ID,
    version: API_WORKFLOW_TESTING_ENGINE_VERSION,
    compile,
    run
  });
}
