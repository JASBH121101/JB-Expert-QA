import { createHmac, randomUUID } from "node:crypto";
import {
  validateAuthenticationAttemptV1,
  toAuthenticationDecisionV1,
  validateSecurityEventV1
} from "./core-contract-v1.js";

const SAFE_IDENTIFIER = /^[A-Za-z0-9:_-]{1,96}$/;
const SAFE_KEY_ID = /^[A-Za-z0-9:_-]{1,64}$/;
const OPERATIONS = new Set([
  "login", "password_reset", "account_recovery", "mfa_challenge", "session_refresh"
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeAuthCoreContract(value, secret) {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new TypeError("coreContract must be an object");
  const allowed = new Set([
    "tenantId", "applicationId", "operation", "accountKeyId", "clientKeyId"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError("Unknown authentication Core option: " + key);
  }

  for (const key of ["tenantId", "applicationId"]) {
    if (typeof value[key] !== "string" || !SAFE_IDENTIFIER.test(value[key])) {
      throw new TypeError("coreContract." + key + " must be a safe identifier");
    }
  }
  const operation = value.operation ?? "login";
  if (!OPERATIONS.has(operation)) {
    throw new TypeError("coreContract.operation is not a supported authentication operation");
  }
  const accountKeyId = value.accountKeyId;
  const clientKeyId = value.clientKeyId ?? accountKeyId;
  if (typeof accountKeyId !== "string" || !SAFE_KEY_ID.test(accountKeyId)) {
    throw new TypeError("coreContract.accountKeyId must be a safe key identifier");
  }
  if (typeof clientKeyId !== "string" || !SAFE_KEY_ID.test(clientKeyId)) {
    throw new TypeError("coreContract.clientKeyId must be a safe key identifier");
  }

  const secretBytes = Buffer.isBuffer(secret)
    ? Buffer.from(secret)
    : typeof secret === "string" ? Buffer.from(secret, "utf8") : null;
  if (!secretBytes || secretBytes.length < 32) {
    throw new TypeError("Core v1 authentication requires at least 32 bytes of stable keySecret/secret material");
  }

  return Object.freeze({
    tenantId: value.tenantId,
    applicationId: value.applicationId,
    operation,
    accountKeyId,
    clientKeyId,
    secret: secretBytes
  });
}

function deriveCoreKey(core, type, sourceDigest) {
  // Scope and tenant separation are applied after the runtime's existing HMAC,
  // so raw account names and client addresses never cross this boundary.
  return createHmac("sha256", core.secret)
    .update("jb.security.authentication.identity/v1").update("\0")
    .update(core.tenantId).update("\0")
    .update(core.applicationId).update("\0")
    .update(type).update("\0")
    .update(sourceDigest ?? "anonymous-subject")
    .digest("hex");
}

function clampRetryAfter(seconds) {
  if (!Number.isFinite(seconds) || seconds < 1) return 1;
  return Math.min(3600, Math.ceil(seconds));
}

export function createAuthCoreAttempt(core, {
  attemptId,
  occurredAtMs,
  outcome,
  accountDigest,
  clientDigest
}) {
  if (!core) return null;
  const accountKey = deriveCoreKey(core, "account", accountDigest);
  const clientKey = clientDigest === null || clientDigest === undefined
    ? null
    : deriveCoreKey(core, "client", clientDigest);

  return validateAuthenticationAttemptV1({
    schema: "jb.security.authentication.attempt/v1",
    attemptId,
    tenantId: core.tenantId,
    applicationId: core.applicationId,
    operation: core.operation,
    outcome,
    occurredAtMs,
    account: {
      key: accountKey,
      keyId: core.accountKeyId
    },
    client: clientKey === null
      ? { key: null, keyId: null }
      : { key: clientKey, keyId: core.clientKeyId }
  });
}

export function createAuthCoreDecision(attemptId, {
  blocked = false,
  enforced = false,
  retryAfterSeconds = null,
  unavailable = false
} = {}) {
  if (unavailable) {
    return toAuthenticationDecisionV1(attemptId, {
      outcome: "unavailable",
      enforced: true,
      status: 503,
      retryAfterSeconds: 5
    });
  }
  if (blocked && enforced) {
    return toAuthenticationDecisionV1(attemptId, {
      outcome: "deny",
      enforced: true,
      status: 429,
      retryAfterSeconds: clampRetryAfter(retryAfterSeconds)
    });
  }
  if (blocked) {
    return toAuthenticationDecisionV1(attemptId, {
      outcome: "monitor",
      enforced: false,
      status: null,
      retryAfterSeconds: clampRetryAfter(retryAfterSeconds)
    });
  }
  return toAuthenticationDecisionV1(attemptId, {
    outcome: "allow",
    enforced: false,
    status: null,
    retryAfterSeconds: null
  });
}

export function createAuthCoreEvent(core, attempt, {
  occurredAtMs,
  unavailable = false,
  enforced = false,
  scopes = []
}) {
  if (!core || (!unavailable && scopes.length === 0)) return null;
  const blocked = !unavailable && enforced;
  return validateSecurityEventV1({
    schema: "jb.security.event/v1",
    eventId: randomUUID(),
    occurredAtMs,
    tenantId: core.tenantId,
    applicationId: core.applicationId,
    producer: "security-guard-node",
    category: "authentication",
    ruleId: unavailable ? "JBG-AUTH-STORE-001" : "JBG-AUTH-BRUTE-001",
    severity: unavailable ? "critical" : "high",
    action: unavailable ? "rejected" : blocked ? "blocked" : "observed",
    outcome: unavailable ? "unavailable" : blocked ? "denied" : "observed",
    subjectKey: attempt.account.key,
    subjectKeyId: attempt.account.keyId,
    scope: scopes.length ? scopes.join("_") : "auth_store",
    correlationId: attempt.attemptId
  });
}

export function safelyEmitAuthCore(callback, value) {
  if (typeof callback !== "function" || value === null || value === undefined) return;
  try {
    const result = callback(value);
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch {
    // Contract telemetry must never change authentication enforcement.
  }
}

export function publishAuthCore(core, callbacks, input) {
  if (!core) return null;
  const attempt = createAuthCoreAttempt(core, input);
  const decision = createAuthCoreDecision(attempt.attemptId, input.decision);
  const event = createAuthCoreEvent(core, attempt, {
    occurredAtMs: input.occurredAtMs,
    unavailable: input.decision?.unavailable ?? false,
    enforced: input.decision?.enforced ?? false,
    scopes: input.eventScopes ?? []
  });
  safelyEmitAuthCore(callbacks.onCoreAttempt, attempt);
  safelyEmitAuthCore(callbacks.onCoreDecision, Object.freeze({ attempt, decision }));
  safelyEmitAuthCore(callbacks.onCoreEvent, event);
  return Object.freeze({ attempt, decision, event });
}
