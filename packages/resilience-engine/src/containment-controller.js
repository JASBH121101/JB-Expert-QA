import { createHash } from "node:crypto";
import { getA2ProviderReadinessMetadata } from "./provider-evidence.js";

const SCOPE_KEYS = Object.freeze([
  "assetId", "environment", "incidentId", "policyId", "policyRevision", "policyHash"
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value) ||
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null ||
      Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(label + " must be a plain data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new TypeError(label + " has missing or unsupported fields");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " must not contain accessors or hidden fields");
    }
  }
}

function normalizeScope(input) {
  exactKeys(input, SCOPE_KEYS, "A2 scope");
  const scope = Object.create(null);
  for (const key of SCOPE_KEYS) {
    const value = input[key];
    if (key === "policyRevision") {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError("policyRevision must be a positive safe integer");
      }
    } else if (key === "policyHash") {
      if (typeof value !== "string" || !SHA256.test(value)) {
        throw new TypeError("policyHash must be a lowercase SHA-256 digest");
      }
    } else if (typeof value !== "string" || !IDENTIFIER.test(value)) {
      throw new TypeError(key + " is invalid");
    }
    scope[key] = value;
  }
  return Object.freeze(scope);
}

function sameScope(left, right) {
  return SCOPE_KEYS.every((key) => left?.[key] === right?.[key]);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonical(value[key])
  ).join(",") + "}";
}

function makeIdempotencyKey(action, scope, profileId) {
  return createHash("sha256").update(canonical({
    schema: "jb.resilience.a2-operation-key/v1",
    action,
    scope,
    profileId
  }), "utf8").digest("hex");
}

const RECOVERY_RECORD_KEYS = Object.freeze([
  "schema", "claimId", "action", "scope", "profileId", "providerId",
  "verifierId", "recorderId", "idempotencyKey", "state",
  "originalOperationId", "evidenceRefs", "createdAtMs",
  "updatedAtMs", "leaseExpiresAtMs"
]);

function normalizeRecoveryRecord(input, dependencies) {
  exactKeys(input, RECOVERY_RECORD_KEYS, "A2 durable recovery record");
  if (input.schema !== "jb.resilience.a2-recovery-record/v1") {
    throw new TypeError("unsupported A2 recovery record schema");
  }
  const claimId = assertIdentifier(input.claimId, "claimId");
  const action = input.action;
  if (!["apply-containment-profile", "release-containment"].includes(action)) {
    throw new TypeError("unsupported A2 recovery action");
  }
  const scope = normalizeScope(input.scope);
  const profileId = assertIdentifier(input.profileId, "profileId");
  const providerId = assertIdentifier(input.providerId, "providerId");
  const verifierId = assertIdentifier(input.verifierId, "verifierId");
  const recorderId = assertIdentifier(input.recorderId, "recorderId");
  if (providerId !== dependencies.providerId ||
      verifierId !== dependencies.verifierId ||
      recorderId !== dependencies.recorderId ||
      providerId === verifierId) {
    throw new TypeError("A2 recovery dependency identity mismatch");
  }
  const idempotencyKey = input.idempotencyKey;
  if (typeof idempotencyKey !== "string" || !SHA256.test(idempotencyKey) ||
      idempotencyKey !== makeIdempotencyKey(action, scope, profileId)) {
    throw new TypeError("A2 recovery idempotency key mismatch");
  }
  if (!["claimed", "provider-started", "held-for-reconciliation"].includes(input.state)) {
    throw new TypeError("A2 recovery record is not pending");
  }
  const originalOperationId = input.originalOperationId;
  if (originalOperationId !== null) {
    assertIdentifier(originalOperationId, "originalOperationId");
  }
  if (action === "release-containment" && originalOperationId === null) {
    throw new TypeError("release recovery requires the original containment operation ID");
  }
  if (action === "apply-containment-profile" && originalOperationId !== null) {
    throw new TypeError("containment recovery must not include a prior operation ID");
  }
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs);
  const createdAtMs = assertTimestamp(input.createdAtMs, "createdAtMs");
  const updatedAtMs = assertTimestamp(input.updatedAtMs, "updatedAtMs");
  const leaseExpiresAtMs = assertTimestamp(input.leaseExpiresAtMs, "leaseExpiresAtMs");
  if (updatedAtMs < createdAtMs || leaseExpiresAtMs < createdAtMs) {
    throw new TypeError("A2 recovery record timestamps are inconsistent");
  }
  return Object.freeze({
    schema: input.schema, claimId, action, scope, profileId,
    providerId, verifierId, recorderId, idempotencyKey, state,
    originalOperationId, evidenceRefs, createdAtMs, updatedAtMs, leaseExpiresAtMs
  });
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(label + " is invalid");
  }
  return value;
}

function normalizeEvidenceRefs(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1 || value.length > 128 ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.keys(value).length !== value.length) {
    throw new TypeError("evidenceRefs must be a dense plain array with 1 to 128 exact references");
  }
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("evidenceRefs must not contain holes, getters or hidden values");
    }
    const entry = descriptor.value;
    exactKeys(entry, ["refId", "sha256"], "evidence reference");
    const refId = assertIdentifier(entry.refId, "evidence refId");
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256) || seen.has(refId)) {
      throw new TypeError("evidence reference digest or identity is invalid");
    }
    seen.add(refId);
    normalized.push(Object.freeze({ refId, sha256: entry.sha256 }));
  }
  return Object.freeze(normalized);
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(label + " is invalid");
  return value;
}

function successful(value, property) {
  if (value === true) return true;
  try {
    exactKeys(value, [property], "A2 dependency result");
    return value[property] === true;
  } catch {
    return false;
  }
}

function exactOutcome(value, outcome, includeReceipt = false) {
  try {
    exactKeys(value, includeReceipt ? ["outcome", "receipt"] : ["outcome"], "A2 provider outcome");
  } catch {
    return false;
  }
  return value.outcome === outcome;
}

async function invokeBounded(callback, input, timeoutMs, label, clock) {
  const controller = new AbortController();
  const startedAt = assertTimestamp(clock(), "clock");
  const deadline = startedAt + timeoutMs;
  if (!Number.isSafeInteger(deadline)) throw new TypeError("operation deadline is invalid");
  let timer;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(label + "-timeout"));
    }, timeoutMs);
  });
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => callback({
        ...input,
        deadline,
        signal: controller.signal
      })),
      timeout
    ]);
    return { value, timedOut: false, deadline };
  } catch (error) {
    return {
      value: null,
      timedOut,
      deadline,
      error: error instanceof Error ? error.message : label + "-failed"
    };
  } finally {
    clearTimeout(timer);
  }
}

