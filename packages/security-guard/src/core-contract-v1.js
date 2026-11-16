const IDENTIFIER = /^[A-Za-z0-9:_-]{1,96}$/;
const KEY_ID = /^[A-Za-z0-9:_-]{1,64}$/;
const HMAC_KEY = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY_TYPES = new Set(["ip", "account", "account_ip", "session", "anonymous"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field: ${key}`);
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`${label} must be a 1-96 character safe identifier`);
  }
  return value;
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value;
}

/**
 * Validate a language-neutral rate-limit check request (Core contract v1).
 * Identity keys must be HMAC-SHA-256 digests created by trusted server code.
 * Raw IPs, account IDs, cookies, tokens and browser-supplied identities are rejected.
 */
export function validateRateLimitCheckV1(value) {
  if (!record(value)) throw new TypeError("rate-limit check must be an object");
  exactKeys(value, new Set([
    "schema", "requestId", "tenantId", "applicationId", "policyId", "scope", "identity"
  ]), "rate-limit check");
  if (value.schema !== "jb.security.rate-limit.check/v1") {
    throw new TypeError("unsupported rate-limit check schema");
  }
  uuid(value.requestId, "requestId");
  identifier(value.tenantId, "tenantId");
  identifier(value.applicationId, "applicationId");
  identifier(value.policyId, "policyId");
  identifier(value.scope, "scope");

  if (!record(value.identity)) throw new TypeError("identity must be an object");
  exactKeys(value.identity, new Set(["type", "key", "keyId"]), "identity");
  if (!IDENTITY_TYPES.has(value.identity.type)) throw new TypeError("unsupported identity type");
  if (typeof value.identity.key !== "string" || !HMAC_KEY.test(value.identity.key)) {
    throw new TypeError("identity.key must be a lowercase HMAC-SHA-256 digest");
  }
  if (typeof value.identity.keyId !== "string" || !KEY_ID.test(value.identity.keyId)) {
    throw new TypeError("identity.keyId must be a safe key identifier");
  }
  return Object.freeze({
    ...value,
    identity: Object.freeze({ ...value.identity })
  });
}

/**
 * Validate the normalized rate-limit decision (Core contract v1).
 * Monitor-mode exceeded decisions may remain allowed; enforce-mode blocks must
 * be represented by 429, while enforced dependency outages use 503.
 */
export function validateRateLimitDecisionV1(value) {
  if (!record(value)) throw new TypeError("rate-limit decision must be an object");
  exactKeys(value, new Set([
    "schema", "requestId", "tenantId", "applicationId", "policyId", "scope",
    "allowed", "exceeded", "enforced", "unavailable", "status", "retryAfterSeconds"
  ]), "rate-limit decision");
  if (value.schema !== "jb.security.rate-limit.decision/v1") {
    throw new TypeError("unsupported rate-limit decision schema");
  }
  uuid(value.requestId, "requestId");
  identifier(value.tenantId, "tenantId");
  identifier(value.applicationId, "applicationId");
  identifier(value.policyId, "policyId");
  identifier(value.scope, "scope");
  for (const field of ["allowed", "exceeded", "enforced", "unavailable"]) {
    if (typeof value[field] !== "boolean") throw new TypeError(`${field} must be boolean`);
  }
  if (![null, 429, 503].includes(value.status)) {
    throw new TypeError("status must be null, 429, or 503");
  }
  if (value.retryAfterSeconds !== null &&
      (!Number.isSafeInteger(value.retryAfterSeconds) ||
       value.retryAfterSeconds < 1 || value.retryAfterSeconds > 60)) {
    throw new TypeError("retryAfterSeconds must be null or an integer from 1 to 60");
  }
  if (value.allowed && (value.status !== null || value.retryAfterSeconds !== null)) {
    throw new TypeError("allowed decisions cannot carry an HTTP status or Retry-After");
  }
  if (!value.allowed && ![429, 503].includes(value.status)) {
    throw new TypeError("blocked decisions require HTTP 429 or 503");
  }
  if (value.status === 429 &&
      (!value.exceeded || !value.enforced || value.unavailable)) {
    throw new TypeError("429 requires exceeded=true, enforced=true and unavailable=false");
  }
  if (value.status === 503 &&
      (value.exceeded || !value.enforced || !value.unavailable)) {
    throw new TypeError("503 requires exceeded=false, enforced=true and unavailable=true");
  }
  if (value.status === null && value.retryAfterSeconds !== null) {
    throw new TypeError("Retry-After requires a response status");
  }
  return Object.freeze({ ...value });
}

/**
 * Attach trusted request context to an existing JS adapter decision and emit
 * the Core v1 wire shape. The caller remains responsible for trusted identity
 * derivation and for mapping the adapter's actual failure mode.
 */
export function toRateLimitDecisionV1(context, decision) {
  if (!record(context) || !record(decision)) {
    throw new TypeError("context and decision must be objects");
  }
  const value = {
    schema: "jb.security.rate-limit.decision/v1",
    requestId: context.requestId,
    tenantId: context.tenantId,
    applicationId: context.applicationId,
    policyId: context.policyId,
    scope: context.scope,
    allowed: decision.allowed,
    exceeded: decision.exceeded,
    enforced: decision.enforced,
    unavailable: decision.unavailable,
    status: decision.status,
    retryAfterSeconds: decision.retryAfterSeconds
  };
  return validateRateLimitDecisionV1(value);
}
