import { createHash } from "node:crypto";

const SCOPE_KEYS = Object.freeze([
  "assetId", "environment", "incidentId", "policyId", "policyRevision", "policyHash"
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RECORD_KEYS = [
  "schema", "claimId", "action", "scope", "profileId", "providerId",
  "verifierId", "recorderId", "idempotencyKey", "state",
  "originalOperationId", "evidenceRefs", "createdAtMs",
  "updatedAtMs", "leaseExpiresAtMs"
];

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be a plain data object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(label + " must be a plain data object");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(label + " must not contain symbols");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new TypeError(label + " has missing or unsupported fields");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " must contain enumerable data properties only");
    }
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(label + " is invalid");
  }
  return value;
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(label + " is invalid");
  }
  return value;
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

function normalizeScope(input) {
  exactKeys(input, SCOPE_KEYS, "A2 recovery scope");
  const scope = Object.create(null);
  for (const key of SCOPE_KEYS) {
    const value = input[key];
    if (key === "policyRevision") {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError("policyRevision is invalid");
      }
    } else if (key === "policyHash") {
      if (typeof value !== "string" || !SHA256.test(value)) {
        throw new TypeError("policyHash is invalid");
      }
    } else {
      assertIdentifier(value, key);
    }
    scope[key] = value;
  }
  return Object.freeze(scope);
}

function normalizeEvidenceRefs(input) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length < 1 || input.length > 128 ||
      Object.getOwnPropertySymbols(input).length !== 0 ||
      Reflect.ownKeys(input).length !== input.length + 1) {
    throw new TypeError("evidenceRefs must be a dense plain array with 1 to 128 entries");
  }
  const seen = new Set();
  const refs = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("evidenceRefs must not contain holes or accessors");
    }
    const item = descriptor.value;
    exactKeys(item, ["refId", "sha256"], "A2 evidence reference");
    const refId = assertIdentifier(item.refId, "evidence refId");
    if (typeof item.sha256 !== "string" || !SHA256.test(item.sha256) || seen.has(refId)) {
      throw new TypeError("evidence reference digest or identity is invalid");
    }
    seen.add(refId);
    refs.push(Object.freeze({ refId, sha256: item.sha256 }));
  }
  return Object.freeze(refs);
}

function normalizeRecord(input, dependencies) {
  exactKeys(input, RECORD_KEYS, "A2 durable recovery record");
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
  const createdAtMs = assertTimestamp(input.createdAtMs, "createdAtMs");
  const updatedAtMs = assertTimestamp(input.updatedAtMs, "updatedAtMs");
  const leaseExpiresAtMs = assertTimestamp(input.leaseExpiresAtMs, "leaseExpiresAtMs");
  if (updatedAtMs < createdAtMs) throw new TypeError("A2 recovery record timestamps are inconsistent");
  return Object.freeze({
    schema: input.schema,
    claimId,
    action,
    scope,
    profileId,
    providerId,
    verifierId,
    recorderId,
    idempotencyKey,
    state: input.state,
    originalOperationId,
    evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs),
    createdAtMs,
    updatedAtMs,
    leaseExpiresAtMs
  });
}

function referencesDigest(evidenceRefs) {
  return createHash("sha256").update(canonical(evidenceRefs), "utf8").digest("hex");
}

function validOperationReceipt(value, record, expectedState, now) {
  try {
    exactKeys(value, [
      "schema", "providerId", "operationId", "action", "idempotencyKey",
      "profileId", ...SCOPE_KEYS, "state", "occurredAtMs"
    ], "A2 recovery operation receipt");
  } catch {
    return false;
  }
  return value.schema === "jb.resilience.a2-operation-receipt/v1" &&
    value.providerId === record.providerId &&
    typeof value.operationId === "string" && IDENTIFIER.test(value.operationId) &&
    value.action === record.action &&
    value.idempotencyKey === record.idempotencyKey &&
    value.profileId === record.profileId &&
    SCOPE_KEYS.every((key) => value[key] === record.scope[key]) &&
    value.state === expectedState &&
    Number.isSafeInteger(value.occurredAtMs) &&
    value.occurredAtMs >= record.createdAtMs &&
    value.occurredAtMs <= now;
}

