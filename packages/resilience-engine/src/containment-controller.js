import { createHash } from "node:crypto";
import { getA2ProviderReadinessMetadata } from "./provider-evidence.js";

const SCOPE_KEYS = Object.freeze([
  "assetId", "environment", "incidentId", "policyId", "policyRevision", "policyHash"
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTAINMENT_RESULTS = new WeakMap();

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

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(label + " is invalid");
  }
  return value;
}

function normalizeEvidenceRefs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128 ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.keys(value).length !== value.length) {
    throw new TypeError("evidenceRefs must contain between 1 and 128 exact references");
  }
  const seen = new Set();
  return Object.freeze(value.map((entry) => {
    exactKeys(entry, ["refId", "sha256"], "evidence reference");
    const refId = assertIdentifier(entry.refId, "evidence refId");
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256) || seen.has(refId)) {
      throw new TypeError("evidence reference digest or identity is invalid");
    }
    seen.add(refId);
    return Object.freeze({ refId, sha256: entry.sha256 });
  }));
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
      !Number.isSafeInteger(value.expiresAtMs) ||
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
  verifierId, scope, profileId, expectedState, now
}) {
  try {
    exactKeys(value, [
      "schema", "verifierId", "verified", "state", "profileId",
      ...SCOPE_KEYS, "observedAtMs", "expiresAtMs"
    ], "A2 independent verification");
  } catch {
    return false;
  }
  return value.schema === "jb.resilience.a2-verification/v1" &&
    value.verifierId === verifierId &&
    value.verified === true &&
    value.state === expectedState &&
    value.profileId === profileId &&
    sameScope(value, scope) &&
    Number.isSafeInteger(value.observedAtMs) &&
    value.observedAtMs >= 0 &&
    value.observedAtMs <= now &&
    Number.isSafeInteger(value.expiresAtMs) &&
    value.expiresAtMs >= 0 &&
    value.expiresAtMs > now;
}

