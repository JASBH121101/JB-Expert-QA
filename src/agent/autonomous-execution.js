import { randomUUID } from "node:crypto";
import { redactSensitiveText } from "../core/redaction.js";
import { createInMemoryExecutionLedger, digestExecutionValue } from "./execution-ledger.js";

const RISK_LEVELS = Object.freeze(["low", "medium", "high"]);
const RISK_SCORE = Object.freeze({ low: 1, medium: 2, high: 3 });
const ACTION_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const PERMISSION_PATTERN = /^[a-z][a-z0-9]*(?::[a-z][a-z0-9_-]*)?$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const DEFAULT_LIMITS = Object.freeze({
  maxActions: 10,
  maxExecutionMs: 120000,
  maxActionMs: 30000,
  approvalTimeoutMs: 30000,
  maxInputBytes: 32768,
  maxOutputBytes: 32768
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function jsonSafeClone(value, label, maxBytes, { objectOnly = false } = {}) {
  if (objectOnly && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new TypeError(label + " must be a plain JSON object");
  }
  const seen = new Set();
  function visit(current, depth) {
    if (depth > 20) throw new RangeError(label + " is too deeply nested");
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError(label + " contains a non-finite number");
      return;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) throw new TypeError(label + " cannot contain circular data");
      seen.add(current);
      for (const item of current) visit(item, depth + 1);
      seen.delete(current);
      return;
    }
    if (typeof current !== "object" ||
        (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null)) {
      throw new TypeError(label + " must contain JSON-compatible data only");
    }
    if (seen.has(current)) throw new TypeError(label + " cannot contain circular data");
    seen.add(current);
    for (const key of Object.keys(current)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new TypeError(label + " contains a forbidden object key");
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError(label + " cannot contain accessors");
      }
      visit(descriptor.value, depth + 1);
    }
    seen.delete(current);
  }
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new RangeError(label + " exceeds the " + maxBytes + " byte limit");
  }
  return deepFreeze(JSON.parse(serialized));
}

function validPermission(value) {
  return typeof value === "string" && PERMISSION_PATTERN.test(value);
}

function normalizeScope(value) {
  if (typeof value !== "string") return null;
  const scope = value.replace(/\\/g, "/").trim();
  if (!scope || scope.includes("\0") || scope.startsWith("/") || /^[a-z]:/i.test(scope)) return null;
  const parts = scope.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function normalizeScopePattern(value) {
  if (typeof value !== "string") return null;
  if (value.endsWith("/**")) {
    const prefix = normalizeScope(value.slice(0, -3));
    return prefix ? prefix + "/**" : null;
  }
  return normalizeScope(value);
}

function scopeMatches(scope, patterns) {
  if (!patterns.length) return false;
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return scope === prefix || scope.startsWith(prefix + "/");
    }
    return scope === pattern;
  });
}

function createRegistry(actions) {
  if (!Array.isArray(actions) || actions.length > 100) {
    throw new TypeError("actions must be an array containing at most 100 registered handlers");
  }
  const registry = new Map();
  for (const action of actions) {
    if (!action || typeof action !== "object" || Array.isArray(action) ||
        typeof action.type !== "string" || !ACTION_TYPE_PATTERN.test(action.type) ||
        typeof action.execute !== "function") {
      throw new TypeError("Each registered action needs a valid type and execute handler");
    }
    if (registry.has(action.type)) throw new Error("Duplicate action handler: " + action.type);
    const risk = action.risk ?? "low";
    if (!RISK_LEVELS.includes(risk)) throw new TypeError("Action risk must be low, medium or high: " + action.type);
    const permissions = action.permissions ?? [];
    if (!Array.isArray(permissions) || permissions.some((permission) => !validPermission(permission))) {
      throw new TypeError("Action permissions are invalid: " + action.type);
    }
    if (new Set(permissions).size !== permissions.length) {
      throw new TypeError("Action permissions must be unique: " + action.type);
    }
    for (const field of ["validateInput", "validateOutput", "getScope"]) {
      if (action[field] !== undefined && typeof action[field] !== "function") {
        throw new TypeError("Action " + field + " must be a function when supplied");
      }
    }
    const timeoutMs = action.timeoutMs ?? DEFAULT_LIMITS.maxActionMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
      throw new TypeError("Action timeoutMs must be between 1 and 600000: " + action.type);
    }
    registry.set(action.type, Object.freeze({
      type: action.type,
      risk,
      permissions: Object.freeze([...permissions]),
      timeoutMs,
      validateInput: action.validateInput ?? (() => true),
      validateOutput: action.validateOutput ?? (() => true),
      getScope: action.getScope ?? null,
      execute: action.execute
    }));
  }
  return registry;
}

