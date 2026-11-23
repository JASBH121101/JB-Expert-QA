import { createHash, randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { redactSensitiveText } from "../core/redaction.js";
import { digestExecutionValue } from "../agent/execution-ledger.js";
import {
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION,
  QA_ENGINE_ORCHESTRATOR_RISK
} from "../engine-registry/orchestrator.js";

const DEFAULT_LIMITS = Object.freeze({
  maxActions: 1,
  maxExecutionMs: 120000,
  maxActionMs: 30000,
  approvalTimeoutMs: 30000,
  maxInputBytes: 16384,
  maxOutputBytes: 32768
});
const LIMIT_CAPS = Object.freeze({
  maxActions: 1,
  maxExecutionMs: 120000,
  maxActionMs: 30000,
  approvalTimeoutMs: 30000,
  maxInputBytes: 16384,
  maxOutputBytes: 32768
});
const EXECUTION_REGISTRY = new WeakMap();

export class DashboardPhase4ExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DashboardPhase4ExecutionError";
    this.code = code;
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRecord(value, label, allowedKeys) {
  if (!isPlainRecord(value)) {
    throw new DashboardPhase4ExecutionError("INVALID_RECORD", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (allowedKeys && !allowedKeys.has(key))) {
      throw new DashboardPhase4ExecutionError("UNSUPPORTED_FIELD", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new DashboardPhase4ExecutionError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function readRegistry(registry) {
  if (!isPlainRecord(registry)) {
    throw new DashboardPhase4ExecutionError("INVALID_REGISTRY", "A trusted Phase 4 engine registry is required");
  }
  for (const method of ["list", "isSealed"]) {
    const descriptor = Object.getOwnPropertyDescriptor(registry, method);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new DashboardPhase4ExecutionError("INVALID_REGISTRY", "Registry must expose trusted " + method + "() methods");
    }
  }
  if (registry.isSealed() !== true) {
    throw new DashboardPhase4ExecutionError("REGISTRY_NOT_SEALED", "Seal the Phase 4 registry before configuring execution");
  }
  const engines = registry.list();
  if (!Array.isArray(engines) || engines.length < 1 || engines.length > 256) {
    throw new DashboardPhase4ExecutionError("INVALID_REGISTRY", "Registry returned an invalid engine collection");
  }
  const byAction = new Map();
  for (const engine of engines) {
    if (!isPlainRecord(engine) || typeof engine.id !== "string") {
      throw new DashboardPhase4ExecutionError("INVALID_ENGINE_METADATA", "Registry contains invalid engine metadata");
    }
    const actionType = getQaEngineActionType(engine.id);
    if (byAction.has(actionType)) {
      throw new DashboardPhase4ExecutionError("DUPLICATE_ENGINE", "Registry contains duplicate action identifiers");
    }
    byAction.set(actionType, engine);
  }
  return byAction;
}

function readArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new DashboardPhase4ExecutionError("INVALID_ARRAY", label + " must be an array of at most " + maximum + " entries");
  }
  const values = [];
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
      throw new DashboardPhase4ExecutionError("INVALID_ARRAY", label + " contains an unsupported property");
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new DashboardPhase4ExecutionError("ACCESSOR_NOT_ALLOWED", label + " cannot contain holes or accessors");
    }
    values.push(descriptor.value);
  }
  return values;
}

function normalizeLimits(value) {
  const supplied = value === undefined ? Object.create(null) : readRecord(value, "policy.limits", new Set(Object.keys(DEFAULT_LIMITS)));
  const limits = Object.create(null);
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const number = supplied[key] ?? fallback;
    if (!Number.isSafeInteger(number) || number < 1 || number > LIMIT_CAPS[key]) {
      throw new DashboardPhase4ExecutionError(
        "INVALID_LIMIT",
        "policy.limits." + key + " must be between 1 and " + LIMIT_CAPS[key]
      );
    }
    limits[key] = number;
  }
  return Object.freeze(limits);
}

function cloneJsonValue(value, label, seen = new Set(), depth = 0) {
  if (depth > 20) {
    throw new DashboardPhase4ExecutionError("INVALID_INPUT", label + " exceeds the maximum nesting depth");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DashboardPhase4ExecutionError("INVALID_INPUT", label + " contains a non-finite number");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new DashboardPhase4ExecutionError("INVALID_INPUT", label + " must contain JSON-compatible values only");
  }
  if (seen.has(value)) {
    throw new DashboardPhase4ExecutionError("INVALID_INPUT", label + " cannot contain circular data");
  }
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    const entries = readArray(value, label, 4096);
    output = entries.map((entry, index) => cloneJsonValue(entry, label + "[" + index + "]", seen, depth + 1));
  } else {
    const record = readRecord(value, label, null);
    output = Object.create(null);
    const keys = Object.keys(record);
    if (keys.length > 1000) {
      throw new DashboardPhase4ExecutionError("INVALID_INPUT", label + " contains too many object properties");
    }
    for (const key of keys) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new DashboardPhase4ExecutionError("INVALID_INPUT", label + " contains a forbidden object key");
      }
      output[key] = cloneJsonValue(record[key], label + "." + key, seen, depth + 1);
    }
  }
  seen.delete(value);
  return output;
}

