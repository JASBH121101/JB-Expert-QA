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


const CONTRACT_PRODUCER = /^[a-z][a-z0-9-]{1,63}$/;
const CONTRACT_RULE_ID = /^[A-Z0-9][A-Z0-9_-]{2,95}$/;
const ROUTE_TEMPLATE = /^\/[A-Za-z0-9_./:{}*-]*$/;
const AUTH_OPERATIONS = new Set(["login", "password_reset", "account_recovery", "mfa_challenge", "session_refresh"]);
const AUTH_OUTCOMES = new Set(["failure", "success"]);
const EVENT_CATEGORIES = new Set(["request", "rate_limit", "authentication", "recovery", "csrf", "origin", "upload", "threat", "system"]);
const EVENT_ACTIONS = new Set(["observed", "allowed", "blocked", "challenged", "quarantined", "promoted", "rejected"]);
const EVENT_OUTCOMES = new Set(["success", "denied", "unavailable", "error", "observed"]);
const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const THREAT_TYPES = new Set(["brute_force", "endpoint_scan", "enumeration", "sql_injection", "parameter_tampering", "api_abuse", "bot_traffic", "anomaly", "upload_risk"]);
const THREAT_DECISIONS = new Set(["observe", "challenge", "block", "review"]);

function requireFields(value, fields, label) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${label} is missing required field: ${field}`);
  }
}

function contractInteger(value, label, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function contractString(value, label, pattern, maximumLength) {
  if (typeof value !== "string" || value.length > maximumLength || !pattern.test(value)) {
    throw new TypeError(`${label} has an invalid format`);
  }
  return value;
}

function contractHmac(value, label) {
  return contractString(value, label, HMAC_KEY, 64);
}

function freezeContract(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeContract));
  if (record(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, freezeContract(item)])
    ));
  }
  return value;
}

/**
 * Validate an authentication attempt at the language-neutral Core v1 boundary.
 * Account/client identifiers must already be HMAC-SHA-256 digests. The raw
 * account name, IP address, cookie, credential, or request body must never
 * cross this contract.
 */
export function validateAuthenticationAttemptV1(value) {
  if (!record(value)) throw new TypeError("authentication attempt must be an object");
  exactKeys(value, new Set([
    "schema", "attemptId", "tenantId", "applicationId", "operation",
    "outcome", "occurredAtMs", "account", "client"
  ]), "authentication attempt");
  requireFields(value, [
    "schema", "attemptId", "tenantId", "applicationId", "operation",
    "outcome", "occurredAtMs", "account", "client"
  ], "authentication attempt");
  if (value.schema !== "jb.security.authentication.attempt/v1") {
    throw new TypeError("unsupported authentication attempt schema");
  }
  uuid(value.attemptId, "attemptId");
  identifier(value.tenantId, "tenantId");
  identifier(value.applicationId, "applicationId");
  if (!AUTH_OPERATIONS.has(value.operation)) throw new TypeError("unsupported authentication operation");
  if (!AUTH_OUTCOMES.has(value.outcome)) throw new TypeError("unsupported authentication outcome");
  contractInteger(value.occurredAtMs, "occurredAtMs", 0);

  if (!record(value.account)) throw new TypeError("account must be an object");
  exactKeys(value.account, new Set(["key", "keyId"]), "account");
  requireFields(value.account, ["key", "keyId"], "account");
  contractHmac(value.account.key, "account.key");
  contractString(value.account.keyId, "account.keyId", KEY_ID, 64);

  if (!record(value.client)) throw new TypeError("client must be an object");
  exactKeys(value.client, new Set(["key", "keyId"]), "client");
  requireFields(value.client, ["key", "keyId"], "client");
  if (value.client.key === null) {
    if (value.client.keyId !== null) throw new TypeError("client.keyId must be null when client.key is null");
  } else {
    contractHmac(value.client.key, "client.key");
    contractString(value.client.keyId, "client.keyId", KEY_ID, 64);
  }
  return freezeContract(value);
}

/** Validate the normalized authentication enforcement result (Core v1). */
export function validateAuthenticationDecisionV1(value) {
  if (!record(value)) throw new TypeError("authentication decision must be an object");
  exactKeys(value, new Set([
    "schema", "attemptId", "outcome", "enforced", "status", "retryAfterSeconds"
  ]), "authentication decision");
  requireFields(value, [
    "schema", "attemptId", "outcome", "enforced", "status", "retryAfterSeconds"
  ], "authentication decision");
  if (value.schema !== "jb.security.authentication.decision/v1") {
    throw new TypeError("unsupported authentication decision schema");
  }
  uuid(value.attemptId, "attemptId");
  if (!["allow", "deny", "monitor", "unavailable"].includes(value.outcome)) {
    throw new TypeError("unsupported authentication decision outcome");
  }
  if (typeof value.enforced !== "boolean") throw new TypeError("enforced must be boolean");
  if (![null, 429, 503].includes(value.status)) throw new TypeError("status must be null, 429, or 503");
  if (value.retryAfterSeconds !== null) contractInteger(value.retryAfterSeconds, "retryAfterSeconds", 1, 3600);

  if (value.outcome === "allow" &&
      (value.enforced || value.status !== null || value.retryAfterSeconds !== null)) {
    throw new TypeError("allow requires enforced=false and null status/retryAfterSeconds");
  }
  if (value.outcome === "monitor" && (value.enforced || value.status !== null)) {
    throw new TypeError("monitor requires enforced=false and status=null");
  }
  if (value.outcome === "deny" && (!value.enforced || value.status !== 429)) {
    throw new TypeError("deny requires enforced=true and status=429");
  }
  if (value.outcome === "unavailable" && (!value.enforced || value.status !== 503)) {
    throw new TypeError("unavailable requires enforced=true and status=503");
  }
  return freezeContract(value);
}

/** Validate a privacy-bounded, sanitized Core v1 security event. */
export function validateSecurityEventV1(value) {
  if (!record(value)) throw new TypeError("security event must be an object");
  exactKeys(value, new Set([
    "schema", "eventId", "occurredAtMs", "tenantId", "applicationId", "producer",
    "category", "ruleId", "severity", "action", "outcome", "subjectKey",
    "scope", "correlationId", "subjectKeyId"
  ]), "security event");
  requireFields(value, [
    "schema", "eventId", "occurredAtMs", "tenantId", "applicationId", "producer",
    "category", "ruleId", "severity", "action", "outcome"
  ], "security event");
  if (value.schema !== "jb.security.event/v1") throw new TypeError("unsupported security event schema");
  uuid(value.eventId, "eventId");
  contractInteger(value.occurredAtMs, "occurredAtMs", 0);
  identifier(value.tenantId, "tenantId");
  identifier(value.applicationId, "applicationId");
  contractString(value.producer, "producer", CONTRACT_PRODUCER, 64);
  if (!EVENT_CATEGORIES.has(value.category)) throw new TypeError("unsupported security event category");
  contractString(value.ruleId, "ruleId", CONTRACT_RULE_ID, 96);
  if (!SEVERITIES.has(value.severity)) throw new TypeError("unsupported security event severity");
  if (!EVENT_ACTIONS.has(value.action)) throw new TypeError("unsupported security event action");
  if (!EVENT_OUTCOMES.has(value.outcome)) throw new TypeError("unsupported security event outcome");

  if (Object.hasOwn(value, "subjectKey")) {
    contractHmac(value.subjectKey, "subjectKey");
    if (!Object.hasOwn(value, "subjectKeyId")) {
      throw new TypeError("subjectKeyId is required when subjectKey is present");
    }
  }
  if (Object.hasOwn(value, "subjectKeyId")) {
    contractString(value.subjectKeyId, "subjectKeyId", KEY_ID, 64);
  }
  if (Object.hasOwn(value, "scope")) identifier(value.scope, "scope");
  if (Object.hasOwn(value, "correlationId")) uuid(value.correlationId, "correlationId");
  return freezeContract(value);
}

/** Validate a server-owned, tenant/application-scoped rate-limit policy. */
export function validateRateLimitPolicyV1(value) {
  if (!record(value)) throw new TypeError("rate-limit policy must be an object");
  exactKeys(value, new Set([
    "schema", "id", "tenantId", "applicationId", "version",
    "enabled", "mode", "failureMode", "limits"
  ]), "rate-limit policy");
  requireFields(value, [
    "schema", "id", "tenantId", "applicationId", "version",
    "enabled", "mode", "failureMode", "limits"
  ], "rate-limit policy");
  if (value.schema !== "jb.security.policy.rate-limit/v1") {
    throw new TypeError("unsupported rate-limit policy schema");
  }
  identifier(value.id, "policy.id");
  identifier(value.tenantId, "tenantId");
  identifier(value.applicationId, "applicationId");
  contractInteger(value.version, "version", 1);
  if (typeof value.enabled !== "boolean") throw new TypeError("enabled must be boolean");
  if (!["monitor", "enforce"].includes(value.mode)) throw new TypeError("mode must be monitor or enforce");
  if (!["open", "closed"].includes(value.failureMode)) throw new TypeError("failureMode must be open or closed");
  if (!Array.isArray(value.limits) || value.limits.length < 1 || value.limits.length > 64) {
    throw new TypeError("limits must contain 1 to 64 entries");
  }
  const limits = value.limits.map((limit, index) => {
    const label = `limits[${index}]`;
    if (!record(limit)) throw new TypeError(`${label} must be an object`);
    exactKeys(limit, new Set(["id", "identityType", "scope", "windowSeconds", "maxRequests"]), label);
    requireFields(limit, ["id", "identityType", "scope", "windowSeconds", "maxRequests"], label);
    identifier(limit.id, `${label}.id`);
    if (!IDENTITY_TYPES.has(limit.identityType)) throw new TypeError(`${label}.identityType is unsupported`);
    identifier(limit.scope, `${label}.scope`);
    contractInteger(limit.windowSeconds, `${label}.windowSeconds`, 1, 86400);
    contractInteger(limit.maxRequests, `${label}.maxRequests`, 1, 1_000_000);
    return limit;
  });
  return freezeContract({ ...value, limits });
}

/** Validate a normalized threat signal. Signals are evidence, not block decisions. */
export function validateThreatSignalV1(value) {
  if (!record(value)) throw new TypeError("threat signal must be an object");
  exactKeys(value, new Set([
    "schema", "signalId", "tenantId", "applicationId", "detectedAtMs", "source",
    "type", "confidence", "severity", "ruleId", "subjectKey", "routeTemplate",
    "evidenceCount", "subjectKeyId"
  ]), "threat signal");
  requireFields(value, [
    "schema", "signalId", "tenantId", "applicationId", "detectedAtMs", "source",
    "type", "confidence", "severity", "ruleId"
  ], "threat signal");
  if (value.schema !== "jb.security.threat-signal/v1") throw new TypeError("unsupported threat signal schema");
  uuid(value.signalId, "signalId");
  identifier(value.tenantId, "tenantId");
  identifier(value.applicationId, "applicationId");
  contractInteger(value.detectedAtMs, "detectedAtMs", 0);
  contractString(value.source, "source", CONTRACT_PRODUCER, 64);
  if (!THREAT_TYPES.has(value.type)) throw new TypeError("unsupported threat signal type");
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) ||
      value.confidence < 0 || value.confidence > 1) {
    throw new TypeError("confidence must be a finite number from 0 to 1");
  }
  if (!SEVERITIES.has(value.severity)) throw new TypeError("unsupported threat signal severity");
  contractString(value.ruleId, "ruleId", CONTRACT_RULE_ID, 96);
  if (Object.hasOwn(value, "subjectKey")) contractHmac(value.subjectKey, "subjectKey");
  if (Object.hasOwn(value, "subjectKeyId")) {
    contractString(value.subjectKeyId, "subjectKeyId", KEY_ID, 64);
  }
  if (Object.hasOwn(value, "subjectKey") && !Object.hasOwn(value, "subjectKeyId")) {
    throw new TypeError("subjectKeyId is required when subjectKey is present");
  }
  if (Object.hasOwn(value, "routeTemplate")) {
    contractString(value.routeTemplate, "routeTemplate", ROUTE_TEMPLATE, 256);
  }
  if (Object.hasOwn(value, "evidenceCount")) {
    contractInteger(value.evidenceCount, "evidenceCount", 0, 1_000_000);
  }
  return freezeContract(value);
}

/** Validate a policy assessment that combines one or more normalized signals. */
export function validateThreatAssessmentV1(value) {
  if (!record(value)) throw new TypeError("threat assessment must be an object");
  exactKeys(value, new Set([
    "schema", "assessmentId", "tenantId", "applicationId", "assessedAtMs",
    "riskScore", "decision", "signalIds", "policyId"
  ]), "threat assessment");
  requireFields(value, [
    "schema", "assessmentId", "tenantId", "applicationId", "assessedAtMs",
    "riskScore", "decision", "signalIds", "policyId"
  ], "threat assessment");
  if (value.schema !== "jb.security.threat-assessment/v1") {
    throw new TypeError("unsupported threat assessment schema");
  }
  uuid(value.assessmentId, "assessmentId");
  identifier(value.tenantId, "tenantId");
  identifier(value.applicationId, "applicationId");
  contractInteger(value.assessedAtMs, "assessedAtMs", 0);
  contractInteger(value.riskScore, "riskScore", 0, 100);
  if (!THREAT_DECISIONS.has(value.decision)) throw new TypeError("unsupported threat assessment decision");
  if (!Array.isArray(value.signalIds) || value.signalIds.length < 1 || value.signalIds.length > 128) {
    throw new TypeError("signalIds must contain 1 to 128 UUIDs");
  }
  value.signalIds.forEach((signalId, index) => uuid(signalId, `signalIds[${index}]`));
  if (new Set(value.signalIds).size !== value.signalIds.length) {
    throw new TypeError("signalIds must be unique");
  }
  identifier(value.policyId, "policyId");
  return freezeContract(value);
}

/** Validate the server-owned policy used by the Core v1 threat assessor. */
export function validateThreatAssessmentPolicyV1(value) {
  if (!record(value)) throw new TypeError("threat assessment policy must be an object");
  exactKeys(value, new Set([
    "schema", "id", "tenantId", "applicationId", "version", "enabled",
    "windowMs", "maxSignals", "minimumConfidence", "severityWeights",
    "typeWeights", "thresholds", "blockRequirements"
  ]), "threat assessment policy");
  requireFields(value, [
    "schema", "id", "tenantId", "applicationId", "version", "enabled",
    "windowMs", "maxSignals", "minimumConfidence", "severityWeights",
    "typeWeights", "thresholds", "blockRequirements"
  ], "threat assessment policy");
  if (value.schema !== "jb.security.policy.threat-assessment/v1") {
    throw new TypeError("unsupported threat assessment policy schema");
  }
  identifier(value.id, "policy.id");
  identifier(value.tenantId, "tenantId");
  identifier(value.applicationId, "applicationId");
  contractInteger(value.version, "version", 1);
  if (typeof value.enabled !== "boolean") throw new TypeError("enabled must be boolean");
  contractInteger(value.windowMs, "windowMs", 1000, 86_400_000);
  contractInteger(value.maxSignals, "maxSignals", 1, 128);
  if (typeof value.minimumConfidence !== "number" ||
      !Number.isFinite(value.minimumConfidence) ||
      value.minimumConfidence < 0 || value.minimumConfidence > 1) {
    throw new TypeError("minimumConfidence must be a finite number from 0 to 1");
  }

  const severityNames = ["info", "low", "medium", "high", "critical"];
  if (!record(value.severityWeights)) throw new TypeError("severityWeights must be an object");
  exactKeys(value.severityWeights, new Set(severityNames), "severityWeights");
  requireFields(value.severityWeights, severityNames, "severityWeights");
  for (const severity of severityNames) {
    contractInteger(value.severityWeights[severity], "severityWeights." + severity, 0, 100);
  }

  const threatTypes = [...THREAT_TYPES];
  if (!record(value.typeWeights)) throw new TypeError("typeWeights must be an object");
  exactKeys(value.typeWeights, new Set(threatTypes), "typeWeights");
  requireFields(value.typeWeights, threatTypes, "typeWeights");
  for (const type of threatTypes) {
    contractInteger(value.typeWeights[type], "typeWeights." + type, 0, 200);
  }

  if (!record(value.thresholds)) throw new TypeError("thresholds must be an object");
  exactKeys(value.thresholds, new Set(["challenge", "review", "block"]), "thresholds");
  requireFields(value.thresholds, ["challenge", "review", "block"], "thresholds");
  for (const name of ["challenge", "review", "block"]) {
    contractInteger(value.thresholds[name], "thresholds." + name, 1, 100);
  }
  if (value.thresholds.challenge > value.thresholds.review ||
      value.thresholds.review > value.thresholds.block) {
    throw new TypeError("thresholds must satisfy challenge <= review <= block");
  }

  const requirements = value.blockRequirements;
  if (!record(requirements)) throw new TypeError("blockRequirements must be an object");
  exactKeys(requirements, new Set([
    "minSignals", "minDistinctRules", "minDistinctTypes", "minimumConfidence"
  ]), "blockRequirements");
  requireFields(requirements, [
    "minSignals", "minDistinctRules", "minDistinctTypes", "minimumConfidence"
  ], "blockRequirements");
  contractInteger(requirements.minSignals, "blockRequirements.minSignals", 2, 128);
  contractInteger(requirements.minDistinctRules, "blockRequirements.minDistinctRules", 2, 128);
  contractInteger(requirements.minDistinctTypes, "blockRequirements.minDistinctTypes", 2, threatTypes.length);
  if (requirements.minDistinctRules > requirements.minSignals ||
      requirements.minDistinctTypes > requirements.minSignals ||
      requirements.minSignals > value.maxSignals) {
    throw new TypeError("blockRequirements counts must fit within maxSignals");
  }
  if (typeof requirements.minimumConfidence !== "number" ||
      !Number.isFinite(requirements.minimumConfidence) ||
      requirements.minimumConfidence < value.minimumConfidence ||
      requirements.minimumConfidence > 1) {
    throw new TypeError("blockRequirements.minimumConfidence must be from minimumConfidence to 1");
  }
  return freezeContract(value);
}

/**
 * Build an authentication decision using a trusted attempt identifier, then
 * validate the wire shape. This does not decide whether authentication passes.
 */
export function toAuthenticationDecisionV1(attemptId, decision) {
  if (!record(decision)) throw new TypeError("authentication decision input must be an object");
  exactKeys(decision, new Set(["outcome", "enforced", "status", "retryAfterSeconds"]), "authentication decision input");
  return validateAuthenticationDecisionV1({
    schema: "jb.security.authentication.decision/v1",
    attemptId,
    outcome: decision.outcome,
    enforced: decision.enforced,
    status: decision.status,
    retryAfterSeconds: decision.retryAfterSeconds
  });
}

/** Exposes immutable schema identifiers for adapters and conformance tooling. */
export const SECURITY_GUARD_CORE_V1_SCHEMAS = Object.freeze({
  rateLimitCheck: "jb.security.rate-limit.check/v1",
  rateLimitDecision: "jb.security.rate-limit.decision/v1",
  authenticationAttempt: "jb.security.authentication.attempt/v1",
  authenticationDecision: "jb.security.authentication.decision/v1",
  securityEvent: "jb.security.event/v1",
  rateLimitPolicy: "jb.security.policy.rate-limit/v1",
  threatSignal: "jb.security.threat-signal/v1",
  threatAssessment: "jb.security.threat-assessment/v1",
  threatAssessmentPolicy: "jb.security.policy.threat-assessment/v1"
});


// Core v1 cross-runtime identity derivation and strict boundary normalizers.
// These helpers are additive and do not alter the legacy Node/Worker key formats.
const CORE_V1_TEXT_ENCODER = new TextEncoder();
const CORE_V1_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const CORE_V1_SHA256_HEX = /^[a-f0-9]{64}$/;

function assertCoreV1PlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(label + " must be a plain object");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(label + " contains an unsupported key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " must not contain accessor properties");
    }
  }
}

function coreV1SecretBytes(secret) {
  if (secret instanceof ArrayBuffer) return new Uint8Array(secret.slice(0));
  if (ArrayBuffer.isView(secret)) {
    return new Uint8Array(secret.buffer.slice(secret.byteOffset, secret.byteOffset + secret.byteLength));
  }
  throw new TypeError("secret must be an ArrayBuffer or an ArrayBuffer view");
}

function coreV1CanonicalIdentity(value) {
  if (typeof value !== "string" || value.length === 0 ||
      Array.from(value).length > 512 || value.includes("\0")) {
    throw new TypeError("canonicalIdentity must be a non-empty string of at most 512 characters without NUL");
  }
  const bytes = CORE_V1_TEXT_ENCODER.encode(value);
  if (bytes.byteLength > 2048 || CORE_V1_TEXT_DECODER.decode(bytes) !== value) {
    throw new TypeError("canonicalIdentity must be valid UTF-8 and at most 2048 bytes");
  }
  return value;
}

function coreV1DeepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) coreV1DeepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Derive an opaque cross-runtime identity key from trusted server-side input.
 * The canonical identity must never originate from an untrusted request field.
 */
export async function deriveCoreIdentityKey(options = {}) {
  assertCoreV1PlainObject(options, "options");
  const allowed = new Set([
    "secret", "keyId", "tenantId", "applicationId", "identityType",
    "canonicalIdentity", "cryptoApi"
  ]);
  for (const key of Reflect.ownKeys(options)) {
    if (!allowed.has(key)) throw new TypeError("options contains an unsupported field");
  }
  for (const key of [
    "secret", "keyId", "tenantId", "applicationId", "identityType", "canonicalIdentity"
  ]) {
    if (!Object.hasOwn(options, key)) throw new TypeError("options." + key + " is required");
  }

  const secret = coreV1SecretBytes(options.secret);
  if (secret.byteLength < 32 || secret.byteLength > 4096) {
    throw new TypeError("secret must contain 32-4096 bytes");
  }
  if (typeof options.keyId !== "string" || !KEY_ID.test(options.keyId)) {
    throw new TypeError("keyId must be a safe 1-64 character identifier");
  }
  identifier(options.tenantId, "tenantId");
  identifier(options.applicationId, "applicationId");
  if (!IDENTITY_TYPES.has(options.identityType)) throw new TypeError("identityType is unsupported");
  const canonicalIdentity = coreV1CanonicalIdentity(options.canonicalIdentity);

  const cryptoApi = options.cryptoApi ?? globalThis.crypto;
  if (!cryptoApi?.subtle || typeof cryptoApi.subtle.importKey !== "function" ||
      typeof cryptoApi.subtle.sign !== "function") {
    throw new TypeError("A Web Crypto implementation with subtle.importKey/sign is required");
  }
  const key = await cryptoApi.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const message = CORE_V1_TEXT_ENCODER.encode(
    "jb.security-guard.identity.v1\0" +
    options.tenantId + "\0" +
    options.applicationId + "\0" +
    options.identityType + "\0" +
    canonicalIdentity
  );
  const signature = new Uint8Array(await cryptoApi.subtle.sign("HMAC", key, message));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Strict, deeply frozen Core v1 request normalization for external adapters. */
export function normalizeCoreRateLimitCheckRequest(input) {
  assertCoreV1PlainObject(input, "request");
  assertCoreV1PlainObject(input.identity, "request.identity");
  const normalized = validateRateLimitCheckV1(input);
  return coreV1DeepFreeze(normalized);
}

/**
 * Strict decision normalization. An allowed unavailable decision is valid only
 * for fail-open (enforced=false, status=null, exceeded=false); fail-closed
 * outages remain denied 503 decisions.
 */
export function normalizeCoreRateLimitDecision(input) {
  assertCoreV1PlainObject(input, "decision");
  const decision = validateRateLimitDecisionV1(input);
  if (decision.allowed && decision.enforced) {
    throw new TypeError("an allowed decision cannot be enforced");
  }
  if (decision.allowed && decision.unavailable && decision.exceeded) {
    throw new TypeError("an unavailable fail-open decision cannot be quota-exceeded");
  }
  return coreV1DeepFreeze(decision);
}

/** Strict policy normalization with unique limit identifiers. */
export function normalizeCoreRateLimitPolicy(input) {
  assertCoreV1PlainObject(input, "policy");
  if (Array.isArray(input.limits)) {
    input.limits.forEach((limit, index) => assertCoreV1PlainObject(limit, "policy.limits[" + index + "]"));
  }
  const policy = validateRateLimitPolicyV1(input);
  const seen = new Set();
  for (const [index, limit] of policy.limits.entries()) {
    if (seen.has(limit.id)) {
      throw new TypeError("policy.limits[" + index + "].id must be unique");
    }
    seen.add(limit.id);
  }
  return coreV1DeepFreeze(policy);
}

/** Build a collision-resistant length-prefixed key for an atomic shared store. */
export function createCoreRateLimitCounterKey(input) {
  assertCoreV1PlainObject(input, "counterKey");
  const fields = [
    "tenantId", "applicationId", "policyId", "scope",
    "identityType", "keyId", "identityKey"
  ];
  for (const key of Reflect.ownKeys(input)) {
    if (!fields.includes(key)) throw new TypeError("counterKey contains an unsupported field");
  }
  for (const key of fields) {
    if (!Object.hasOwn(input, key)) throw new TypeError("counterKey." + key + " is required");
  }
  const values = [
    "jbsg-counter-v1",
    identifier(input.tenantId, "counterKey.tenantId"),
    identifier(input.applicationId, "counterKey.applicationId"),
    identifier(input.policyId, "counterKey.policyId"),
    identifier(input.scope, "counterKey.scope")
  ];
  if (!IDENTITY_TYPES.has(input.identityType)) throw new TypeError("counterKey.identityType is unsupported");
  values.push(input.identityType);
  if (typeof input.keyId !== "string" || !KEY_ID.test(input.keyId)) {
    throw new TypeError("counterKey.keyId is unsupported");
  }
  values.push(input.keyId);
  if (typeof input.identityKey !== "string" || !CORE_V1_SHA256_HEX.test(input.identityKey)) {
    throw new TypeError("counterKey.identityKey must be a lowercase HMAC-SHA-256 digest");
  }
  values.push(input.identityKey);
  return values.map((value) => CORE_V1_TEXT_ENCODER.encode(value).byteLength + ":" + value).join("");
}


const UPLOAD_ATTESTATION_ID = /^(?:[a-f0-9]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const UPLOAD_SHA256 = /^[a-f0-9]{64}$/;
const UPLOAD_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"
]);

/**
 * Validate a scanner attestation for one exact quarantined upload.
 * A clean scanner verdict is evidence only; it never authorizes promotion by itself.
 */
export function validateUploadInspectionAttestationV1(value) {
  if (!record(value)) throw new TypeError("upload inspection attestation must be an object");
  exactKeys(value, new Set([
    "schema", "uploadId", "verdict", "sha256", "size", "mimeType",
    "engine", "version", "scannedAtMs"
  ]), "upload inspection attestation");
  requireFields(value, [
    "schema", "uploadId", "verdict", "sha256", "size", "mimeType",
    "engine", "version", "scannedAtMs"
  ], "upload inspection attestation");
  if (value.schema !== "jb.security.upload-inspection.attestation/v1") {
    throw new TypeError("unsupported upload inspection attestation schema");
  }
  if (typeof value.uploadId !== "string" || !UPLOAD_ATTESTATION_ID.test(value.uploadId)) {
    throw new TypeError("uploadId must be a 32-character hex ID or UUID");
  }
  if (!["clean", "malicious", "unknown"].includes(value.verdict)) {
    throw new TypeError("unsupported upload scanner verdict");
  }
  if (typeof value.sha256 !== "string" || !UPLOAD_SHA256.test(value.sha256)) {
    throw new TypeError("sha256 must be a lowercase SHA-256 digest");
  }
  contractInteger(value.size, "size", 1, 104857600);
  if (!UPLOAD_MIME_TYPES.has(value.mimeType)) throw new TypeError("unsupported detected MIME type");
  contractString(value.engine, "engine", /^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/, 128);
  contractString(value.version, "version", /^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/, 64);
  contractInteger(value.scannedAtMs, "scannedAtMs", 0);
  return freezeContract(value);
}
