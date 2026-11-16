import { createHmac, randomUUID } from "node:crypto";
import { validateSecurityEventV1 } from "./core-contract-v1.js";

const SAFE_IDENTIFIER = /^[A-Za-z0-9:_-]{1,96}$/;
const SAFE_KEY_ID = /^[A-Za-z0-9:_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeSecurityEventCoreContract(value, {
  requireSubjectKeyId = false
} = {}) {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new TypeError("coreContract must be an object");
  const allowed = new Set(["tenantId", "applicationId", "subjectKeyId"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError("Unknown security-event Core option: " + key);
  }
  for (const key of ["tenantId", "applicationId"]) {
    if (typeof value[key] !== "string" || !SAFE_IDENTIFIER.test(value[key])) {
      throw new TypeError("coreContract." + key + " must be a safe identifier");
    }
  }
  const subjectKeyId = value.subjectKeyId ?? null;
  if (subjectKeyId !== null &&
      (typeof subjectKeyId !== "string" || !SAFE_KEY_ID.test(subjectKeyId))) {
    throw new TypeError("coreContract.subjectKeyId must be a safe key identifier");
  }
  if (requireSubjectKeyId && subjectKeyId === null) {
    throw new TypeError("coreContract.subjectKeyId is required for pseudonymous subject correlation");
  }
  return Object.freeze({
    tenantId: value.tenantId,
    applicationId: value.applicationId,
    subjectKeyId
  });
}

function normalizeSecret(secret) {
  const bytes = Buffer.isBuffer(secret)
    ? Buffer.from(secret)
    : typeof secret === "string" ? Buffer.from(secret, "utf8") : null;
  if (!bytes || bytes.length < 32) {
    throw new TypeError("security-event subject hashing requires at least 32 bytes of stable secret material");
  }
  return bytes;
}

export function createSecurityEventCoreV1(core, input, secret = null) {
  if (!core) return null;
  if (!isRecord(input)) throw new TypeError("security event input must be an object");

  const occurredAtMs = input.occurredAtMs ?? Date.now();
  if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
    throw new TypeError("occurredAtMs must be a non-negative safe integer timestamp in milliseconds");
  }

  let subjectKey;
  if (input.subjectValue !== undefined && input.subjectValue !== null) {
    if (core.subjectKeyId === null) {
      throw new TypeError("coreContract.subjectKeyId is required when a subject is included");
    }
    if (typeof input.subjectValue !== "string" && typeof input.subjectValue !== "number") {
      throw new TypeError("subjectValue must be an opaque string or number");
    }
    const subjectValue = String(input.subjectValue).trim();
    if (!subjectValue || subjectValue.length > 512) {
      throw new TypeError("subjectValue must be a non-empty opaque value of at most 512 characters");
    }
    const subjectType = input.subjectType ?? "session";
    if (typeof subjectType !== "string" || !SAFE_IDENTIFIER.test(subjectType)) {
      throw new TypeError("subjectType must be a safe identifier");
    }
    const keySecret = normalizeSecret(secret);
    subjectKey = createHmac("sha256", keySecret)
      .update("jb.security.event.subject/v1").update("\0")
      .update(core.tenantId).update("\0")
      .update(core.applicationId).update("\0")
      .update(subjectType).update("\0")
      .update(subjectValue)
      .digest("hex");
  }

  const value = {
    schema: "jb.security.event/v1",
    eventId: randomUUID(),
    occurredAtMs,
    tenantId: core.tenantId,
    applicationId: core.applicationId,
    producer: "security-guard-node",
    category: input.category,
    ruleId: input.ruleId,
    severity: input.severity,
    action: input.action,
    outcome: input.outcome,
    ...(subjectKey ? {
      subjectKey,
      subjectKeyId: core.subjectKeyId
    } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    correlationId: UUID.test(input.correlationId ?? "")
      ? input.correlationId
      : randomUUID()
  };
  return validateSecurityEventV1(value);
}

export function safelyEmitSecurityEventCore(callback, event) {
  if (typeof callback !== "function" || event === null || event === undefined) return;
  try {
    const result = callback(event);
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch {
    // Security-event telemetry must never alter the protected operation.
  }
}