function normalizeEngineInput(value) {
  if (!isPlainRecord(value)) {
    throw new DashboardPhase4ExecutionError("INVALID_INPUT", "Engine input must be a plain JSON object");
  }
  const input = cloneJsonValue(value, "engine input");
  const size = Buffer.byteLength(JSON.stringify(input), "utf8");
  if (size > DEFAULT_LIMITS.maxInputBytes) {
    throw new DashboardPhase4ExecutionError("INPUT_TOO_LARGE", "Engine input exceeds the dashboard execution input limit");
  }
  return input;
}

function safeUrlSummary(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return Object.freeze({
      kind: "url",
      origin: url.origin,
      path: redactSensitiveText(url.pathname).slice(0, 180)
    });
  } catch {
    return null;
  }
}

function createReviewContext(engineId, input) {
  const context = {
    engineId,
    inputFields: Object.keys(input).slice(0, 24).map((key) => key.replace(/[^a-z0-9._-]/gi, "-").slice(0, 64))
  };
  if (typeof input.operation === "string") {
    context.operation = redactSensitiveText(input.operation).slice(0, 80);
  }
  if (typeof input.format === "string") {
    context.format = redactSensitiveText(input.format).slice(0, 32);
  }
  if (typeof input.url === "string") {
    context.target = safeUrlSummary(input.url);
  } else if (typeof input.path === "string" && input.path.trim()) {
    const absolutePath = resolve(input.path);
    context.target = Object.freeze({
      kind: "local-path",
      name: basename(absolutePath).slice(0, 120),
      pathDigest: createHash("sha256").update(absolutePath).digest("hex").slice(0, 16)
    });
  } else if (isPlainRecord(input.request) && typeof input.request.url === "string") {
    context.target = safeUrlSummary(input.request.url);
    if (typeof input.request.method === "string") {
      context.requestMethod = input.request.method.toUpperCase().slice(0, 12);
    }
  }
  if (Array.isArray(input.history)) context.historyRecordCount = input.history.length;
  if (Array.isArray(input.engineDefinitions)) context.engineDefinitionCount = input.engineDefinitions.length;
  return Object.freeze(context);
}

function normalizePolicy(value, engineByAction) {
  const policy = readRecord(value, "policy", new Set([
    "id", "grantedPermissions", "rules", "limits", "stopOnFailure"
  ]));
  if (typeof policy.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(policy.id)) {
    throw new DashboardPhase4ExecutionError("INVALID_POLICY_ID", "An explicit valid policy.id is required");
  }
  const grantedPermissions = readArray(policy.grantedPermissions, "policy.grantedPermissions", 100);
  if (grantedPermissions.length !== 1 ||
      grantedPermissions[0] !== QA_ENGINE_EXECUTION_PERMISSION) {
    throw new DashboardPhase4ExecutionError(
      "MISSING_EXECUTION_PERMISSION",
      "Dashboard policy must grant only the qa:engine-execute permission"
    );
  }
  if (new Set(grantedPermissions).size !== grantedPermissions.length) {
    throw new DashboardPhase4ExecutionError("INVALID_PERMISSIONS", "Policy permissions must be unique");
  }
  const suppliedRules = readArray(policy.rules, "policy.rules", engineByAction.size);
  if (suppliedRules.length < 1) {
    throw new DashboardPhase4ExecutionError(
      "INVALID_ALLOWLIST",
      "Policy must contain at least one exact engine action rule"
    );
  }

  const seen = new Set();
  const rules = [];
  for (let index = 0; index < suppliedRules.length; index += 1) {
    const rule = readRecord(suppliedRules[index], "policy.rules[" + index + "]",
      new Set(["type", "maxRisk", "scopes", "requireApproval"]));
    if (typeof rule.type !== "string" || !engineByAction.has(rule.type) || seen.has(rule.type)) {
      throw new DashboardPhase4ExecutionError(
        "INVALID_ALLOWLIST",
        "Every policy rule must name one unique, exact engine action from the sealed registry"
      );
    }
    if (rule.maxRisk !== QA_ENGINE_ORCHESTRATOR_RISK) {
      throw new DashboardPhase4ExecutionError(
        "RISK_CEILING_REQUIRED",
        "Every enabled engine rule must explicitly allow high risk; high-risk execution still requires approval"
      );
    }
    if (rule.requireApproval !== true) {
      throw new DashboardPhase4ExecutionError("APPROVAL_REQUIRED", "Every engine rule must explicitly set requireApproval: true");
    }
    if (rule.scopes !== undefined && (!Array.isArray(rule.scopes) || rule.scopes.length > 0 || Reflect.ownKeys(rule.scopes).some((key) => key !== "length"))) {
      throw new DashboardPhase4ExecutionError(
        "UNSUPPORTED_SCOPE",
        "This dashboard adapter does not support caller-defined scope resolvers; engine-specific validation remains mandatory"
      );
    }
    seen.add(rule.type);
    rules.push(Object.freeze({
      type: rule.type,
      maxRisk: QA_ENGINE_ORCHESTRATOR_RISK,
      requireApproval: true
    }));
  }

  if (policy.stopOnFailure !== undefined && typeof policy.stopOnFailure !== "boolean") {
    throw new DashboardPhase4ExecutionError("INVALID_POLICY", "policy.stopOnFailure must be a boolean");
  }

  return Object.freeze({
    id: policy.id,
    grantedPermissions: Object.freeze(grantedPermissions),
    rules: Object.freeze(rules),
    limits: normalizeLimits(policy.limits),
    stopOnFailure: policy.stopOnFailure !== false
  });
}

