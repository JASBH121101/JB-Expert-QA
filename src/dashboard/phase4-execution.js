import { randomUUID } from "node:crypto";
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

function normalizePolicy(value, engineByAction) {
  const policy = readRecord(value, "policy", new Set([
    "id", "grantedPermissions", "rules", "limits", "stopOnFailure"
  ]));
  if (typeof policy.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(policy.id)) {
    throw new DashboardPhase4ExecutionError("INVALID_POLICY_ID", "An explicit valid policy.id is required");
  }
  if (!Array.isArray(policy.grantedPermissions) ||
      !policy.grantedPermissions.includes(QA_ENGINE_EXECUTION_PERMISSION) ||
      policy.grantedPermissions.some((permission) => typeof permission !== "string")) {
    throw new DashboardPhase4ExecutionError(
      "MISSING_EXECUTION_PERMISSION",
      "Policy must explicitly preauthorize qa:engine-execute"
    );
  }
  if (new Set(policy.grantedPermissions).size !== policy.grantedPermissions.length) {
    throw new DashboardPhase4ExecutionError("INVALID_PERMISSIONS", "Policy permissions must be unique");
  }
  if (!Array.isArray(policy.rules) || policy.rules.length < 1 || policy.rules.length > engineByAction.size) {
    throw new DashboardPhase4ExecutionError(
      "INVALID_ALLOWLIST",
      "Policy must contain at least one exact engine action rule and cannot exceed the registry size"
    );
  }

  const seen = new Set();
  const rules = [];
  for (let index = 0; index < policy.rules.length; index += 1) {
    const rule = readRecord(policy.rules[index], "policy.rules[" + index + "]",
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
    if (rule.requireApproval === false) {
      throw new DashboardPhase4ExecutionError("APPROVAL_REQUIRED", "Engine approval cannot be disabled");
    }
    if (rule.scopes !== undefined && (!Array.isArray(rule.scopes) || rule.scopes.length > 0)) {
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
    grantedPermissions: Object.freeze([...policy.grantedPermissions]),
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
export function createDashboardPhase4Execution({
  registry,
  policy,
  requestApproval,
  ledger,
  clock,
  idFactory
} = {}) {
  const engineByAction = readRegistry(registry);
  if (typeof requestApproval !== "function") {
    throw new DashboardPhase4ExecutionError(
      "APPROVAL_PROVIDER_REQUIRED",
      "A real host approval provider is required; automatic approval is not supported"
    );
  }
  const normalizedPolicy = normalizePolicy(policy, engineByAction);
  const orchestratorOptions = {
    registry,
    policy: normalizedPolicy,
    requestApproval,
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
      if (typeof engineId !== "string" || !allowedIds.has(engineId)) {
        throw new DashboardPhase4ExecutionError("ENGINE_NOT_ALLOWLISTED", "Requested engine is not explicitly enabled by host policy");
      }
      if (!isPlainRecord(input)) {
        throw new DashboardPhase4ExecutionError("INVALID_INPUT", "Engine input must be a plain JSON object");
      }
      const actionType = getQaEngineActionType(engineId);
      return orchestrator.execute({
        id: "dashboard-" + randomUUID(),
        actions: [{
          id: "engine-" + randomUUID(),
          type: actionType,
          input
        }]
      });
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