function validVerification(value, record, operationReceipt, expectedState, now) {
  try {
    exactKeys(value, [
      "schema", "verifierId", "verified", "state", "profileId",
      "operationId", "referencesSha256", ...SCOPE_KEYS,
      "observedAtMs", "expiresAtMs"
    ], "A2 recovery verification");
  } catch {
    return false;
  }
  return value.schema === "jb.resilience.a2-verification/v1" &&
    value.verifierId === record.verifierId &&
    value.verified === true &&
    value.state === expectedState &&
    value.profileId === record.profileId &&
    value.operationId === operationReceipt.operationId &&
    value.referencesSha256 === referencesDigest(record.evidenceRefs) &&
    SCOPE_KEYS.every((key) => value[key] === record.scope[key]) &&
    Number.isSafeInteger(value.observedAtMs) &&
    value.observedAtMs >= record.createdAtMs &&
    value.observedAtMs <= now &&
    Number.isSafeInteger(value.expiresAtMs) &&
    value.expiresAtMs > now;
}

function validForensicReceipt(value, record, operationReceipt, now) {
  try {
    exactKeys(value, [
      "schema", "recorderId", "retained", ...SCOPE_KEYS, "evidenceIds",
      "retentionPolicyId", "preservedAtMs", "expiresAtMs",
      "referencesSha256", "operationId"
    ], "A2 recovery forensic receipt");
  } catch {
    return false;
  }
  const ids = value.evidenceIds;
  if (!Array.isArray(ids) || Object.getPrototypeOf(ids) !== Array.prototype ||
      ids.length < 1 || ids.length > 128 ||
      Object.getOwnPropertySymbols(ids).length !== 0 ||
      Reflect.ownKeys(ids).length !== ids.length + 1) return false;
  const seen = new Set();
  for (let index = 0; index < ids.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(ids, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string" || !IDENTIFIER.test(descriptor.value) ||
        seen.has(descriptor.value)) return false;
    seen.add(descriptor.value);
  }
  return value.schema === "jb.resilience.a2-forensic-receipt/v1" &&
    value.recorderId === record.recorderId &&
    value.retained === true &&
    value.operationId === operationReceipt.operationId &&
    value.referencesSha256 === referencesDigest(record.evidenceRefs) &&
    SCOPE_KEYS.every((key) => value[key] === record.scope[key]) &&
    typeof value.retentionPolicyId === "string" &&
    IDENTIFIER.test(value.retentionPolicyId) &&
    Number.isSafeInteger(value.preservedAtMs) &&
    value.preservedAtMs >= record.createdAtMs &&
    value.preservedAtMs <= now &&
    Number.isSafeInteger(value.expiresAtMs) &&
    value.expiresAtMs > now;
}

function contentBytes(content) {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (content instanceof ArrayBuffer) return Buffer.from(content);
  if (ArrayBuffer.isView(content)) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  }
  throw new TypeError("evidence resolver must return UTF-8 text or binary bytes");
}