function normalizeLimits(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("policy.limits must be an object");
  }
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const number = value[key] ?? fallback;
    if (!Number.isSafeInteger(number) || number < 1 || number > 600000) {
      throw new TypeError("policy.limits." + key + " must be between 1 and 600000");
    }
    limits[key] = number;
  }
  if (limits.maxActions > 50) throw new RangeError("policy.limits.maxActions cannot exceed 50");
  return Object.freeze(limits);
}

function createPolicy(value = {}, registry) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("policy must be an object");
  }
  const id = value.id ?? "jbqa-deny-by-default";
  if (typeof id !== "string" || !IDENTIFIER_PATTERN.test(id)) {
    throw new TypeError("policy.id is invalid");
  }
  const grantedPermissions = value.grantedPermissions ?? [];
  if (!Array.isArray(grantedPermissions) || grantedPermissions.some((permission) => !validPermission(permission))) {
    throw new TypeError("policy.grantedPermissions must contain valid permission names");
  }
  if (new Set(grantedPermissions).size !== grantedPermissions.length) {
    throw new TypeError("policy.grantedPermissions must be unique");
  }
  const suppliedRules = value.rules ?? [];
  if (!Array.isArray(suppliedRules) || suppliedRules.length > 100) {
    throw new TypeError("policy.rules must be an array containing at most 100 rules");
  }
  const rules = new Map();
  for (const rawRule of suppliedRules) {
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule) ||
        typeof rawRule.type !== "string" || !registry.has(rawRule.type)) {
      throw new TypeError("Every policy rule must reference a registered action type");
    }
    if (rules.has(rawRule.type)) throw new Error("Duplicate policy rule: " + rawRule.type);
    const maxRisk = rawRule.maxRisk ?? "low";
    if (!RISK_LEVELS.includes(maxRisk)) throw new TypeError("Policy maxRisk must be low, medium or high");
    const scopes = rawRule.scopes ?? [];
    if (!Array.isArray(scopes)) throw new TypeError("Policy scopes must be an array");
    const normalizedScopes = scopes.map(normalizeScopePattern);
    if (normalizedScopes.some((scope) => !scope)) throw new TypeError("Policy contains an invalid scope pattern");
    const action = registry.get(rawRule.type);
    if (action.getScope && !normalizedScopes.length) {
      throw new TypeError("Scoped action policy requires at least one explicit scope: " + rawRule.type);
    }
    if (!action.getScope && normalizedScopes.length) {
      throw new TypeError("Policy scopes require a registered getScope validator: " + rawRule.type);
    }
    if (rawRule.requireApproval !== undefined && typeof rawRule.requireApproval !== "boolean") {
      throw new TypeError("Policy requireApproval must be a boolean");
    }
    rules.set(rawRule.type, Object.freeze({
      type: rawRule.type,
      maxRisk,
      scopes: Object.freeze(normalizedScopes),
      requireApproval: rawRule.requireApproval ?? false
    }));
  }
  if (value.stopOnFailure !== undefined && typeof value.stopOnFailure !== "boolean") {
    throw new TypeError("policy.stopOnFailure must be a boolean");
  }
  return Object.freeze({
    id,
    grantedPermissions: Object.freeze([...grantedPermissions]),
    rules,
    limits: normalizeLimits(value.limits),
    stopOnFailure: value.stopOnFailure !== false
  });
}

function makeClock(clock) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  return () => {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("clock must return a valid date");
    return date;
  };
}

function validSignal(signal) {
  return signal === undefined || (signal && typeof signal.aborted === "boolean" &&
    typeof signal.addEventListener === "function" && typeof signal.removeEventListener === "function");
}

