const IDENTIFIER = /^[A-Za-z0-9:_-]{1,96}$/;
const KEY_ID = /^[A-Za-z0-9:_-]{1,64}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY_TYPES = new Set(["ip", "account", "account_ip", "session", "anonymous"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, required, optional = [], name = "value") {
  if (!isRecord(value)) throw new TypeError(name + " must be an object");
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(name + "." + key + " is required");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(name + " contains an unsupported field");
    }
  }
}

function assertIdentifier(value, name) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(name + " must contain 1-96 safe identifier characters");
  }
  return value;
}

function assertKeyId(value, name) {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    throw new TypeError(name + " must contain 1-64 safe key identifier characters");
  }
  return value;
}

function assertUuid(value, name) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(name + " must be a UUID");
  }
  return value.toLowerCase();
}

function toSecretBytes(secret) {
  if (secret instanceof Uint8Array) return new Uint8Array(secret);
  if (secret instanceof ArrayBuffer) return new Uint8Array(secret.slice(0));
  if (ArrayBuffer.isView(secret)) {
    return new Uint8Array(secret.buffer.slice(secret.byteOffset, secret.byteOffset + secret.byteLength));
  }
  throw new TypeError("secret must be a Uint8Array, ArrayBuffer, or ArrayBuffer view");
}