function validateForensicReceipt(value, recorderId, scope, now) {
  try {
    exactKeys(value, [
      "schema", "recorderId", "retained", ...SCOPE_KEYS, "evidenceIds",
      "retentionPolicyId", "preservedAtMs", "expiresAtMs"
    ], "A2 forensic receipt");
  } catch {
    return false;
  }
  return value.schema === "jb.resilience.a2-forensic-receipt/v1" &&
    value.recorderId === recorderId &&
    value.retained === true &&
    sameScope(value, scope) &&
    Array.isArray(value.evidenceIds) &&
    value.evidenceIds.length > 0 &&
    value.evidenceIds.length <= 128 &&
    Object.getOwnPropertySymbols(value.evidenceIds).length === 0 &&
    Object.keys(value.evidenceIds).length === value.evidenceIds.length &&
    value.evidenceIds.every((id) => typeof id === "string" && IDENTIFIER.test(id)) &&
    new Set(value.evidenceIds).size === value.evidenceIds.length &&
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
    [budgetLedger, ["reserve", "settle"], "budgetLedger"],
    [actionLedger, ["claim", "complete"], "actionLedger"],
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
  if (providerId === verifierId) {
    throw new TypeError("containment executor and independent verifier must have distinct identities");
  }

  async function appendAudit(entry) {
    try {
      return successful(await auditStore.append(Object.freeze({
        schema: "jb.resilience.a2-audit-event/v1",
        atMs: assertTimestamp(clock(), "audit clock"),
        providerId,
        verifierId,
        ...entry
      })), "recorded");
    } catch {
      return false;
    }
  }

  async function assertMutationAllowed(scope, action, phase) {
    try {
      return successful(await mutationControl.assertAllowed({ scope, action, phase }), "allowed");
    } catch {
      return false;
    }
  }

  async function authorize(action, scope, profileId, reasonCode) {
    let issued;
    try {
      issued = await policyAuthority.authorize({
        schema: "jb.resilience.a2-authorization-request/v1",
        action,
        scope,
        profileId,
        reasonCode
      });
    } catch {
      return null;
    }
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
      return successful(await policyAuthority.assertAuthorization({
        authorization, action, scope, profileId
      }), "valid");
    } catch {
      return false;
    }
  }

  async function completeAuthorization(authorization, outcome) {
    try {
      return successful(await policyAuthority.completeAuthorization({ authorization, outcome }), "recorded");
    } catch {
      return false;
    }
  }

  async function settleBudget(reservationId, outcome) {
    if (typeof reservationId !== "string") return true;
    try {
      return successful(await budgetLedger.settle({
        reservationId, outcome, atMs: assertTimestamp(clock(), "budget clock")
      }), "settled");
    } catch {
      return false;
    }
  }

  async function completeAction(claimId, outcome, reason) {
    try {
      return successful(await actionLedger.complete({
        claimId, outcome, reason,
        completedAtMs: assertTimestamp(clock(), "action completion clock")
      }), "completed");
    } catch {
      return false;
    }
  }

  async function reserveResources(action, scope, profileId, idempotencyKey) {
    const now = assertTimestamp(clock(), "resource reservation clock");
    let claim;
    try {
      claim = await actionLedger.claim({
        action, scope, profileId, idempotencyKey,
        claimedAtMs: now,
        expiresAtMs: now + operationTimeoutMs * 8
      });
    } catch {
      claim = null;
    }
    try {
      exactKeys(claim, ["claimed", "claimId"], "A2 action claim");
    } catch {
      claim = null;
    }
    if (!isRecord(claim) || claim.claimed !== true ||
        typeof claim.claimId !== "string" || !IDENTIFIER.test(claim.claimId)) {
      return { ok: false, reason: "duplicate-or-unavailable-action-claim" };
    }
    let budget;
    try {
      budget = await budgetLedger.reserve({ action, scope, profileId, idempotencyKey, atMs: now });
    } catch {
      budget = null;
    }
    try {
      exactKeys(budget, ["reserved", "reservationId"], "A2 budget reservation");
    } catch {
      budget = null;
    }
    if (!isRecord(budget) || budget.reserved !== true ||
        typeof budget.reservationId !== "string" || !IDENTIFIER.test(budget.reservationId)) {
      const recorded = await completeAction(claim.claimId, "not-applied", "budget-reservation-denied");
      return { ok: false, reason: recorded ? "budget-reservation-denied" : "action-ledger-finalization-failed" };
    }
    return { ok: true, claimId: claim.claimId, reservationId: budget.reservationId };
  }

  async function finishNotApplied({
    action, scope, profileId, claimId, reservationId, authorization, reason
  }) {
    const budgetOkay = await settleBudget(reservationId, "not-applied");
    const actionOkay = await completeAction(claimId, "not-applied", reason);
    const authOkay = await completeAuthorization(authorization, "failed");
    const auditOkay = await appendAudit({
      action, scope, profileId, outcome: "not-applied", reason
    });
    return makeResult(budgetOkay && actionOkay && authOkay && auditOkay
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
      independentVerifier.verifyContainment,
      { action, scope, profileId, operationReceipt },
      operationTimeoutMs, "independent-verification", clock
    );
    const verifyNow = assertTimestamp(clock(), "verification clock");
    if (!validateIndependentVerification(verifyCall.value, {
      verifierId, scope, profileId, expectedState: "contained", now: verifyNow
    })) return { ok: false, reason: "independent-containment-verification-failed" };
    const verification = Object.freeze({ ...verifyCall.value });

    const preserveCall = await invokeBounded(
      forensicRecorder.preserveEvidence,
      { scope, profileId, evidenceRefs, retentionPolicyId: "owner-approved" },
      operationTimeoutMs, "forensic-preservation", clock
    );
    const preserveNow = assertTimestamp(clock(), "forensic clock");
    if (!validateForensicReceipt(preserveCall.value, recorderId, scope, preserveNow)) {
      return { ok: false, reason: "forensic-evidence-preservation-failed" };
    }
    const forensicReceipt = Object.freeze({
      ...preserveCall.value,
      evidenceIds: Object.freeze([...preserveCall.value.evidenceIds])
    });
    return { ok: true, verification, forensicReceipt };
  }

  async function executeContainment({ readiness, scope: rawScope, profileId, evidenceRefs } = {}) {
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

    const reserved = await reserveResources(action, scope, profileId, idempotencyKey);
    if (!reserved.ok) {
      await completeAuthorization(authorization, "failed");
      return makeResult("denied", reserved.reason);
    }
    const { claimId, reservationId } = reserved;

    if (!await appendAudit({
      action, scope, profileId, outcome: "resources-reserved", idempotencyKey
    })) {
      return finishNotApplied({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "durable-audit-unavailable-before-provider"
      });
    }

    const preflight = await invokeBounded(
      containmentProvider.preflight,
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

    const apply = await invokeBounded(
      containmentProvider.apply,
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
        containmentProvider.reconcile,
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
    const actionOkay = await completeAction(claimId, "succeeded", null);
    const authorizationOkay = await completeAuthorization(authorization, "succeeded");
    const auditOkay = await appendAudit({
      action, scope, profileId, outcome: "contained",
      operationId: operationReceipt.operationId,
      verifierId,
      forensicEvidenceCount: verified.forensicReceipt.evidenceIds.length
    });
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
    CONTAINMENT_RESULTS.set(result, {
      state: "contained", scope, profileId, operationReceipt, evidenceRefs: refs
    });
    return result;
  }

  async function releaseContainment({ containment, reasonCode } = {}) {
    if (!enableExecution) return makeResult("disabled", "a2-execution-disabled");
    const record = CONTAINMENT_RESULTS.get(containment);
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
    const reserved = await reserveResources(action, scope, profileId, idempotencyKey);
    if (!reserved.ok) {
      await completeAuthorization(authorization, "failed");
      return makeResult("denied", reserved.reason);
    }
    const { claimId, reservationId } = reserved;

    const current = await invokeBounded(
      independentVerifier.verifyContainment,
      { action: "verify-before-release", scope, profileId, operationReceipt },
      operationTimeoutMs, "pre-release-verification", clock
    );
    if (!validateIndependentVerification(current.value, {
      verifierId, scope, profileId, expectedState: "contained",
      now: assertTimestamp(clock(), "pre-release verification clock")
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
      forensicRecorder.preserveEvidence,
      { scope, profileId, evidenceRefs, retentionPolicyId: "owner-approved-before-release" },
      operationTimeoutMs, "pre-release-forensics", clock
    );
    if (!validateForensicReceipt(preserved.value, recorderId, scope,
        assertTimestamp(clock(), "pre-release forensic clock"))) {
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
    const release = await invokeBounded(
      containmentProvider.release,
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
        containmentProvider.reconcileRelease,
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
      independentVerifier.verifyRelease,
      { scope, profileId, operationReceipt: releaseReceipt },
      operationTimeoutMs, "independent-release-verification", clock
    );
    if (!validateIndependentVerification(verification.value, {
      verifierId, scope, profileId, expectedState: "released",
      now: assertTimestamp(clock(), "release verification clock")
    })) {
      return finishUnknown({
        action, scope, profileId, claimId, reservationId, authorization,
        reason: "independent-release-verification-failed", operationReceipt: releaseReceipt
      });
    }

    const releaseVerification = Object.freeze({ ...verification.value });
    const budgetOkay = await settleBudget(reservationId, "succeeded");
    const actionOkay = await completeAction(claimId, "succeeded", null);
    const authorizationOkay = await completeAuthorization(authorization, "succeeded");
    const auditOkay = await appendAudit({
      action, scope, profileId, outcome: "released",
      operationId: releaseReceipt.operationId, verifierId
    });
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
    CONTAINMENT_RESULTS.set(result, {
      state: "released", scope, profileId, operationReceipt: releaseReceipt, evidenceRefs
    });
    return result;
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