function boundedCall(invoke, { timeoutMs, signal }) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      controller.abort();
      finish({ kind: "cancelled" });
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      finish({ kind: "timeout" });
    }, timeoutMs);
    Promise.resolve().then(() => invoke(controller.signal)).then(
      (value) => finish({ kind: "success", value }),
      (error) => finish({ kind: "failure", error })
    );
  });
}

function safeReason(error, fallback) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error ?? fallback)).slice(0, 400);
}

function normalizePlan(plan, maxInputBytes) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || !Array.isArray(plan.actions)) {
    throw new TypeError("Execution plan must be an object with an actions array");
  }
  const allowedPlanKeys = new Set(["id", "actions"]);
  if (Object.keys(plan).some((key) => !allowedPlanKeys.has(key))) {
    throw new TypeError("Execution plan contains unsupported top-level fields");
  }
  if (plan.actions.length < 1) throw new TypeError("Execution plan must contain at least one action");
  const planId = plan.id ?? null;
  if (planId !== null && (typeof planId !== "string" || !IDENTIFIER_PATTERN.test(planId))) {
    throw new TypeError("Execution plan id is invalid");
  }
  const ids = new Set();
  const actions = plan.actions.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("Execution action " + index + " must be an object");
    }
    const allowedKeys = new Set(["id", "type", "input"]);
    if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
      throw new TypeError("Execution action contains unsupported or caller-controlled policy fields");
    }
    if (typeof raw.id !== "string" || !IDENTIFIER_PATTERN.test(raw.id)) {
      throw new TypeError("Every execution action requires a valid id");
    }
    if (ids.has(raw.id)) throw new Error("Execution action ids must be unique within a plan");
    ids.add(raw.id);
    if (typeof raw.type !== "string" || !ACTION_TYPE_PATTERN.test(raw.type)) {
      throw new TypeError("Execution action type is invalid");
    }
    const input = jsonSafeClone(raw.input ?? {}, "Execution action input", maxInputBytes, { objectOnly: true });
    return Object.freeze({
      id: raw.id,
      type: raw.type,
      input,
      inputDigest: digestExecutionValue(input)
    });
  });
  return Object.freeze({ id: planId, actions: Object.freeze(actions) });
}

function actionRiskAllowed(action, rule) {
  return RISK_SCORE[action.risk] <= RISK_SCORE[rule.maxRisk];
}

function summarizeApproval({ executionId, action, scope }) {
  return Object.freeze({
    executionId,
    actionId: action.id,
    actionType: action.type,
    risk: action.risk,
    permissions: action.permissions,
    scope,
    inputDigest: action.inputDigest
  });
}