/**
 * Creates a Dashboard execution bridge only when the host explicitly supplies:
 * a sealed registry, an exact allowlist policy, qa:engine-execute permission,
 * and a real approval provider. No approval is synthesized by this module.
 */
export function createDashboardPhase4Execution(options = {}) {
  const config = readRecord(options, "options", new Set([
    "registry", "policy", "requestApproval", "ledger", "clock", "idFactory"
  ]));
  const { registry, policy, requestApproval, ledger, clock, idFactory } = config;
  const engineByAction = readRegistry(registry);
  if (typeof requestApproval !== "function") {
    throw new DashboardPhase4ExecutionError(
      "APPROVAL_PROVIDER_REQUIRED",
      "A real host approval provider is required; automatic approval is not supported"
    );
  }
  const normalizedPolicy = normalizePolicy(policy, engineByAction);
  const reviewContextByDigest = new Map();
  let executionActive = false;
  const approvalProvider = async (request) => {
    const reviewContext = reviewContextByDigest.get(request.inputDigest) ?? null;
    return requestApproval(Object.freeze({ ...request, reviewContext }));
  };
  const orchestratorOptions = {
    registry,
    policy: normalizedPolicy,
    requestApproval: approvalProvider,
    ...(ledger === undefined ? {} : { ledger }),
    ...(clock === undefined ? {} : { clock }),
    ...(idFactory === undefined ? {} : { idFactory })
  };
  const orchestrator = createQaEngineOrchestrator(orchestratorOptions);
  const allowedActions = new Set(orchestrator.getPolicy().allowedActions);
  const allowedEngines = Object.freeze(
    orchestrator.listEngines()
      .filter((engine) => allowedActions.has(getQaEngineActionType(engine.id)))
      .map((engine) => Object.freeze({ ...engine }))
  );
  const allowedIds = new Set(allowedEngines.map((engine) => engine.id));

  const execution = Object.freeze({
    enabled: true,
    listAllowedEngines() {
      return allowedEngines;
    },
    getStatus() {
      const currentPolicy = orchestrator.getPolicy();
      return Object.freeze({
        enabled: true,
        policyId: currentPolicy.id,
        approvalRequired: true,
        permission: QA_ENGINE_EXECUTION_PERMISSION,
        allowedEngineIds: Object.freeze([...allowedIds]),
        limits: currentPolicy.limits
      });
    },
    async executeEngine(engineId, input) {
      if (executionActive) {
        throw new DashboardPhase4ExecutionError("EXECUTION_IN_PROGRESS", "Another Dashboard Phase 4 execution is already in progress");
      }
      if (typeof engineId !== "string" || !allowedIds.has(engineId)) {
        throw new DashboardPhase4ExecutionError("ENGINE_NOT_ALLOWLISTED", "Requested engine is not explicitly enabled by host policy");
      }
      const safeInput = normalizeEngineInput(input);
      const actionType = getQaEngineActionType(engineId);
      const inputDigest = digestExecutionValue(safeInput);
      reviewContextByDigest.set(inputDigest, createReviewContext(engineId, safeInput));
      executionActive = true;
      try {
        return await orchestrator.execute({
          id: "dashboard-" + randomUUID(),
          actions: [{
            id: "engine-" + randomUUID(),
            type: actionType,
            input: safeInput
          }]
        });
      } finally {
        reviewContextByDigest.delete(inputDigest);
        executionActive = false;
      }
    },
    verifyLedger: orchestrator.verifyLedger
  });

  EXECUTION_REGISTRY.set(execution, registry);
  return execution;
}

/** Internal binding check used by the local Dashboard to reject mismatched registries. */
export function isDashboardPhase4ExecutionBoundTo(execution, registry) {
  return Boolean(execution && EXECUTION_REGISTRY.get(execution) === registry);
}