function assertCanonicalIdentity(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) {
    throw new TypeError("canonicalIdentity must be a non-empty string of at most 512 characters without NUL");
  }
  const bytes = encoder.encode(value);
  if (bytes.length > 2048) throw new TypeError("canonicalIdentity exceeds the 2048-byte UTF-8 limit");
  if (decoder.decode(bytes) !== value) {
    throw new TypeError("canonicalIdentity must contain valid, stable Unicode text");
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertOpaqueIdentity(identity) {
  assertExactKeys(identity, ["type", "key", "keyId"], [], "identity");
  if (!IDENTITY_TYPES.has(identity.type)) throw new TypeError("identity.type is unsupported");
  if (typeof identity.key !== "string" || !SHA256_HEX.test(identity.key)) {
    throw new TypeError("identity.key must be a lowercase 64-character HMAC-SHA-256 digest");
  }
  assertKeyId(identity.keyId, "identity.keyId");
  return { type: identity.type, key: identity.key, keyId: identity.keyId };
}

/**
 * Derive the v1 cross-runtime opaque identity digest.
 *
 * The host application must resolve and canonicalize the identity server-side.
 * This function intentionally does not normalize account names, IP addresses,
 * sessions, or forwarded headers. The secret is never returned or transmitted.
 */
export async function deriveCoreIdentityKey(options = {}) {
  assertExactKeys(options, [
    "secret", "keyId", "tenantId", "applicationId", "identityType", "canonicalIdentity"
  ], ["cryptoApi"], "options");

  const secret = toSecretBytes(options.secret);
  if (secret.byteLength < 32) throw new TypeError("secret must contain at least 32 bytes");
  assertKeyId(options.keyId, "keyId");
  assertIdentifier(options.tenantId, "tenantId");
  assertIdentifier(options.applicationId, "applicationId");
  if (!IDENTITY_TYPES.has(options.identityType)) throw new TypeError("identityType is unsupported");
  const canonicalIdentity = assertCanonicalIdentity(options.canonicalIdentity);

  const cryptoApi = options.cryptoApi ?? globalThis.crypto;
  if (!cryptoApi?.subtle || typeof cryptoApi.subtle.importKey !== "function" ||
      typeof cryptoApi.subtle.sign !== "function") {
    throw new TypeError("A Web Crypto implementation with subtle.importKey/sign is required");
  }

  const key = await cryptoApi.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const message = encoder.encode(
    "jb.security-guard.identity.v1\0" +
    options.tenantId + "\0" +
    options.applicationId + "\0" +
    options.identityType + "\0" +
    canonicalIdentity
  );
  const signature = new Uint8Array(await cryptoApi.subtle.sign("HMAC", key, message));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Validate and freeze a language-neutral rate-limit check request v1.
 * Identity must already be an opaque HMAC key produced by trusted server code.
 */
export function normalizeCoreRateLimitCheckRequest(input) {
  assertExactKeys(input, [
    "schema", "requestId", "tenantId", "applicationId", "policyId", "scope", "identity"
  ], [], "request");
  if (input.schema !== "jb.security.rate-limit.check/v1") throw new TypeError("request.schema is unsupported");
  assertUuid(input.requestId, "request.requestId");
  assertIdentifier(input.tenantId, "request.tenantId");
  assertIdentifier(input.applicationId, "request.applicationId");
  assertIdentifier(input.policyId, "request.policyId");
  assertIdentifier(input.scope, "request.scope");
  const identity = assertOpaqueIdentity(input.identity);
  return deepFreeze({
    schema: input.schema,
    requestId: input.requestId.toLowerCase(),
    tenantId: input.tenantId,
    applicationId: input.applicationId,
    policyId: input.policyId,
    scope: input.scope,
    identity
  });
}

/**
 * Validate and freeze a language-neutral rate-limit decision v1.
 * Inconsistent 429/503 states are rejected rather than guessed or repaired.
 */
export function normalizeCoreRateLimitDecision(input) {
  assertExactKeys(input, [
    "schema", "requestId", "tenantId", "applicationId", "policyId", "scope",
    "allowed", "exceeded", "enforced", "unavailable", "status", "retryAfterSeconds"
  ], [], "decision");
  if (input.schema !== "jb.security.rate-limit.decision/v1") throw new TypeError("decision.schema is unsupported");
  assertUuid(input.requestId, "decision.requestId");
  assertIdentifier(input.tenantId, "decision.tenantId");
  assertIdentifier(input.applicationId, "decision.applicationId");
  assertIdentifier(input.policyId, "decision.policyId");
  assertIdentifier(input.scope, "decision.scope");
  for (const field of ["allowed", "exceeded", "enforced", "unavailable"]) {
    if (typeof input[field] !== "boolean") throw new TypeError("decision." + field + " must be boolean");
  }
  if (input.status !== null && input.status !== 429 && input.status !== 503) {
    throw new TypeError("decision.status must be null, 429, or 503");
  }
  if (input.retryAfterSeconds !== null &&
      (!Number.isSafeInteger(input.retryAfterSeconds) || input.retryAfterSeconds < 1 || input.retryAfterSeconds > 60)) {
    throw new TypeError("decision.retryAfterSeconds must be null or an integer from 1 to 60");
  }
  if (input.allowed && (input.status !== null || input.retryAfterSeconds !== null)) {
    throw new TypeError("an allowed decision cannot carry a blocking status or retry delay");
  }
  if (!input.allowed && input.status === null) {
    throw new TypeError("a denied decision must identify an enforced 429 or 503 status");
  }
  if (input.status === 429 &&
      (input.allowed || !input.exceeded || !input.enforced || input.unavailable)) {
    throw new TypeError("an enforced 429 decision must represent an exceeded quota");
  }
  if (input.status === 503 &&
      (input.allowed || input.exceeded || !input.enforced || !input.unavailable)) {
    throw new TypeError("an enforced 503 decision must represent an unavailable dependency");
  }
  return deepFreeze({
    schema: input.schema,
    requestId: input.requestId.toLowerCase(),
    tenantId: input.tenantId,
    applicationId: input.applicationId,
    policyId: input.policyId,
    scope: input.scope,
    allowed: input.allowed,
    exceeded: input.exceeded,
    enforced: input.enforced,
    unavailable: input.unavailable,
    status: input.status,
    retryAfterSeconds: input.retryAfterSeconds
  });
}

/** Validate a tenant/application-scoped fixed-window policy v1. */
export function normalizeCoreRateLimitPolicy(input) {
  assertExactKeys(input, [
    "schema", "id", "tenantId", "applicationId", "version", "enabled", "mode", "failureMode", "limits"
  ], [], "policy");
  if (input.schema !== "jb.security.policy.rate-limit/v1") throw new TypeError("policy.schema is unsupported");
  assertIdentifier(input.id, "policy.id");
  assertIdentifier(input.tenantId, "policy.tenantId");
  assertIdentifier(input.applicationId, "policy.applicationId");
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new TypeError("policy.version must be a positive integer");
  if (typeof input.enabled !== "boolean") throw new TypeError("policy.enabled must be boolean");
  if (!["monitor", "enforce"].includes(input.mode)) throw new TypeError("policy.mode is unsupported");
  if (!["open", "closed"].includes(input.failureMode)) throw new TypeError("policy.failureMode is unsupported");
  if (!Array.isArray(input.limits) || input.limits.length < 1 || input.limits.length > 64) {
    throw new TypeError("policy.limits must contain 1-64 entries");
  }

  const seenIds = new Set();
  const limits = input.limits.map((limit, index) => {
    assertExactKeys(limit, ["id", "identityType", "scope", "windowSeconds", "maxRequests"], [], "policy.limits[" + index + "]");
    assertIdentifier(limit.id, "policy.limits[" + index + "].id");
    if (seenIds.has(limit.id)) throw new TypeError("policy limit IDs must be unique");
    seenIds.add(limit.id);
    if (!IDENTITY_TYPES.has(limit.identityType)) throw new TypeError("policy limit identityType is unsupported");
    assertIdentifier(limit.scope, "policy.limits[" + index + "].scope");
    if (!Number.isSafeInteger(limit.windowSeconds) || limit.windowSeconds < 1 || limit.windowSeconds > 86400) {
      throw new TypeError("policy limit windowSeconds must be from 1 to 86400");
    }
    if (!Number.isSafeInteger(limit.maxRequests) || limit.maxRequests < 1 || limit.maxRequests > 1_000_000) {
      throw new TypeError("policy limit maxRequests must be from 1 to 1000000");
    }
    return {
      id: limit.id,
      identityType: limit.identityType,
      scope: limit.scope,
      windowSeconds: limit.windowSeconds,
      maxRequests: limit.maxRequests
    };
  });

  return deepFreeze({
    schema: input.schema,
    id: input.id,
    tenantId: input.tenantId,
    applicationId: input.applicationId,
    version: input.version,
    enabled: input.enabled,
    mode: input.mode,
    failureMode: input.failureMode,
    limits
  });
}

/**
 * Construct a stable, ambiguity-free internal key for an atomic shared store.
 * Only validated identifiers and an opaque HMAC digest are accepted.
 */
export function createCoreRateLimitCounterKey(input) {
  assertExactKeys(input, [
    "tenantId", "applicationId", "policyId", "scope", "identityType", "keyId", "identityKey"
  ], [], "counterKey");
  const values = [
    "jbsg-counter-v1",
    assertIdentifier(input.tenantId, "counterKey.tenantId"),
    assertIdentifier(input.applicationId, "counterKey.applicationId"),
    assertIdentifier(input.policyId, "counterKey.policyId"),
    assertIdentifier(input.scope, "counterKey.scope")
  ];
  if (!IDENTITY_TYPES.has(input.identityType)) throw new TypeError("counterKey.identityType is unsupported");
  values.push(input.identityType);
  assertKeyId(input.keyId, "counterKey.keyId");
  values.push(input.keyId);
  if (typeof input.identityKey !== "string" || !SHA256_HEX.test(input.identityKey)) {
    throw new TypeError("counterKey.identityKey must be a lowercase 64-character HMAC-SHA-256 digest");
  }
  values.push(input.identityKey);
  return values.map((value) => encoder.encode(value).byteLength + ":" + value).join("");
}