export function createAutonomousExecutionEngine({
  actions = [],
  policy = {},
  ledger = createInMemoryExecutionLedger(),
  requestApproval = null,
  clock = () => new Date(),
  idFactory = randomUUID
} = {}) {
  const registry = createRegistry(actions);
  const normalizedPolicy = createPolicy(policy, registry);
  const now = makeClock(clock);
  if (!ledger || typeof ledger.append !== "function" || typeof ledger.verify !== "function" ||
      typeof ledger.snapshot !== "function") {
    throw new TypeError("A compatible execution ledger is required");
  }
  if (requestApproval !== null && typeof requestApproval !== "function") {
    throw new TypeError("requestApproval must be a function when supplied");
  }
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  const usedExecutionIds = new Set();

  async function record(event, details = {}) {
    return ledger.append({
      event,
      timestamp: now().toISOString(),
      policyId: normalizedPolicy.id,
      ...details
    });
  }

  async function execute(planInput, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Execution options must be an object");
    }
    if (!validSignal(options.signal)) throw new TypeError("signal must be an AbortSignal");
    const plan = normalizePlan(planInput, normalizedPolicy.limits.maxInputBytes);
    const executionId = options.executionId ?? idFactory();
    if (typeof executionId !== "string" || !IDENTIFIER_PATTERN.test(executionId)) {
      throw new TypeError("executionId is invalid");
    }
    if (usedExecutionIds.has(executionId) ||
        ledger.snapshot().some((entry) => entry.event === "execution.started" && entry.executionId === executionId)) {
      throw new Error("Execution id has already been used");
    }
    if (plan.actions.length > normalizedPolicy.limits.maxActions) {
      throw new RangeError("Execution plan exceeds the policy maxActions limit");
    }
    const verification = await ledger.verify();
    if (!verification || verification.valid !== true) {
      throw new Error("Execution blocked because the audit ledger failed integrity verification");
    }
    usedExecutionIds.add(executionId);

    const startedMs = Date.now();
    const startedAt = now().toISOString();
    const deadline = startedMs + normalizedPolicy.limits.maxExecutionMs;
    const results = [];
    await record("execution.started", {
      executionId,
      planId: plan.id,
      plannedActions: plan.actions.length
    });

    let stopReason = null;
    for (const planned of plan.actions) {
      if (options.signal?.aborted) {
        const result = { id: planned.id, type: planned.type, status: "cancelled", reason: "Execution was cancelled before the action started" };
        results.push(Object.freeze(result));
        await record("action.cancelled", { executionId, actionId: planned.id, actionType: planned.type, reason: result.reason });
        stopReason = "cancelled";
        break;
      }

      const action = registry.get(planned.type);
      const rule = normalizedPolicy.rules.get(planned.type);
      const blocked = (reason) => Object.freeze({
        id: planned.id,
        type: planned.type,
        status: "blocked",
        reason
      });

      if (!action || !rule) {
        const result = blocked("Action type is not registered and explicitly allowlisted by policy");
        results.push(result);
        await record("action.blocked", {
          executionId,
          actionId: planned.id,
          actionType: planned.type,
          inputDigest: planned.inputDigest,
          reason: result.reason
        });
        stopReason = "blocked";
        if (normalizedPolicy.stopOnFailure) break;
        continue;
      }
      if (!actionRiskAllowed(action, rule)) {
        const result = blocked("Action risk exceeds the policy maximum");
        results.push(result);
        await record("action.blocked", {
          executionId, actionId: planned.id, actionType: planned.type,
          risk: action.risk, inputDigest: planned.inputDigest, reason: result.reason
        });
        stopReason = "blocked";
        if (normalizedPolicy.stopOnFailure) break;
        continue;
      }
      const missingPermissions = action.permissions.filter((permission) =>
        !normalizedPolicy.grantedPermissions.includes(permission));
      if (missingPermissions.length) {
        const result = blocked("Required permissions were not preauthorized: " + missingPermissions.join(", "));
        results.push(result);
        await record("action.blocked", {
          executionId, actionId: planned.id, actionType: planned.type,
          risk: action.risk, inputDigest: planned.inputDigest,
          reason: result.reason
        });
        stopReason = "blocked";
        if (normalizedPolicy.stopOnFailure) break;
        continue;
      }

      let scope = null;
      let scopeDigest = null;
      if (action.getScope) {
        try {
          scope = normalizeScope(await action.getScope(planned.input));
        } catch (error) {
          scope = null;
        }
        scopeDigest = scope ? digestExecutionValue(scope) : null;
        if (!scope || !scopeMatches(scope, rule.scopes)) {
          const result = blocked("Action resource is outside the policy scope");
          results.push(result);
          await record("action.blocked", {
            executionId, actionId: planned.id, actionType: planned.type,
            risk: action.risk, inputDigest: planned.inputDigest, scopeDigest,
            reason: result.reason
          });
          stopReason = "blocked";
          if (normalizedPolicy.stopOnFailure) break;
          continue;
        }
      }
      try {
        const validInput = await action.validateInput(planned.input);
        if (validInput !== true) throw new Error("Action input validation did not explicitly pass");
      } catch (error) {
        const result = blocked("Action input validation failed: " + safeReason(error, "invalid input"));
        results.push(result);
        await record("action.blocked", {
          executionId, actionId: planned.id, actionType: planned.type,
          risk: action.risk, inputDigest: planned.inputDigest, scopeDigest,
          reason: result.reason
        });
        stopReason = "blocked";
        if (normalizedPolicy.stopOnFailure) break;
        continue;
      }

      const needsApproval = action.risk !== "low" || rule.requireApproval;
      let approvalId = null;
      if (needsApproval) {
        await record("action.approval-requested", {
          executionId, actionId: planned.id, actionType: planned.type,
          risk: action.risk, inputDigest: planned.inputDigest, scopeDigest
        });
        if (!requestApproval) {
          const result = blocked("This action requires explicit approval, but no approval provider is configured");
          results.push(result);
          await record("action.blocked", {
            executionId, actionId: planned.id, actionType: planned.type,
            risk: action.risk, inputDigest: planned.inputDigest, scopeDigest,
            reason: result.reason
          });
          stopReason = "blocked";
          if (normalizedPolicy.stopOnFailure) break;
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const result = blocked("Execution time budget expired before approval");
          results.push(result);
          await record("action.timed-out", {
            executionId, actionId: planned.id, actionType: planned.type,
            risk: action.risk, inputDigest: planned.inputDigest, scopeDigest,
            reason: result.reason
          });
          stopReason = "timed-out";
          break;
        }
        const approvalResult = await boundedCall(
          (signal) => requestApproval({ ...summarizeApproval({ executionId, action: { ...planned, ...action }, scope }), signal }),
          { timeoutMs: Math.min(normalizedPolicy.limits.approvalTimeoutMs, remaining), signal: options.signal }
        );
        if (approvalResult.kind === "cancelled") {
          const result = { id: planned.id, type: planned.type, status: "cancelled", reason: "Approval request was cancelled" };
          results.push(Object.freeze(result));
          await record("action.cancelled", { executionId, actionId: planned.id, actionType: planned.type, reason: result.reason });
          stopReason = "cancelled";
          break;
        }
        if (approvalResult.kind === "timeout") {
          const result = blocked("Approval request timed out");
          results.push(result);
          await record("action.timed-out", {
            executionId, actionId: planned.id, actionType: planned.type,
            risk: action.risk, inputDigest: planned.inputDigest, scopeDigest, reason: result.reason
          });
          stopReason = "timed-out";
          break;
        }
        if (approvalResult.kind !== "success" ||
            !approvalResult.value || approvalResult.value.approved !== true ||
            typeof approvalResult.value.approvalId !== "string" ||
            !IDENTIFIER_PATTERN.test(approvalResult.value.approvalId)) {
          const reason = approvalResult.kind === "failure"
            ? "Approval provider failed: " + safeReason(approvalResult.error, "approval unavailable")
            : "Explicit approval was not granted";
          const result = blocked(reason);
          results.push(result);
          await record("action.blocked", {
            executionId, actionId: planned.id, actionType: planned.type,
            risk: action.risk, inputDigest: planned.inputDigest, scopeDigest, reason
          });
          stopReason = "blocked";
          if (normalizedPolicy.stopOnFailure) break;
          continue;
        }
        approvalId = approvalResult.value.approvalId;
        await record("action.approved", {
          executionId, actionId: planned.id, actionType: planned.type,
          risk: action.risk, approvalId, inputDigest: planned.inputDigest, scopeDigest
        });
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const result = blocked("Execution time budget expired before the action started");
        results.push(result);
        await record("action.timed-out", {
          executionId, actionId: planned.id, actionType: planned.type,
          risk: action.risk, approvalId, inputDigest: planned.inputDigest, scopeDigest,
          reason: result.reason
        });
        stopReason = "timed-out";
        break;
      }

      const actionStarted = Date.now();
      await record("action.started", {
        executionId, actionId: planned.id, actionType: planned.type,
        risk: action.risk, approvalId, inputDigest: planned.inputDigest, scopeDigest
      });
      const runResult = await boundedCall(
        (signal) => action.execute({
          executionId,
          actionId: planned.id,
          input: planned.input,
          permissions: action.permissions,
          policyId: normalizedPolicy.id,
          scope,
          approvalId,
          signal
        }),
        {
          timeoutMs: Math.min(action.timeoutMs, normalizedPolicy.limits.maxActionMs, remaining),
          signal: options.signal
        }
      );
      const durationMs = Date.now() - actionStarted;
      if (runResult.kind === "cancelled") {
        const result = { id: planned.id, type: planned.type, status: "cancelled", durationMs, reason: "Action was cancelled" };
        results.push(Object.freeze(result));
        await record("action.cancelled", {
          executionId, actionId: planned.id, actionType: planned.type,
          risk: action.risk, approvalId, inputDigest: planned.inputDigest, scopeDigest, durationMs,
          reason: result.reason
        });
        stopReason = "cancelled";
        break;
      }
      if (runResult.kind === "timeout") {
        const result = { id: planned.id, type: planned.type, status: "timed-out", durationMs, reason: "Action exceeded its execution deadline" };
        results.push(Object.freeze(result));
        await record("action.timed-out", {
          executionId, actionId: planned.id, actionType: planned.type,
          risk: action.risk, approvalId, inputDigest: planned.inputDigest, scopeDigest, durationMs,
          reason: result.reason
        });
        stopReason = "timed-out";
        break;
      }
      if (runResult.kind === "failure") {
        const reason = "Action handler failed: " + safeReason(runResult.error, "execution failed");
        const result = { id: planned.id, type: planned.type, status: "failed", durationMs, reason };
        results.push(Object.freeze(result));
        await record("action.failed", {
          executionId, actionId: planned.id, actionType: planned.type,
          risk: action.risk, approvalId, inputDigest: planned.inputDigest, scopeDigest, durationMs, reason
        });
        stopReason = "failed";
        if (normalizedPolicy.stopOnFailure) break;
        continue;
      }

      let output;
      let outputDigest;
      try {
        output = jsonSafeClone(runResult.value, "Action output", normalizedPolicy.limits.maxOutputBytes);
        const validOutput = await action.validateOutput(output);
        if (validOutput !== true) throw new Error("Action output validation did not explicitly pass");
        outputDigest = digestExecutionValue(output);
      } catch (error) {
        const reason = "Action output validation failed: " + safeReason(error, "invalid output");
        const result = { id: planned.id, type: planned.type, status: "failed", durationMs, reason };
        results.push(Object.freeze(result));
        await record("action.failed", {
          executionId, actionId: planned.id, actionType: planned.type,
          risk: action.risk, approvalId, inputDigest: planned.inputDigest, scopeDigest, durationMs, reason
        });
        stopReason = "failed";
        if (normalizedPolicy.stopOnFailure) break;
        continue;
      }

      const result = Object.freeze({
        id: planned.id,
        type: planned.type,
        status: "succeeded",
        durationMs,
        output
      });
      results.push(result);
      await record("action.succeeded", {
        executionId, actionId: planned.id, actionType: planned.type,
        risk: action.risk, approvalId, inputDigest: planned.inputDigest,
        outputDigest, scopeDigest, durationMs
      });
    }

    const succeeded = results.filter((item) => item.status === "succeeded").length;
    const blocked = results.some((item) => item.status === "blocked");
    const failed = results.some((item) => item.status === "failed");
    const timedOut = results.some((item) => item.status === "timed-out");
    const cancelled = results.some((item) => item.status === "cancelled");
    const status = succeeded === plan.actions.length ? "succeeded" :
      succeeded > 0 ? "partial" :
        cancelled ? "cancelled" :
          timedOut ? "timed-out" :
            blocked ? "blocked" :
              failed ? "failed" : "blocked";
    const completedAt = now().toISOString();
    const durationMs = Date.now() - startedMs;
    await record("execution.completed", {
      executionId,
      planId: plan.id,
      status,
      succeededActions: succeeded,
      totalActions: plan.actions.length,
      durationMs,
      stopReason
    });
    const ledgerVerification = await ledger.verify();
    if (!ledgerVerification || ledgerVerification.valid !== true) {
      throw new Error("Execution completed but audit ledger integrity verification failed");
    }
    return deepFreeze({
      status,
      executionId,
      planId: plan.id,
      policyId: normalizedPolicy.id,
      startedAt,
      completedAt,
      durationMs,
      summary: {
        total: plan.actions.length,
        succeeded,
        blocked: results.filter((item) => item.status === "blocked").length,
        failed: results.filter((item) => item.status === "failed").length,
        timedOut: results.filter((item) => item.status === "timed-out").length,
        cancelled: results.filter((item) => item.status === "cancelled").length
      },
      actions: results,
      ledger: {
        entries: ledgerVerification.entries,
        lastHash: ledgerVerification.lastHash
      }
    });
  }

  return Object.freeze({
    execute,
    verifyLedger: () => ledger.verify(),
    getLedger: () => ledger.snapshot(),
    getPolicy: () => Object.freeze({
      id: normalizedPolicy.id,
      grantedPermissions: normalizedPolicy.grantedPermissions,
      allowedActions: Object.freeze([...normalizedPolicy.rules.keys()]),
      limits: normalizedPolicy.limits
    })
  });
}