function validateAuthorization(value, action, scope, profileId, now) {
  try {
    exactKeys(value, [
      "schema", "authorizationId", "action", "profileId",
      ...SCOPE_KEYS, "issuedAtMs", "expiresAtMs"
    ], "A2 authorization");
  } catch {
    return false;
  }
  if (value.schema !== "jb.resilience.a2-authorization/v1" ||
      typeof value.authorizationId !== "string" ||
      !IDENTIFIER.test(value.authorizationId) ||
      value.action !== action ||
      value.profileId !== profileId ||
      !sameScope(value, scope) ||
      !Number.isSafeInteger(value.issuedAtMs) ||
      value.issuedAtMs < 0 ||
      !Number.isSafeInteger(value.expiresAtMs) ||
      value.expiresAtMs < 0 ||
      value.issuedAtMs > now ||
      value.expiresAtMs <= now ||
      value.expiresAtMs <= value.issuedAtMs) {
    return false;
  }
  return true;
}

function validateOperationReceipt(receipt, {
  providerId, action, scope, profileId, idempotencyKey, now, expectedState
}) {
  try {
    exactKeys(receipt, [
      "schema", "providerId", "operationId", "action", "idempotencyKey",
      "profileId", ...SCOPE_KEYS, "state", "occurredAtMs"
    ], "A2 operation receipt");
  } catch {
    return false;
  }
  if (receipt.schema !== "jb.resilience.a2-operation-receipt/v1" ||
      receipt.providerId !== providerId ||
      typeof receipt.operationId !== "string" ||
      !IDENTIFIER.test(receipt.operationId) ||
      receipt.action !== action ||
      receipt.idempotencyKey !== idempotencyKey ||
      receipt.profileId !== profileId ||
      !sameScope(receipt, scope) ||
      receipt.state !== expectedState ||
      !Number.isSafeInteger(receipt.occurredAtMs) ||
      receipt.occurredAtMs < 0 ||
      receipt.occurredAtMs > now) {
    return false;
  }
  return true;
}

function validatePreflight(value, providerId, scope, profileId) {
  try {
    exactKeys(value, [
      "schema", "providerId", "ready", "profileId", ...SCOPE_KEYS,
      "managementPathAvailable", "forensicPathAvailable"
    ], "A2 preflight result");
  } catch {
    return false;
  }
  return value.schema === "jb.resilience.a2-preflight/v1" &&
    value.providerId === providerId &&
    value.ready === true &&
    value.profileId === profileId &&
    sameScope(value, scope) &&
    value.managementPathAvailable === true &&
    value.forensicPathAvailable === true;
}

function validateIndependentVerification(value, {
  verifierId, scope, profileId, expectedState, operationId, evidenceRefs, now
}) {
  try {
    exactKeys(value, [
      "schema", "verifierId", "verified", "state", "profileId", "operationId",
      "referencesSha256", ...SCOPE_KEYS, "observedAtMs", "expiresAtMs"
    ], "A2 independent verification");
  } catch {
    return false;
  }
  return value.schema === "jb.resilience.a2-verification/v1" &&
    value.verifierId === verifierId &&
    value.verified === true &&
    value.state === expectedState &&
    value.profileId === profileId &&
    value.operationId === operationId &&
    value.referencesSha256 === createHash("sha256").update(canonical(evidenceRefs), "utf8").digest("hex") &&
    sameScope(value, scope) &&
    Number.isSafeInteger(value.observedAtMs) &&
    value.observedAtMs >= 0 &&
    value.observedAtMs <= now &&
    Number.isSafeInteger(value.expiresAtMs) &&
    value.expiresAtMs >= 0 &&
    value.expiresAtMs > now;
}

function validateForensicReceipt(value, recorderId, scope, now, evidenceRefs, operationId) {
  try {
    exactKeys(value, [
      "schema", "recorderId", "retained", ...SCOPE_KEYS, "evidenceIds",
      "retentionPolicyId", "preservedAtMs", "expiresAtMs", "referencesSha256", "operationId"
    ], "A2 forensic receipt");
  } catch {
    return false;
  }

  const evidenceIds = value.evidenceIds;
  if (!Array.isArray(evidenceIds) || Object.getPrototypeOf(evidenceIds) !== Array.prototype ||
      evidenceIds.length < 1 || evidenceIds.length > 128 ||
      Object.getOwnPropertySymbols(evidenceIds).length !== 0 ||
      Reflect.ownKeys(evidenceIds).length !== evidenceIds.length + 1) {
    return false;
  }
  const seenEvidenceIds = new Set();
  for (let index = 0; index < evidenceIds.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(evidenceIds, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string" || !IDENTIFIER.test(descriptor.value) ||
        seenEvidenceIds.has(descriptor.value)) {
      return false;
    }
    seenEvidenceIds.add(descriptor.value);
  }

  return value.schema === "jb.resilience.a2-forensic-receipt/v1" &&
    value.recorderId === recorderId &&
    value.retained === true &&
    value.operationId === operationId &&
    typeof value.operationId === "string" &&
    IDENTIFIER.test(value.operationId) &&
    value.referencesSha256 === createHash("sha256").update(canonical(evidenceRefs), "utf8").digest("hex") &&
    sameScope(value, scope) &&
    typeof value.retentionPolicyId === "string" &&
    IDENTIFIER.test(value.retentionPolicyId) &&
    Number.isSafeInteger(value.preservedAtMs) &&
    value.preservedAtMs >= 0 &&
    value.preservedAtMs <= now &&
    Number.isSafeInteger(value.expiresAtMs) &&
    value.expiresAtMs >= 0 &&
    value.expiresAtMs > now;
}

function makeResult(state, reason, details = {}) {
  return Object.freeze({
    schema: "jb.resilience.a2-execution-result/v1",
    capability: "A2-bounded-containment",
    state,
    executed: false,
    verified: false,
    authorizationGranted: false,
    reason,
    ...details
  });
}

/**
 * Creates a provider-neutral A2 execution controller.
 *
 * The controller ships no cloud/firewall/endpoint provider and grants no
 * authorization. The host must inject its own policy authority, durable
 * ledgers, provider, independent verifier, forensic recorder and stop control.
 * Execution is disabled unless enableExecution is explicitly true.
 */