async function invokeBounded(owner, method, input, timeoutMs, label) {
  const controller = new AbortController();
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
      Promise.resolve().then(() => owner[method]({
        ...input,
        deadlineMs: input.atMs + timeoutMs,
        signal: controller.signal
      })),
      timeout
    ]);
    return { value, timedOut: false };
  } catch {
    return { value: null, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function held(claimId, reason, details = {}) {
  return Object.freeze({
    schema: "jb.resilience.a2-recovery-finding/v1",
    claimId,
    state: "held-for-reconciliation",
    safeToRetry: false,
    executable: false,
    releaseAllowed: false,
    reason,
    ...details
  });
}

/**
 * Builds a read-only A2 restart reconciliation coordinator.
 *
 * It may list and re-fetch durable pending records, query provider state,
 * resolve evidence bytes, independently verify state and inspect retention.
 * It has no apply, release, policy-authority, claim, settle, completion or
 * journal-write dependency. A finding is evidence for a separate approval
 * workflow, never an execution handle or permission to retry/release.
 */
export function createA2RecoveryCoordinator({
  journal,
  containmentProvider,
  independentVerifier,
  forensicRecorder,
  evidenceResolver,
  clock = Date.now,
  operationTimeoutMs = 5_000,
  pageSize = 25,
  maxPages = 20
} = {}) {
  if (!journal || journal.durable !== true ||
      typeof journal.listPending !== "function" ||
      typeof journal.getPendingByClaimId !== "function") {
    throw new TypeError("a durable read-only A2 recovery journal is required");
  }
  if (!containmentProvider ||
      containmentProvider.reconciliationReadOnly !== true ||
      typeof containmentProvider.reconcile !== "function" ||
      typeof containmentProvider.reconcileRelease !== "function") {
    throw new TypeError("a read-only containment reconciliation adapter is required");
  }
  if (!independentVerifier || typeof independentVerifier.verifyContainment !== "function" ||
      typeof independentVerifier.verifyRelease !== "function") {
    throw new TypeError("an independent A2 verifier is required");
  }
  if (!forensicRecorder || typeof forensicRecorder.lookupRetention !== "function") {
    throw new TypeError("a read-only forensic retention lookup is required");
  }
  if (!evidenceResolver || typeof evidenceResolver.resolve !== "function") {
    throw new TypeError("a read-only evidence resolver is required");
  }
  if (typeof clock !== "function" ||
      !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 100 || operationTimeoutMs > 30_000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new TypeError("A2 recovery bounds are invalid");
  }

  const providerId = assertIdentifier(containmentProvider.providerId, "providerId");
  const verifierId = assertIdentifier(independentVerifier.verifierId, "verifierId");
  const recorderId = assertIdentifier(forensicRecorder.recorderId, "recorderId");
  if (providerId === verifierId) {
    throw new TypeError("provider and independent verifier identities must differ");
  }

  async function inspectRecord(record, now) {
    // A claimed record proves only that the host reserved an action. Without
    // the durable provider-start marker, no provider call is inferred or retried.
    if (record.state === "claimed") {
      return held(record.claimId, "provider-start-not-marked-no-provider-call-authorized", {
        providerQuerySkipped: true,
        leaseExpired: record.leaseExpiresAtMs <= now
      });
    }
    const method = record.action === "apply-containment-profile" ? "reconcile" : "reconcileRelease";
    const providerCall = await invokeBounded(containmentProvider, method, {
      scope: record.scope,
      profileId: record.profileId,
      idempotencyKey: record.idempotencyKey,
      ...(record.action === "release-containment"
        ? { originalOperationId: record.originalOperationId } : {}),
      atMs: now
    }, operationTimeoutMs, "provider-reconciliation");
    if (providerCall.timedOut || !providerCall.value || typeof providerCall.value !== "object") {
      return held(record.claimId, "provider-reconciliation-unavailable");
    }

    const expectedOutcome = record.action === "apply-containment-profile" ? "applied" : "released";
    const expectedState = record.action === "apply-containment-profile" ? "contained" : "released";
    let providerResult;
    try {
      exactKeys(providerCall.value, ["outcome", "receipt"], "A2 provider reconciliation response");
      providerResult = providerCall.value;
    } catch {
      try {
        exactKeys(providerCall.value, ["outcome"], "A2 provider reconciliation response");
        if (providerCall.value.outcome === "not-applied") {
          return held(record.claimId, "provider-confirmed-not-applied-no-retry-authorized", {
            providerOutcome: "not-applied"
          });
        }
      } catch {
        // Any malformed or unknown response remains held.
      }
      return held(record.claimId, "provider-outcome-unknown-or-malformed");
    }

    if (providerResult.outcome !== expectedOutcome ||
        !validOperationReceipt(providerResult.receipt, record, expectedState, now)) {
      return held(record.claimId, "provider-receipt-invalid-or-outcome-unknown");
    }
    const operationReceipt = Object.freeze({ ...providerResult.receipt });

    for (const ref of record.evidenceRefs) {
      const resolved = await invokeBounded(evidenceResolver, "resolve", {
        refId: ref.refId,
        expectedSha256: ref.sha256,
        scope: record.scope,
        profileId: record.profileId,
        atMs: assertTimestamp(clock(), "evidence resolution clock")
      }, operationTimeoutMs, "evidence-resolution");
      if (resolved.timedOut) return held(record.claimId, "evidence-resolution-timeout");
      try {
        exactKeys(resolved.value, ["refId", "content"], "A2 resolved evidence");
        if (resolved.value.refId !== ref.refId ||
            createHash("sha256").update(contentBytes(resolved.value.content)).digest("hex") !== ref.sha256) {
          return held(record.claimId, "evidence-reference-digest-mismatch");
        }
      } catch {
        return held(record.claimId, "evidence-reference-resolution-invalid");
      }
    }

    const verifierMethod = record.action === "apply-containment-profile"
      ? "verifyContainment" : "verifyRelease";
    const verificationCall = await invokeBounded(independentVerifier, verifierMethod, {
      action: record.action,
      scope: record.scope,
      profileId: record.profileId,
      operationReceipt,
      evidenceRefs: record.evidenceRefs,
      atMs: assertTimestamp(clock(), "verification clock")
    }, operationTimeoutMs, "independent-verification");
    const verifiedAt = assertTimestamp(clock(), "verification validation clock");
    if (verificationCall.timedOut || !validVerification(
      verificationCall.value, record, operationReceipt, expectedState, verifiedAt
    )) {
      return held(record.claimId, "independent-verification-failed", {
        operationId: operationReceipt.operationId
      });
    }

    const forensicCall = await invokeBounded(forensicRecorder, "lookupRetention", {
      scope: record.scope,
      profileId: record.profileId,
      operationId: operationReceipt.operationId,
      evidenceRefs: record.evidenceRefs,
      atMs: assertTimestamp(clock(), "forensic lookup clock")
    }, operationTimeoutMs, "forensic-retention-lookup");
    const forensicAt = assertTimestamp(clock(), "forensic receipt validation clock");
    if (forensicCall.timedOut ||
        !validForensicReceipt(forensicCall.value, record, operationReceipt, forensicAt)) {
      return held(record.claimId, "forensic-retention-not-independently-confirmed", {
        operationId: operationReceipt.operationId
      });
    }

    return Object.freeze({
      schema: "jb.resilience.a2-recovery-finding/v1",
      claimId: record.claimId,
      state: record.action === "apply-containment-profile"
        ? "contained-observed-and-verified" : "released-observed-and-verified",
      safeToRetry: false,
      executable: false,
      releaseAllowed: false,
      reason: null,
      action: record.action,
      scope: record.scope,
      profileId: record.profileId,
      idempotencyKey: record.idempotencyKey,
      operationReceipt,
      verification: Object.freeze({ ...verificationCall.value }),
      forensicReceipt: Object.freeze({
        ...forensicCall.value,
        evidenceIds: Object.freeze([...forensicCall.value.evidenceIds])
      }),
      leaseExpired: record.leaseExpiresAtMs <= now
    });
  }

  async function reconcilePending() {
    const startedAtMs = assertTimestamp(clock(), "A2 recovery scan clock");
    const findings = [];
    const seenClaims = new Set();
    const seenCursors = new Set();
    let cursor = null;
    let pagesRead = 0;
    let complete = true;

    while (pagesRead < maxPages) {
      const page = await invokeBounded(journal, "listPending", {
        cursor, limit: pageSize, atMs: assertTimestamp(clock(), "A2 journal page clock")
      }, operationTimeoutMs, "journal-list-pending");
      if (page.timedOut) {
        findings.push(held("journal", "durable-journal-list-unavailable"));
        complete = false;
        break;
      }
      let claimIds;
      let nextCursor;
      try {
        exactKeys(page.value, ["claimIds", "nextCursor"], "A2 pending journal page");
        claimIds = page.value.claimIds;
        nextCursor = page.value.nextCursor;
        if (!Array.isArray(claimIds) || Object.getPrototypeOf(claimIds) !== Array.prototype ||
            claimIds.length > pageSize || Object.getOwnPropertySymbols(claimIds).length !== 0 ||
            Reflect.ownKeys(claimIds).length !== claimIds.length + 1) {
          throw new TypeError("invalid claim ID page");
        }
        if (nextCursor !== null &&
            (typeof nextCursor !== "string" || nextCursor.length < 1 || nextCursor.length > 256)) {
          throw new TypeError("invalid next cursor");
        }
      } catch {
        findings.push(held("journal", "durable-journal-page-invalid"));
        complete = false;
        break;
      }

      pagesRead += 1;
      for (let index = 0; index < claimIds.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(claimIds, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          findings.push(held("journal", "claim-id-page-contains-accessor-or-hole"));
          complete = false;
          continue;
        }
        let claimId;
        try {
          claimId = assertIdentifier(descriptor.value, "claimId");
        } catch {
          findings.push(held("journal", "claim-id-invalid"));
          complete = false;
          continue;
        }
        if (seenClaims.has(claimId)) {
          findings.push(held(claimId, "duplicate-pending-claim-reference"));
          complete = false;
          continue;
        }
        seenClaims.add(claimId);

        const recordCall = await invokeBounded(journal, "getPendingByClaimId", {
          claimId,
          atMs: assertTimestamp(clock(), "A2 exact journal lookup clock")
        }, operationTimeoutMs, "journal-exact-lookup");
        if (recordCall.timedOut) {
          findings.push(held(claimId, "durable-journal-exact-lookup-unavailable"));
          complete = false;
          continue;
        }
        let record;
        try {
          exactKeys(recordCall.value, ["found", "record"], "A2 exact journal lookup");
          if (recordCall.value.found !== true || recordCall.value.record === null) {
            throw new TypeError("pending journal record disappeared");
          }
          record = normalizeRecord(recordCall.value.record, {
            providerId, verifierId, recorderId
          });
          if (record.claimId !== claimId) throw new TypeError("claim ID lookup mismatch");
        } catch {
          findings.push(held(claimId, "durable-journal-record-missing-or-invalid"));
          complete = false;
          continue;
        }

        const finding = await inspectRecord(record, assertTimestamp(clock(), "A2 provider inspection clock"));
        findings.push(finding);
        if (finding.state === "held-for-reconciliation") complete = false;
      }

      if (nextCursor === null) break;
      if (seenCursors.has(nextCursor) || nextCursor === cursor) {
        findings.push(held("journal", "journal-cursor-cycle-detected"));
        complete = false;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (pagesRead === maxPages) {
        findings.push(held("journal", "journal-scan-page-limit-reached"));
        complete = false;
      }
    }

    return Object.freeze({
      schema: "jb.resilience.a2-recovery-report/v1",
      startedAtMs,
      finishedAtMs: assertTimestamp(clock(), "A2 recovery completion clock"),
      pagesRead,
      recordsRead: seenClaims.size,
      complete,
      executable: false,
      safeToRetry: false,
      releaseAllowed: false,
      findings: Object.freeze(findings)
    });
  }

  return Object.freeze({
    engine: "JB Resilience Engine",
    module: "A2 Read-only Recovery Coordinator",
    version: "1.0.0-lab",
    reconcilePending
  });
}