export function createA2ContainmentController({
  enableExecution = false,
  policyAuthority,
  containmentProvider,
  independentVerifier,
  forensicRecorder,
  budgetLedger,
  actionLedger,
  auditStore,
  mutationControl,
  clock = Date.now,
  operationTimeoutMs = 5_000
} = {}) {
  if (typeof enableExecution !== "boolean") {
    throw new TypeError("enableExecution must be boolean");
  }
  // A successful containment handle is scoped to this controller instance.
  // Another controller, even in the same process, cannot release it.
  const containmentResults = new WeakMap();
  if (typeof clock !== "function" ||
      !Number.isSafeInteger(operationTimeoutMs) ||
      operationTimeoutMs < 100 || operationTimeoutMs > 30_000) {
    throw new TypeError("A2 controller clock or timeout configuration is invalid");
  }
  const requiredMethods = [
    [policyAuthority, ["authorize", "assertAuthorization", "completeAuthorization"], "policyAuthority"],
    [containmentProvider, ["preflight", "apply", "reconcile", "release", "reconcileRelease"], "containmentProvider"],
    [independentVerifier, ["verifyContainment", "verifyRelease"], "independentVerifier"],
    [forensicRecorder, ["preserveEvidence"], "forensicRecorder"],
    [budgetLedger, ["reserve", "reconcile", "settle"], "budgetLedger"],
    [actionLedger, ["claim", "markProviderStarted", "reconcile", "complete"], "actionLedger"],
    [auditStore, ["append"], "auditStore"],
    [mutationControl, ["assertAllowed"], "mutationControl"]
  ];
  for (const [dependency, methods, label] of requiredMethods) {
    if (!isRecord(dependency) || methods.some((method) => typeof dependency[method] !== "function")) {
      throw new TypeError(label + " does not implement the required A2 contract");
    }
  }
  for (const [dependency, label] of [
    [budgetLedger, "budgetLedger"],
    [actionLedger, "actionLedger"],
    [auditStore, "auditStore"]
  ]) {
    if (dependency.durable !== true) {
      throw new TypeError(label + " must be durable for A2 execution");
    }
  }
  const providerId = assertIdentifier(containmentProvider.providerId, "containment providerId");
  const verifierId = assertIdentifier(independentVerifier.verifierId, "independent verifierId");
  const recorderId = assertIdentifier(forensicRecorder.recorderId, "forensic recorderId");
  if (new Set([providerId, verifierId, recorderId]).size !== 3) {
    throw new TypeError("A2 provider, independent verifier and forensic recorder must have distinct identities");
  }
  if (enableExecution &&
      ["createPendingRecord", "listPending", "getPendingByClaimId"].some(
        (method) => typeof actionLedger[method] !== "function"
      )) {
    throw new TypeError("actionLedger must implement the durable A2 pending recovery journal");
  }

  async function invokeDependency(owner, method, input, label) {
    return invokeBounded(
      owner[method].bind(owner),
      input,
      operationTimeoutMs,
      label,
      clock
    );
  }

  let pendingRecordValidationFailure = null;

  async function pendingRecordMatches(claimId, expectedRecord) {
    const call = await invokeDependency(actionLedger, "getPendingByClaimId", {
      claimId, atMs: assertTimestamp(clock(), "A2 pending record lookup clock")
    }, "pending-record-exact-lookup");
    if (call.timedOut || call.error) {
      pendingRecordValidationFailure = call.timedOut ? "exact-readback-timeout" : "exact-readback-error";
      return false;
    }
    try {
      exactKeys(call.value, ["found", "record"], "A2 pending record lookup");
      if (call.value.found !== true || call.value.record === null) {
        pendingRecordValidationFailure = "exact-readback-record-missing";
        return false;
      }
      const dependencies = { providerId, verifierId, recorderId };
      const actual = normalizeRecoveryRecord(call.value.record, dependencies);
      const expected = normalizeRecoveryRecord(expectedRecord, dependencies);
      const matches = canonical(actual) === canonical(expected);
      pendingRecordValidationFailure = matches ? null : "exact-readback-content-mismatch";
      return matches;
    } catch (error) {
      pendingRecordValidationFailure = error instanceof Error
        ? error.message.slice(0, 160) : "exact-readback-record-invalid";
      return false;
    }
  }

  async function persistPendingActionRecord({
    claimId, action, scope, profileId, idempotencyKey, evidenceRefs,
    originalOperationId = null
  }) {
    const createdAtMs = assertTimestamp(clock(), "A2 pending record creation clock");
    const leaseExpiresAtMs = createdAtMs + operationTimeoutMs * 8;
    if (!Number.isSafeInteger(leaseExpiresAtMs)) return { ok: false, record: null };
    const record = Object.freeze({
      schema: "jb.resilience.a2-recovery-record/v1",
      claimId, action, scope, profileId,
      providerId, verifierId, recorderId,
      idempotencyKey,
      state: "claimed",
      originalOperationId,
      evidenceRefs: normalizeEvidenceRefs(evidenceRefs),
      createdAtMs,
      updatedAtMs: createdAtMs,
      leaseExpiresAtMs
    });
    const call = await invokeDependency(actionLedger, "createPendingRecord", {
      record, atMs: createdAtMs
    }, "pending-record-create");
    // A timeout is ambiguous. Continue only when an exact durable read-back
    // proves that this invocation's complete record was persisted.
    const stored = await pendingRecordMatches(claimId, record);
    return {
      ok: stored && !call.error && !call.timedOut &&
        successful(call.value, "created"),
      reason: stored ? null : pendingRecordValidationFailure,
      record
    };
  }

  async function appendAudit(entry) {
    try {
      const call = await invokeDependency(auditStore, "append", Object.freeze({
        schema: "jb.resilience.a2-audit-event/v1",
        atMs: assertTimestamp(clock(), "audit clock"),
        providerId,
        verifierId,
        ...entry
      }), "audit-write");
      return !call.timedOut && !call.error && successful(call.value, "recorded");
    } catch {
      return false;
    }
  }

  async function assertMutationAllowed(scope, action, phase) {
    try {
      const call = await invokeDependency(
        mutationControl, "assertAllowed", { scope, action, phase }, "mutation-control"
      );
      return !call.timedOut && !call.error && successful(call.value, "allowed");
    } catch {
      return false;
    }
  }

  async function authorize(action, scope, profileId, reasonCode) {
    let call;
    try {
      call = await invokeDependency(policyAuthority, "authorize", {
        schema: "jb.resilience.a2-authorization-request/v1",
        action,
        scope,
        profileId,
        reasonCode
      }, "policy-authorize");
    } catch {
      return null;
    }
    if (call.timedOut || call.error) return null;
    const issued = call.value;
    const now = assertTimestamp(clock(), "authorization clock");
    try {
      exactKeys(issued, ["authorized", "authorization"], "A2 authorization response");
    } catch {
      return null;
    }
    if (issued.authorized !== true ||
        !validateAuthorization(issued.authorization, action, scope, profileId, now)) {
      return null;
    }
    return Object.freeze({ ...issued.authorization });
  }

  async function assertAuthorization(authorization, action, scope, profileId) {
    const now = assertTimestamp(clock(), "authorization clock");
    if (!validateAuthorization(authorization, action, scope, profileId, now)) return false;
    try {
      const call = await invokeDependency(policyAuthority, "assertAuthorization", {
        authorization, action, scope, profileId
      }, "policy-assert-authorization");
      return !call.timedOut && !call.error && successful(call.value, "valid");
    } catch {
      return false;
    }
  }

  async function completeAuthorization(authorization, outcome) {
    try {
      const call = await invokeDependency(policyAuthority, "completeAuthorization", {
        authorization, outcome
      }, "policy-complete-authorization");
      return !call.timedOut && !call.error && successful(call.value, "recorded");
    } catch {
      return false;
    }
  }

  async function settleBudget(reservationId, outcome) {
    if (typeof reservationId !== "string") return true;
    try {
      const call = await invokeDependency(budgetLedger, "settle", {
        reservationId, outcome, atMs: assertTimestamp(clock(), "budget clock")
      }, "budget-settlement");
      return !call.timedOut && !call.error && successful(call.value, "settled");
    } catch {
      return false;
    }
  }

  async function completeAction(claimId, outcome, reason) {
    try {
      const call = await invokeDependency(actionLedger, "complete", {
        claimId, outcome, reason,
        completedAtMs: assertTimestamp(clock(), "action completion clock")
      }, "action-completion");
      return !call.timedOut && !call.error && successful(call.value, "completed");
    } catch {
      return false;
    }
  }

  async function reconcileActionClaim(action, scope, profileId, idempotencyKey) {
    const call = await invokeDependency(actionLedger, "reconcile", {
      action, scope, profileId, idempotencyKey,
      atMs: assertTimestamp(clock(), "action claim reconciliation clock")
    }, "action-claim-reconciliation");
    if (call.timedOut || call.error) return { state: "unknown", claimId: null };
    try {
      exactKeys(call.value, ["state", "claimId"], "A2 action claim reconciliation");
    } catch {
      return { state: "unknown", claimId: null };
    }
    const { state, claimId } = call.value;
    if (!["claimed", "provider-started", "completed", "not-found", "unknown"].includes(state)) {
      return { state: "unknown", claimId: null };
    }
    if (state === "not-found" || state === "unknown") {
      return claimId === null ? { state, claimId: null } : { state: "unknown", claimId: null };
    }
    return typeof claimId === "string" && IDENTIFIER.test(claimId)
      ? { state, claimId } : { state: "unknown", claimId: null };
  }

  async function reconcileBudgetReservation(action, scope, profileId, idempotencyKey) {
    const call = await invokeDependency(budgetLedger, "reconcile", {
      action, scope, profileId, idempotencyKey,
      atMs: assertTimestamp(clock(), "budget reconciliation clock")
    }, "budget-reconciliation");
    if (call.timedOut || call.error) return { state: "unknown", reservationId: null };
    try {
      exactKeys(call.value, ["state", "reservationId"], "A2 budget reconciliation");
    } catch {
      return { state: "unknown", reservationId: null };
    }
    const { state, reservationId } = call.value;
    if (!["reserved", "settled", "not-found", "unknown"].includes(state)) {
      return { state: "unknown", reservationId: null };
    }
    if (state === "not-found" || state === "unknown") {
      return reservationId === null ? { state, reservationId: null } : { state: "unknown", reservationId: null };
    }
    return typeof reservationId === "string" && IDENTIFIER.test(reservationId)
      ? { state, reservationId } : { state: "unknown", reservationId: null };
  }

  async function markProviderStarted(
    claimId, action, scope, profileId, idempotencyKey, recoveryRecord
  ) {
    const startedAtMs = assertTimestamp(clock(), "provider-start marker clock");
    const startedRecord = Object.freeze({
      ...recoveryRecord,
      state: "provider-started",
      updatedAtMs: startedAtMs
    });
    const call = await invokeDependency(actionLedger, "markProviderStarted", {
      claimId, action, scope, profileId, idempotencyKey,
      recoveryRecord: startedRecord,
      atMs: startedAtMs
    }, "provider-start-marker");
    if (!call.timedOut && !call.error) {
      try {
        exactKeys(call.value, ["started"], "A2 provider-start marker");
        if (call.value.started === true) {
          const stored = await pendingRecordMatches(claimId, startedRecord);
          return stored
            ? { started: true, recoveryRecord: startedRecord }
            : { started: false, hold: true, reason: "durable-provider-start-record-not-confirmed" };
        }
      } catch {
        // Resolve an ambiguous marker through the durable claim journal.
      }
    }
    const journal = await reconcileActionClaim(action, scope, profileId, idempotencyKey);
    if (journal.state === "claimed") {
      const stored = await pendingRecordMatches(claimId, recoveryRecord);
      if (stored) return { started: false, safeNotStarted: true };
    }
    return {
      started: false, hold: true,
      reason: "provider-start-state-unknown-or-already-started"
    };
  }

  async function reserveResources(action, scope, profileId, idempotencyKey) {
    const now = assertTimestamp(clock(), "resource reservation clock");
    const expiresAtMs = now + operationTimeoutMs * 8;
    if (!Number.isSafeInteger(expiresAtMs)) {
      return { ok: false, reason: "action-claim-expiry-invalid" };
    }

    let claimCall;
    try {
      claimCall = await invokeDependency(actionLedger, "claim", {
        action, scope, profileId, idempotencyKey,
        claimedAtMs: now,
        expiresAtMs
      }, "action-claim");
    } catch {
      claimCall = { value: null, timedOut: false, error: "action-claim-failed" };
    }
    let claim = claimCall.timedOut || claimCall.error ? null : claimCall.value;
    try {
      exactKeys(claim, ["claimed", "claimId"], "A2 action claim");
    } catch {
      claim = null;
    }
    if (!isRecord(claim) || claim.claimed !== true ||
        typeof claim.claimId !== "string" || !IDENTIFIER.test(claim.claimId)) {
      const journal = await reconcileActionClaim(action, scope, profileId, idempotencyKey);
      if (journal.state === "claimed") {
        // The claim may belong to a concurrent owner. Without a valid claim
        // receipt from this call, never cancel another process's live lease.
        return {
          ok: false, hold: true,
          reason: "existing-action-claim-not-owned-by-this-invocation"
        };
      }
      if (journal.state === "not-found") return { ok: false, reason: "action-claim-not-recorded" };
      return {
        ok: false, hold: true,
        reason: journal.state === "provider-started" || journal.state === "completed"
          ? "existing-action-may-have-started" : "action-claim-reconciliation-unknown"
      };
    }

    let budgetCall;
    try {
      budgetCall = await invokeDependency(budgetLedger, "reserve", {
        action, scope, profileId, idempotencyKey, atMs: now
      }, "budget-reservation");
    } catch {
      budgetCall = { value: null, timedOut: false, error: "budget-reservation-failed" };
    }
    let budget = budgetCall.timedOut || budgetCall.error ? null : budgetCall.value;
    try {
      exactKeys(budget, ["reserved", "reservationId"], "A2 budget reservation");
    } catch {
      budget = null;
    }
    if (!isRecord(budget) || budget.reserved !== true ||
        typeof budget.reservationId !== "string" || !IDENTIFIER.test(budget.reservationId)) {
      const journal = await reconcileBudgetReservation(action, scope, profileId, idempotencyKey);
      if (journal.state === "reserved") {
        const settled = await settleBudget(journal.reservationId, "not-applied");
        const finalized = await completeAction(
          claim.claimId, settled ? "not-applied" : "held-for-reconciliation",
          "budget-reservation-reconciled-before-provider"
        );
        const okay = settled && finalized;
        return {
          ok: false, hold: !okay,
          reason: okay ? "budget-reservation-reconciled-before-provider" : "budget-reservation-finalization-unknown"
        };
      }
      if (journal.state === "not-found") {
        const finalized = await completeAction(
          claim.claimId, "not-applied", "budget-reservation-not-recorded"
        );
        return {
          ok: false, hold: !finalized,
          reason: finalized ? "budget-reservation-denied" : "action-ledger-finalization-failed"
        };
      }
      const finalized = await completeAction(
        claim.claimId, "held-for-reconciliation", "budget-reservation-reconciliation-unknown"
      );
      return {
        ok: false, hold: true,
        reason: finalized ? "budget-reservation-reconciliation-unknown" : "action-ledger-finalization-failed"
      };
    }
    return { ok: true, claimId: claim.claimId, reservationId: budget.reservationId };
  }

  async function finishNotApplied({
    action, scope, profileId, claimId, reservationId, authorization, reason
  }) {
    const budgetOkay = await settleBudget(reservationId, "not-applied");
    const authOkay = await completeAuthorization(authorization, "failed");
    const auditOkay = await appendAudit({
      action, scope, profileId, outcome: "not-applied", reason
    });
    const priorFinalizationOkay = budgetOkay && authOkay && auditOkay;
    const actionOkay = await completeAction(
      claimId,
      priorFinalizationOkay ? "not-applied" : "held-for-reconciliation",
      priorFinalizationOkay ? reason : "not-applied-finalization-incomplete"
    );
    return makeResult(priorFinalizationOkay && actionOkay
      ? "not-applied" : "held-for-reconciliation", reason);
  }

  async function finishUnknown({
    action, scope, profileId, claimId, reservationId, authorization, reason, operationReceipt = null
  }) {
    const budgetOkay = await settleBudget(reservationId, "unknown");
    const actionOkay = await completeAction(claimId, "held-for-reconciliation", reason);
    const authOkay = await completeAuthorization(authorization, "unverified");
    const auditOkay = await appendAudit({
      action, scope, profileId, outcome: "held-for-reconciliation", reason,
      operationId: operationReceipt?.operationId ?? null
    });
    return makeResult("held-for-reconciliation",
      budgetOkay && actionOkay && authOkay && auditOkay ? reason : "finalization-incomplete",
      { operationReceipt });
  }

  async function verifyAndPreserve({
    action, scope, profileId, operationReceipt, evidenceRefs
  }) {
    const verifyCall = await invokeBounded(
      independentVerifier.verifyContainment.bind(independentVerifier),
      { action, scope, profileId, operationReceipt, evidenceRefs },
      operationTimeoutMs, "independent-verification", clock
    );
    const verifyNow = assertTimestamp(clock(), "verification clock");
    if (!validateIndependentVerification(verifyCall.value, {
      verifierId, scope, profileId, expectedState: "contained",
      operationId: operationReceipt.operationId, evidenceRefs, now: verifyNow
    })) return { ok: false, reason: "independent-containment-verification-failed" };
    const verification = Object.freeze({ ...verifyCall.value });

    const preserveCall = await invokeBounded(
      forensicRecorder.preserveEvidence.bind(forensicRecorder),
      { scope, profileId, evidenceRefs, operationId: operationReceipt.operationId, retentionPolicyId: "owner-approved" },
      operationTimeoutMs, "forensic-preservation", clock
    );
    const preserveNow = assertTimestamp(clock(), "forensic clock");
    if (!validateForensicReceipt(
      preserveCall.value, recorderId, scope, preserveNow, evidenceRefs, operationReceipt.operationId
    )) {
      return { ok: false, reason: "forensic-evidence-preservation-failed" };
    }
    const forensicReceipt = Object.freeze({
      ...preserveCall.value,
      evidenceIds: Object.freeze([...preserveCall.value.evidenceIds])
    });
    return { ok: true, verification, forensicReceipt };
  }

  async function runContainment(
    { readiness, scope: rawScope, profileId, evidenceRefs } = {},
    markLedgerAttempted,
    markProviderStartRecorded
  ) {
    if (!enableExecution) return makeResult("disabled", "a2-execution-disabled");
    let scope;
    let refs;
    try {
      scope = normalizeScope(rawScope);
      profileId = assertIdentifier(profileId, "profileId");
      refs = normalizeEvidenceRefs(evidenceRefs);
    } catch {
      return makeResult("denied", "invalid-a2-execution-context");
    }

    const readinessMetadata = getA2ProviderReadinessMetadata(readiness);
    if (!readinessMetadata || readiness.eligible !== true ||
        readiness.executable !== false || !sameScope(readinessMetadata.scope, scope)) {
      return makeResult("denied", "verified-a2-readiness-for-exact-scope-required");
    }
    const readinessNow = assertTimestamp(clock(), "A2 readiness execution clock");
    if (!Number.isSafeInteger(readinessMetadata.observedAtMs) ||
        !Number.isSafeInteger(readinessMetadata.expiresAtMs) ||
        readinessNow < readinessMetadata.observedAtMs ||
        readinessNow >= readinessMetadata.expiresAtMs) {
      return makeResult("denied", "a2-readiness-evidence-stale-at-execution");
    }
    if (readinessMetadata.evidenceRefs.length !== refs.length ||
        readinessMetadata.evidenceRefs.some((verified, index) =>
          verified.refId !== refs[index].refId || verified.sha256 !== refs[index].sha256
        )) {
      return makeResult("denied", "a2-forensic-references-not-bound-to-verified-readiness");
    }

    const action = "apply-containment-profile";
    const idempotencyKey = makeIdempotencyKey(action, scope, profileId);
    if (!await appendAudit({ action, scope, profileId, outcome: "requested", idempotencyKey })) {
      return makeResult("denied", "durable-audit-unavailable");
    }
    if (!await assertMutationAllowed(scope, action, "before-authorization")) {
      return makeResult("denied", "mutation-control-blocked");
    }

    const authorization = await authorize(action, scope, profileId, "confirmed-threat-containment");
    if (!authorization) return makeResult("denied", "a2-policy-authorization-denied");
    if (!await assertAuthorization(authorization, action, scope, profileId)) {
      await completeAuthorization(authorization, "failed");
      return makeResult("denied", "a2-policy-authorization-invalid");
    }

    markLedgerAttempted();
    const reserved = await reserveResources(action, scope, profileId, idempotencyKey);
    if (!reserved.ok) {
      const authorizationFinalized = await completeAuthorization(
        authorization, reserved.hold ? "unverified" : "failed"
      );
      if (reserved.hold || !authorizationFinalized) {
        await appendAudit({
          action, scope, profileId, outcome: "held-for-reconciliation",
          reason: reserved.reason, idempotencyKey
        });
        return makeResult("held-for-reconciliation", reserved.reason);
      }
      return makeResult("denied", reserved.reason);
    }
    const { claimId, reservationId } = reserved;
    const pendingRecovery = await persistPendingActionRecord({
      claimId, action, scope, profileId, idempotencyKey,
      evidenceRefs: refs
    });
    if (!pendingRecovery.ok) {
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: pendingRecovery.reason
          ? "durable-pending-action-record-unavailable:" + pendingRecovery.reason
          : "durable-pending-action-record-unavailable"
      });
    }
    const recoveryRecord = pendingRecovery.record;

    if (!await appendAudit({
      action, scope, profileId, outcome: "resources-reserved", idempotencyKey
    })) {
      return finishNotApplied({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "durable-audit-unavailable-before-provider"
      });
    }

    const preflight = await invokeBounded(
      containmentProvider.preflight.bind(containmentProvider),
      { scope, profileId },
      operationTimeoutMs, "containment-preflight", clock
    );
    if (!validatePreflight(preflight.value, providerId, scope, profileId)) {
      return finishNotApplied({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "containment-preflight-failed"
      });
    }
    const mutationAllowed = await assertMutationAllowed(scope, action, "before-apply");
    const authorizationStillValid = await assertAuthorization(
      authorization, action, scope, profileId
    );
    const preApplyNow = assertTimestamp(clock(), "A2 pre-apply clock");
    if (!mutationAllowed || !authorizationStillValid ||
        preApplyNow < readinessMetadata.observedAtMs ||
        preApplyNow >= readinessMetadata.expiresAtMs) {
      return finishNotApplied({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "policy-or-readiness-changed-before-apply"
      });
    }
    if (!await appendAudit({
      action, scope, profileId, outcome: "provider-start-authorized", idempotencyKey
    })) {
      return finishNotApplied({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "durable-audit-unavailable-before-provider"
      });
    }
    const startMarker = await markProviderStarted(
      claimId, action, scope, profileId, idempotencyKey, recoveryRecord
    );
    if (!startMarker.started) {
      if (startMarker.safeNotStarted) {
        return finishNotApplied({
          action, scope, profileId, claimId, reservationId, authorization,
          reason: "provider-start-not-recorded"
        });
      }
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: startMarker.reason ?? "provider-start-state-unknown"
      });
    }

    markProviderStartRecorded();
    const postMarkerAuthorization = await assertAuthorization(
      authorization, action, scope, profileId
    );
    const postMarkerMutation = await assertMutationAllowed(
      scope, action, "after-provider-start-marker"
    );
    const postMarkerNow = assertTimestamp(clock(), "A2 post-marker clock");
    if (!postMarkerAuthorization || !postMarkerMutation ||
        postMarkerNow < readinessMetadata.observedAtMs ||
        postMarkerNow >= readinessMetadata.expiresAtMs) {
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "policy-mutation-control-or-readiness-changed-after-provider-start-marker"
      });
    }

    const apply = await invokeBounded(
      containmentProvider.apply.bind(containmentProvider),
      { scope, profileId, idempotencyKey },
      operationTimeoutMs, "containment-apply", clock
    );
    let operationReceipt = null;
    if (exactOutcome(apply.value, "applied", true) &&
        validateOperationReceipt(apply.value.receipt, {
          providerId, action, scope, profileId, idempotencyKey,
          now: assertTimestamp(clock(), "provider receipt clock"), expectedState: "contained"
        })) {
      operationReceipt = Object.freeze({ ...apply.value.receipt });
    } else {
      // A timeout or malformed response is ambiguous. Reconcile before any retry.
      const reconcile = await invokeBounded(
        containmentProvider.reconcile.bind(containmentProvider),
        { scope, profileId, idempotencyKey },
        operationTimeoutMs, "containment-reconciliation", clock
      );
      if (exactOutcome(reconcile.value, "not-applied")) {
        return finishNotApplied({
          action, scope, profileId, claimId, reservationId, authorization,
          reason: "provider-confirmed-not-applied"
        });
      }
      if (!exactOutcome(reconcile.value, "applied", true) ||
          !validateOperationReceipt(reconcile.value.receipt, {
            providerId, action, scope, profileId, idempotencyKey,
            now: assertTimestamp(clock(), "reconciliation receipt clock"), expectedState: "contained"
          })) {
        return finishUnknown({
          action, scope, profileId, claimId, reservationId, authorization,
          reason: "provider-outcome-unknown"
        });
      }
      operationReceipt = Object.freeze({ ...reconcile.value.receipt });
    }

    const verified = await verifyAndPreserve({
      action, scope, profileId, operationReceipt, evidenceRefs: refs
    });
    if (!verified.ok) {
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: verified.reason, operationReceipt
      });
    }

    const finalReadinessNow = assertTimestamp(clock(), "A2 final readiness clock");
    if (finalReadinessNow < readinessMetadata.observedAtMs ||
        finalReadinessNow >= readinessMetadata.expiresAtMs ||
        !await assertAuthorization(authorization, action, scope, profileId) ||
        !await assertMutationAllowed(scope, action, "before-finalization")) {
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "authorization-or-mutation-control-changed-after-apply", operationReceipt
      });
    }

    const budgetOkay = await settleBudget(reservationId, "succeeded");
    const authorizationOkay = await completeAuthorization(authorization, "succeeded");
    const auditOkay = await appendAudit({
      action, scope, profileId, outcome: "contained",
      operationId: operationReceipt.operationId,
      verifierId,
      forensicEvidenceCount: verified.forensicReceipt.evidenceIds.length
    });
    const actionOkay = await completeAction(
      claimId,
      budgetOkay && authorizationOkay && auditOkay ? "succeeded" : "held-for-reconciliation",
      budgetOkay && authorizationOkay && auditOkay ? null : "success-finalization-incomplete"
    );
    if (!budgetOkay || !actionOkay || !authorizationOkay || !auditOkay) {
      return makeResult("held-for-reconciliation", "success-finalization-incomplete", {
        operationReceipt
      });
    }

    const result = Object.freeze({
      schema: "jb.resilience.a2-execution-result/v1",
      capability: "A2-bounded-containment",
      state: "contained",
      executed: true,
      verified: true,
      authorizationGranted: true,
      reason: null,
      scope,
      profileId,
      operationReceipt,
      verification: verified.verification,
      forensicReceipt: verified.forensicReceipt,
      idempotencyKey
    });
    containmentResults.set(result, {
      state: "contained", scope, profileId, operationReceipt, evidenceRefs: refs
    });
    return result;
  }

  async function runReleaseContainment(
    { containment, reasonCode } = {},
    markLedgerAttempted,
    markProviderStartRecorded
  ) {
    if (!enableExecution) return makeResult("disabled", "a2-execution-disabled");
    const record = containmentResults.get(containment);
    if (!record || record.state !== "contained") {
      return makeResult("denied", "verified-controller-containment-result-required");
    }
    try {
      assertIdentifier(reasonCode, "release reasonCode");
    } catch {
      return makeResult("denied", "release-reason-required");
    }

    const { scope, profileId, operationReceipt, evidenceRefs } = record;
    const action = "release-containment";
    const idempotencyKey = makeIdempotencyKey(action, scope, profileId);
    if (!await appendAudit({ action, scope, profileId, outcome: "release-requested", idempotencyKey })) {
      return makeResult("denied", "durable-audit-unavailable");
    }
    if (!await assertMutationAllowed(scope, action, "before-release-authorization")) {
      return makeResult("denied", "mutation-control-blocked");
    }

    const authorization = await authorize(action, scope, profileId, reasonCode);
    if (!authorization || !await assertAuthorization(authorization, action, scope, profileId)) {
      if (authorization) await completeAuthorization(authorization, "failed");
      return makeResult("denied", "a2-release-authorization-denied");
    }
    markLedgerAttempted();
    const reserved = await reserveResources(action, scope, profileId, idempotencyKey);
    if (!reserved.ok) {
      const authorizationFinalized = await completeAuthorization(
        authorization, reserved.hold ? "unverified" : "failed"
      );
      if (reserved.hold || !authorizationFinalized) {
        await appendAudit({
          action, scope, profileId, outcome: "held-for-reconciliation",
          reason: reserved.reason, idempotencyKey
        });
        return makeResult("held-for-reconciliation", reserved.reason);
      }
      return makeResult("denied", reserved.reason);
    }
    const { claimId, reservationId } = reserved;
    const pendingRecovery = await persistPendingActionRecord({
      claimId, action, scope, profileId, idempotencyKey,
      evidenceRefs, originalOperationId: operationReceipt.operationId
    });
    if (!pendingRecovery.ok) {
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: pendingRecovery.reason
          ? "durable-pending-action-record-unavailable:" + pendingRecovery.reason
          : "durable-pending-action-record-unavailable",
        operationReceipt
      });
    }
    const recoveryRecord = pendingRecovery.record;

    const current = await invokeBounded(
      independentVerifier.verifyContainment.bind(independentVerifier),
      { action: "verify-before-release", scope, profileId, operationReceipt, evidenceRefs },
      operationTimeoutMs, "pre-release-verification", clock
    );
    if (!validateIndependentVerification(current.value, {
      verifierId, scope, profileId, expectedState: "contained",
      operationId: operationReceipt.operationId,
      evidenceRefs, now: assertTimestamp(clock(), "pre-release verification clock")
    })) {
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "current-containment-state-not-independently-verified",
        operationReceipt
      });
    }

    if (!Array.isArray(evidenceRefs) || evidenceRefs.length < 1) {
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "release-forensics-references-unavailable", operationReceipt
      });
    }

    const preserved = await invokeBounded(
      forensicRecorder.preserveEvidence.bind(forensicRecorder),
      { scope, profileId, evidenceRefs, operationId: operationReceipt.operationId,
        retentionPolicyId: "owner-approved-before-release" },
      operationTimeoutMs, "pre-release-forensics", clock
    );
    if (!validateForensicReceipt(preserved.value, recorderId, scope,
        assertTimestamp(clock(), "pre-release forensic clock"), evidenceRefs, operationReceipt.operationId)) {
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "pre-release-forensic-preservation-failed", operationReceipt
      });
    }

    if (!await assertMutationAllowed(scope, action, "before-release") ||
        !await assertAuthorization(authorization, action, scope, profileId)) {
      return finishNotApplied({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "policy-or-mutation-control-changed-before-release"
      });
    }

    const preservedReceipt = Object.freeze({
      ...preserved.value,
      evidenceIds: Object.freeze([...preserved.value.evidenceIds])
    });
    if (!await appendAudit({
      action, scope, profileId, outcome: "provider-start-authorized", idempotencyKey
    })) {
      return finishNotApplied({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "durable-audit-unavailable-before-release"
      });
    }
    const releaseStartMarker = await markProviderStarted(
      claimId, action, scope, profileId, idempotencyKey, recoveryRecord
    );
    if (!releaseStartMarker.started) {
      if (releaseStartMarker.safeNotStarted) {
        return finishNotApplied({
          action, scope, profileId, claimId, reservationId, authorization,
          reason: "release-start-not-recorded"
        });
      }
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: releaseStartMarker.reason ?? "release-start-state-unknown",
        operationReceipt
      });
    }
    markProviderStartRecorded();
    const postMarkerAuthorization = await assertAuthorization(
      authorization, action, scope, profileId
    );
    const postMarkerMutation = await assertMutationAllowed(
      scope, action, "after-release-start-marker"
    );
    if (!postMarkerAuthorization || !postMarkerMutation) {
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "policy-or-mutation-control-changed-after-release-start-marker",
        operationReceipt
      });
    }

    const release = await invokeBounded(
      containmentProvider.release.bind(containmentProvider),
      { scope, profileId, idempotencyKey, originalOperationId: operationReceipt.operationId },
      operationTimeoutMs, "containment-release", clock
    );
    let releaseReceipt = null;
    if (exactOutcome(release.value, "released", true) &&
        validateOperationReceipt(release.value.receipt, {
          providerId, action, scope, profileId, idempotencyKey,
          now: assertTimestamp(clock(), "release receipt clock"), expectedState: "released"
        })) {
      releaseReceipt = Object.freeze({ ...release.value.receipt });
    } else {
      const reconcile = await invokeBounded(
        containmentProvider.reconcileRelease.bind(containmentProvider),
        { scope, profileId, idempotencyKey, originalOperationId: operationReceipt.operationId },
        operationTimeoutMs, "release-reconciliation", clock
      );
      if (exactOutcome(reconcile.value, "not-applied")) {
        return finishNotApplied({
          action, scope, profileId, claimId, reservationId, authorization,
          reason: "provider-confirmed-release-not-applied"
        });
      }
      if (!exactOutcome(reconcile.value, "released", true) ||
          !validateOperationReceipt(reconcile.value.receipt, {
            providerId, action, scope, profileId, idempotencyKey,
            now: assertTimestamp(clock(), "release reconciliation clock"), expectedState: "released"
          })) {
        return finishUnknown({
          action, scope, profileId, claimId, reservationId, authorization,
          reason: "release-outcome-unknown", operationReceipt
        });
      }
      releaseReceipt = Object.freeze({ ...reconcile.value.receipt });
    }

    const verification = await invokeBounded(
      independentVerifier.verifyRelease.bind(independentVerifier),
      { scope, profileId, operationReceipt: releaseReceipt, evidenceRefs },
      operationTimeoutMs, "independent-release-verification", clock
    );
    if (!validateIndependentVerification(verification.value, {
      verifierId, scope, profileId, expectedState: "released",
      operationId: releaseReceipt.operationId,
      evidenceRefs, now: assertTimestamp(clock(), "release verification clock")
    })) {
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "independent-release-verification-failed", operationReceipt: releaseReceipt
      });
    }

    const releaseVerification = Object.freeze({ ...verification.value });
    // Release is a high-impact mutation too: recheck current policy and stop controls
    // after independent verification so a revoked approval cannot finalize success.
    const finalReleaseAuthorization = await assertAuthorization(
      authorization, action, scope, profileId
    );
    const finalReleaseMutation = await assertMutationAllowed(
      scope, action, "before-release-finalization"
    );
    if (!finalReleaseAuthorization || !finalReleaseMutation) {
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "authorization-or-mutation-control-changed-after-release",
        operationReceipt: releaseReceipt
      });
    }

    const budgetOkay = await settleBudget(reservationId, "succeeded");
    const authorizationOkay = await completeAuthorization(authorization, "succeeded");
    const auditOkay = await appendAudit({
      action, scope, profileId, outcome: "released",
      operationId: releaseReceipt.operationId, verifierId
    });
    const actionOkay = await completeAction(
      claimId,
      budgetOkay && authorizationOkay && auditOkay ? "succeeded" : "held-for-reconciliation",
      budgetOkay && authorizationOkay && auditOkay ? null : "release-finalization-incomplete"
    );
    if (!budgetOkay || !actionOkay || !authorizationOkay || !auditOkay) {
      return makeResult("held-for-reconciliation", "release-finalization-incomplete", {
        operationReceipt: releaseReceipt
      });
    }

    record.state = "released";
    const result = Object.freeze({
      schema: "jb.resilience.a2-execution-result/v1",
      capability: "A2-bounded-containment",
      state: "released",
      executed: true,
      verified: true,
      authorizationGranted: true,
      reason: null,
      scope,
      profileId,
      operationReceipt: releaseReceipt,
      verification: releaseVerification,
      forensicReceipt: preservedReceipt,
      idempotencyKey
    });
    containmentResults.set(result, {
      state: "released", scope, profileId, operationReceipt: releaseReceipt, evidenceRefs
    });
    return result;
  }

  async function executeContainment(input = {}) {
    let ledgerAttempted = false;
    let providerStartRecorded = false;
    try {
      return await runContainment(
        input,
        () => { ledgerAttempted = true; },
        () => { providerStartRecorded = true; }
      );
    } catch {
      const held = ledgerAttempted || providerStartRecorded;
      return makeResult(
        held ? "held-for-reconciliation" : "denied",
        held ? "a2-ledger-or-post-start-execution-state-unknown"
          : "a2-execution-prerequisite-failed"
      );
    }
  }

  async function releaseContainment(input = {}) {
    let ledgerAttempted = false;
    let providerStartRecorded = false;
    try {
      return await runReleaseContainment(
        input,
        () => { ledgerAttempted = true; },
        () => { providerStartRecorded = true; }
      );
    } catch {
      const held = ledgerAttempted || providerStartRecorded;
      return makeResult(
        held ? "held-for-reconciliation" : "denied",
        held ? "a2-ledger-or-post-start-release-state-unknown"
          : "a2-release-prerequisite-failed"
      );
    }
  }

  return Object.freeze({
    engine: "JB Resilience Engine",
    module: "A2 Containment Controller",
    version: "1.0.0-lab",
    enabled: enableExecution,
    providerId,
    verifierId,
    executeContainment,
    releaseContainment
  });
}
