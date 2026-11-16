import { createHash, randomUUID } from "node:crypto";

const POLICY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const ACTION_RISK = Object.freeze({
  observe: "A0",
  "restart-service": "A1",
  "drain-instance": "A1",
  "enter-degraded-mode": "A1",
  "apply-containment-profile": "A2",
  "switch-route": "A3",
  failover: "A3"
});
const EXECUTABLE_ACTIONS = new Set(["restart-service"]);
const SECURITY_STATES = new Set(["clear", "suspected", "confirmed", "conflicting", "stale", "unknown"]);
const DEFAULTS = Object.freeze({
  decision: "deny",
  unknownSignal: "hold-and-escalate",
  staleSignal: "hold-and-escalate",
  ledgerUnavailable: "block-mutations",
  policyInvalid: "block-mutations",
  preserveEvidence: true,
  requireDurableAudit: true
});
const POLICY_KEYS = [
  "schema", "policyId", "revision", "mode", "validity", "signature",
  "policyHash", "defaults", "budgets", "services"
];
const SERVICE_KEYS = [
  "id", "environment", "tier", "criticality", "allowedActions",
  "recovery", "containmentProfile", "failoverProfile"
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonSafe(value, depth = 0, seen = new WeakSet()) {
  if (depth > 20) throw new TypeError("policy nesting is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("policy contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("policy must contain JSON-compatible values");
  if (seen.has(value)) throw new TypeError("policy must not contain circular references");
  seen.add(value);

  if (Array.isArray(value)) {
    const ownKeys = Object.keys(value);
    if (ownKeys.length !== value.length ||
        ownKeys.some((key, index) => key !== String(index))) {
      throw new TypeError("policy arrays must be dense and contain no extra properties");
    }
    const copy = value.map((entry) => cloneJsonSafe(entry, depth + 1, seen));
    seen.delete(value);
    return Object.freeze(copy);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("policy objects must be plain JSON records");
  }
  if (Object.getOwnPropertySymbols(value).length) {
    throw new TypeError("policy objects must not contain symbol properties");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (["__proto__", "prototype", "constructor"].includes(key) ||
        !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("policy contains an unsafe or accessor property");
    }
    copy[key] = cloneJsonSafe(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
  return Object.freeze(copy);
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)) throw new TypeError(label + " must be an object");
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(label + " has missing or unsupported fields");
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(value[key])
  ).join(",") + "}";
}

function signingPayloadFor(policy) {
  const payload = Object.create(null);
  for (const key of Object.keys(policy)) {
    if (key === "policyHash") continue;
    if (key === "signature") {
      payload.signature = {
        keyId: policy.signature.keyId,
        algorithm: policy.signature.algorithm
      };
    } else {
      payload[key] = policy[key];
    }
  }
  return canonicalJson(payload);
}

export function computeAdvancedPolicyHash(policy) {
  const safePolicy = cloneJsonSafe(policy);
  if (!isRecord(safePolicy)) throw new TypeError("policy must be an object");
  return createHash("sha256").update(signingPayloadFor(safePolicy), "utf8").digest("hex");
}

function parseUtcTimestamp(value, label) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new TypeError(label + " must be an ISO-8601 UTC timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(label + " is invalid");
  const canonical = new Date(parsed).toISOString();
  if (canonical !== value && canonical.replace(".000Z", "Z") !== value) {
    throw new TypeError(label + " is not a canonical UTC timestamp");
  }
  return parsed;
}

function validateBoundedInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(label + " is outside its allowed range");
  }
}

function validateProfile(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(label + " must be null or an exact profile identifier");
  }
  return value;
}

function validateRecovery(value, allowedActions) {
  if (!allowedActions.includes("restart-service")) {
    if (value !== null) throw new TypeError("recovery must be null when restart-service is not allowed");
    return null;
  }
  assertExactKeys(value, [
    "failureThreshold", "maxRestartsPerHour", "cooldownMs", "requireApplicationHealth"
  ], "service recovery");
  validateBoundedInteger(value.failureThreshold, 1, 10, "failureThreshold");
  validateBoundedInteger(value.maxRestartsPerHour, 1, 10, "maxRestartsPerHour");
  validateBoundedInteger(value.cooldownMs, 1000, 86_400_000, "cooldownMs");
  if (value.requireApplicationHealth !== true) {
    throw new TypeError("restart-service requires application-level health verification");
  }
  return Object.freeze({
    failureThreshold: value.failureThreshold,
    maxRestartsPerHour: value.maxRestartsPerHour,
    cooldownMs: value.cooldownMs,
    requireApplicationHealth: true
  });
}

function validateService(service, seenIds) {
  assertExactKeys(service, SERVICE_KEYS, "service");
  if (typeof service.id !== "string" || !IDENTIFIER.test(service.id) || seenIds.has(service.id)) {
    throw new TypeError("service IDs must be unique exact identifiers; wildcards are forbidden");
  }
  seenIds.add(service.id);
  if (typeof service.environment !== "string" || !IDENTIFIER.test(service.environment)) {
    throw new TypeError("service environment must be an exact identifier");
  }
  if (!["stateless", "stateful", "critical", "data-bearing", "security-control-plane"].includes(service.tier)) {
    throw new TypeError("service tier is invalid");
  }
  if (!["standard", "high", "critical"].includes(service.criticality)) {
    throw new TypeError("service criticality is invalid");
  }
  if (!Array.isArray(service.allowedActions) || service.allowedActions.length < 1 ||
      service.allowedActions.length > Object.keys(ACTION_RISK).length) {
    throw new TypeError("service allowedActions must be a bounded non-empty array");
  }
  const actions = [];
  const seenActions = new Set();
  for (const action of service.allowedActions) {
    if (typeof action !== "string" || !Object.hasOwn(ACTION_RISK, action) ||
        action === "*" || seenActions.has(action)) {
      throw new TypeError("service contains an unknown, duplicate or wildcard capability");
    }
    seenActions.add(action);
    actions.push(action);
  }
  if (actions.includes("restart-service") &&
      (service.tier !== "stateless" || service.criticality !== "standard")) {
    throw new TypeError("autonomous restart is restricted to stateless, standard-criticality assets");
  }
  const recovery = validateRecovery(service.recovery, actions);
  const containmentProfile = validateProfile(service.containmentProfile, "containmentProfile");
  const failoverProfile = validateProfile(service.failoverProfile, "failoverProfile");
  if (actions.includes("apply-containment-profile") !== (containmentProfile !== null)) {
    throw new TypeError("containmentProfile must exactly match the containment capability");
  }
  if ((actions.includes("switch-route") || actions.includes("failover")) !== (failoverProfile !== null)) {
    throw new TypeError("failoverProfile must exactly match route/failover capabilities");
  }
  return Object.freeze({
    id: service.id,
    environment: service.environment,
    tier: service.tier,
    criticality: service.criticality,
    allowedActions: Object.freeze(actions),
    recovery,
    containmentProfile,
    failoverProfile
  });
}

function validateDefaults(defaults) {
  assertExactKeys(defaults, Object.keys(DEFAULTS), "policy defaults");
  for (const [key, expected] of Object.entries(DEFAULTS)) {
    if (defaults[key] !== expected) {
      throw new TypeError("policy default " + key + " must remain fail-closed");
    }
  }
  return DEFAULTS;
}

function validateBudgets(budgets) {
  assertExactKeys(budgets, [
    "maxConcurrentActionsPerIncident", "maxActionsPerIncident",
    "maxActionsPerAssetPerHour", "maxAutomaticContainmentsPerIncident"
  ], "policy budgets");
  validateBoundedInteger(budgets.maxConcurrentActionsPerIncident, 1, 10,
    "maxConcurrentActionsPerIncident");
  validateBoundedInteger(budgets.maxActionsPerIncident, 1, 100, "maxActionsPerIncident");
  validateBoundedInteger(budgets.maxActionsPerAssetPerHour, 1, 50,
    "maxActionsPerAssetPerHour");
  validateBoundedInteger(budgets.maxAutomaticContainmentsPerIncident, 0, 10,
    "maxAutomaticContainmentsPerIncident");
  return Object.freeze({
    maxConcurrentActionsPerIncident: budgets.maxConcurrentActionsPerIncident,
    maxActionsPerIncident: budgets.maxActionsPerIncident,
    maxActionsPerAssetPerHour: budgets.maxActionsPerAssetPerHour,
    maxAutomaticContainmentsPerIncident: budgets.maxAutomaticContainmentsPerIncident
  });
}

function verifyPolicySnapshot(policy, verifySignature, now) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("policy clock is invalid");
  const notBefore = parseUtcTimestamp(policy.validity.notBefore, "validity.notBefore");
  const expiresAt = parseUtcTimestamp(policy.validity.expiresAt, "validity.expiresAt");
  if (notBefore >= expiresAt || now < notBefore || now >= expiresAt) {
    throw new TypeError("policy is not currently valid");
  }
  const signingPayload = signingPayloadFor(policy);
  const actualHash = createHash("sha256").update(signingPayload, "utf8").digest("hex");
  if (actualHash !== policy.policyHash) throw new TypeError("policy hash does not match its contents");
  let verified;
  try {
    verified = verifySignature(Object.freeze({
      policy,
      signature: policy.signature,
      policyHash: actualHash,
      signingPayload
    }));
  } catch {
    throw new TypeError("policy signature verification failed");
  }
  if (verified !== true) throw new TypeError("policy signature verification failed");
  return Object.freeze({ policyHash: actualHash, notBefore, expiresAt });
}

export function validateAdvancedResiliencePolicy(policy, {
  verifySignature,
  now = Date.now()
} = {}) {
  if (typeof verifySignature !== "function") {
    throw new TypeError("an injected cryptographic verifySignature function is required");
  }
  const safe = cloneJsonSafe(policy);
  assertExactKeys(safe, POLICY_KEYS, "advanced resilience policy");
  if (safe.schema !== "jb.resilience.policy/v2" ||
      safe.mode !== "autonomous-advanced" ||
      typeof safe.policyId !== "string" || !POLICY_ID.test(safe.policyId)) {
    throw new TypeError("advanced resilience policy identity or mode is invalid");
  }
  validateBoundedInteger(safe.revision, 1, Number.MAX_SAFE_INTEGER, "policy revision");

  assertExactKeys(safe.validity, ["notBefore", "expiresAt"], "policy validity");
  assertExactKeys(safe.signature, ["keyId", "algorithm", "value"], "policy signature");
  if (typeof safe.signature.keyId !== "string" || !IDENTIFIER.test(safe.signature.keyId) ||
      typeof safe.signature.algorithm !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(safe.signature.algorithm) ||
      typeof safe.signature.value !== "string" ||
      safe.signature.value.length < 16 || safe.signature.value.length > 16_384) {
    throw new TypeError("policy signature metadata is invalid");
  }
  if (typeof safe.policyHash !== "string" || !/^[a-f0-9]{64}$/.test(safe.policyHash)) {
    throw new TypeError("policyHash must be a lowercase SHA-256 digest");
  }
  const defaults = validateDefaults(safe.defaults);
  const budgets = validateBudgets(safe.budgets);
  if (!Array.isArray(safe.services) || safe.services.length < 1 || safe.services.length > 100) {
    throw new TypeError("policy services must contain between 1 and 100 entries");
  }
  const seenIds = new Set();
  const services = safe.services.map((service) => validateService(service, seenIds));
  const normalized = Object.freeze({
    schema: safe.schema,
    policyId: safe.policyId,
    revision: safe.revision,
    mode: safe.mode,
    validity: Object.freeze({
      notBefore: safe.validity.notBefore,
      expiresAt: safe.validity.expiresAt
    }),
    signature: Object.freeze({
      keyId: safe.signature.keyId,
      algorithm: safe.signature.algorithm,
      value: safe.signature.value
    }),
    policyHash: safe.policyHash,
    defaults,
    budgets,
    services: Object.freeze(services)
  });
  verifyPolicySnapshot(normalized, verifySignature, now);
  return normalized;
}

function validateRequest(request) {
  let safe;
  try {
    safe = cloneJsonSafe(request);
  } catch {
    return { valid: false, reason: "invalid-capability-request" };
  }
  if (!isRecord(safe) ||
      Object.keys(safe).length !== 5 ||
      !["assetId", "environment", "incidentId", "action", "securityState"]
        .every((key) => Object.hasOwn(safe, key))) {
    return { valid: false, reason: "invalid-capability-request" };
  }
  if (typeof safe.assetId !== "string" || !IDENTIFIER.test(safe.assetId) ||
      typeof safe.environment !== "string" || !IDENTIFIER.test(safe.environment) ||
      typeof safe.incidentId !== "string" || !IDENTIFIER.test(safe.incidentId) ||
      typeof safe.action !== "string" || !Object.hasOwn(ACTION_RISK, safe.action) ||
      typeof safe.securityState !== "string" || !SECURITY_STATES.has(safe.securityState)) {
    return { valid: false, reason: "invalid-capability-request" };
  }
  return { valid: true, request: safe };
}

function evaluatePolicyCapability(policy, request, now) {
  const validated = validateRequest(request);
  if (!validated.valid) return Object.freeze({ permitted: false, reason: validated.reason });
  const input = validated.request;
  const service = policy.services.find((entry) => entry.id === input.assetId);
  if (!service) return Object.freeze({ permitted: false, reason: "asset-not-allowlisted" });
  if (service.environment !== input.environment) {
    return Object.freeze({ permitted: false, reason: "environment-mismatch" });
  }
  if (!service.allowedActions.includes(input.action)) {
    return Object.freeze({ permitted: false, reason: "action-not-allowlisted" });
  }

  const riskClass = ACTION_RISK[input.action];
  if (riskClass === "A0") {
    return Object.freeze({
      permitted: true, authorized: false, riskClass, reason: "read-only-capability",
      policyId: policy.policyId, revision: policy.revision, policyHash: policy.policyHash,
      assetId: service.id, action: input.action
    });
  }
  if (riskClass === "A2") {
    return Object.freeze({
      permitted: false, reason: input.securityState === "confirmed"
        ? "trusted-signal-gateway-not-certified"
        : "confirmed-security-verdict-required"
    });
  }
  if (riskClass === "A3") {
    return Object.freeze({ permitted: false, reason: "failover-control-plane-not-certified" });
  }
  if (input.securityState !== "clear") {
    return Object.freeze({ permitted: false, reason: "security-state-not-clear" });
  }
  if (riskClass === "A1") {
    if (service.tier !== "stateless" || service.criticality !== "standard") {
      return Object.freeze({ permitted: false, reason: "asset-not-eligible-for-a1" });
    }
    if (!EXECUTABLE_ACTIONS.has(input.action)) {
      return Object.freeze({ permitted: false, reason: "action-runtime-not-certified" });
    }
    if (input.action === "restart-service" && service.recovery?.requireApplicationHealth !== true) {
      return Object.freeze({ permitted: false, reason: "application-health-verification-required" });
    }
  }

  return Object.freeze({
    permitted: true,
    authorized: false,
    riskClass,
    reason: "policy-permits-bounded-action",
    policyId: policy.policyId,
    revision: policy.revision,
    policyHash: policy.policyHash,
    assetId: service.id,
    action: input.action
  });
}

function validateRevisionStore(store) {
  return isRecord(store) && typeof store.acceptRevision === "function";
}

function validateCapabilityLedger(ledger) {
  return isRecord(ledger) &&
    typeof ledger.reserveAction === "function" &&
    typeof ledger.assertReservation === "function" &&
    typeof ledger.completeAction === "function";
}

export function createMemoryPolicyRevisionStore() {
  const revisions = new Map();
  return Object.freeze({
    durable: false,
    async acceptRevision({ policyId, revision, policyHash }) {
      const current = revisions.get(policyId);
      if (current && (revision < current.revision ||
          (revision === current.revision && policyHash !== current.policyHash))) return false;
      if (!current || revision > current.revision) revisions.set(policyId, { revision, policyHash });
      return true;
    }
  });
}

export function createMemoryCapabilityLedger() {
  const entries = new Map();

  function isCounted(entry) {
    return entry.status === "pending" || entry.status === "completed";
  }

  function expirePending(now) {
    for (const entry of entries.values()) {
      if (entry.status === "pending" && now >= entry.expiresAt) entry.status = "expired";
    }
  }

  return Object.freeze({
    durable: false,
    async reserveAction({
      policyId, revision, policyHash, request, budgets, riskClass, now, expiresAt
    }) {
      expirePending(now);
      const existing = [...entries.values()];
      const incidentEntries = existing.filter((entry) =>
        entry.policyId === policyId && entry.incidentId === request.incidentId && isCounted(entry));
      const assetEntries = existing.filter((entry) =>
        entry.policyId === policyId && entry.assetId === request.assetId &&
        isCounted(entry) && now - entry.createdAt < 3_600_000);
      const concurrent = incidentEntries.filter((entry) => entry.status === "pending").length;
      if (concurrent >= budgets.maxConcurrentActionsPerIncident) {
        return { reserved: false, reason: "incident-concurrency-limit-reached" };
      }
      if (incidentEntries.length >= budgets.maxActionsPerIncident) {
        return { reserved: false, reason: "incident-action-budget-exhausted" };
      }
      if (assetEntries.length >= budgets.maxActionsPerAssetPerHour) {
        return { reserved: false, reason: "asset-hourly-budget-exhausted" };
      }
      if (riskClass === "A2" && incidentEntries.filter((entry) =>
        entry.action === "apply-containment-profile").length >=
        budgets.maxAutomaticContainmentsPerIncident) {
        return { reserved: false, reason: "containment-budget-exhausted" };
      }
      const reservationId = randomUUID();
      entries.set(reservationId, {
        reservationId, policyId, revision, policyHash,
        incidentId: request.incidentId, assetId: request.assetId,
        action: request.action, riskClass, createdAt: now, expiresAt, status: "pending"
      });
      return { reserved: true, reservationId };
    },
    async assertReservation({ reservationId, policyId, revision, policyHash, now }) {
      expirePending(now);
      const entry = entries.get(reservationId);
      return Boolean(entry && entry.status === "pending" &&
        entry.policyId === policyId && entry.revision === revision &&
        entry.policyHash === policyHash && now < entry.expiresAt);
    },
    async completeAction({ reservationId, outcome, completedAt }) {
      const entry = entries.get(reservationId);
      if (!entry || entry.status !== "pending") return false;
      if (!["succeeded", "failed", "unverified", "cancelled-before-execution"].includes(outcome)) {
        return false;
      }
      entry.status = outcome === "cancelled-before-execution" ? "cancelled" : "completed";
      entry.outcome = outcome;
      entry.completedAt = completedAt;
      return true;
    }
  });
}

export function createResiliencePolicyEngine({
  policy,
  verifyPolicySignature,
  policyRevisionStore,
  capabilityLedger,
  allowInMemoryStores = false,
  clock = Date.now,
  authorizationTtlMs = 30_000
} = {}) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (typeof allowInMemoryStores !== "boolean") throw new TypeError("allowInMemoryStores must be boolean");
  if (!validateRevisionStore(policyRevisionStore)) {
    throw new TypeError("policyRevisionStore must implement atomic acceptRevision");
  }
  if (!validateCapabilityLedger(capabilityLedger)) {
    throw new TypeError("capabilityLedger must implement reserve, assert and complete operations");
  }
  if (allowInMemoryStores !== true &&
      (policyRevisionStore.durable !== true || capabilityLedger.durable !== true)) {
    throw new TypeError("durable policy revision and capability stores are required");
  }
  if (!Number.isSafeInteger(authorizationTtlMs) ||
      authorizationTtlMs < 100 || authorizationTtlMs > 60_000) {
    throw new TypeError("authorizationTtlMs must be between 100 and 60000 milliseconds");
  }
  const initialNow = clock();
  const validatedPolicy = validateAdvancedResiliencePolicy(policy, {
    verifySignature: verifyPolicySignature,
    now: initialNow
  });
  const issued = new WeakSet();
  const completed = new WeakSet();

  function currentPolicy(now) {
    return verifyPolicySnapshot(validatedPolicy, verifyPolicySignature, now);
  }

  function evaluate(request) {
    const now = clock();
    try {
      currentPolicy(now);
    } catch {
      return Object.freeze({ permitted: false, reason: "policy-invalid-or-expired" });
    }
    return evaluatePolicyCapability(validatedPolicy, request, now);
  }

  async function authorize(request) {
    const now = clock();
    let integrity;
    try {
      integrity = currentPolicy(now);
    } catch {
      return Object.freeze({ authorized: false, reason: "policy-invalid-or-expired" });
    }
    const normalizedRequest = validateRequest(request);
    if (!normalizedRequest.valid) {
      return Object.freeze({ authorized: false, reason: normalizedRequest.reason });
    }
    const safeRequest = normalizedRequest.request;
    const decision = evaluatePolicyCapability(validatedPolicy, safeRequest, now);
    if (!decision.permitted || decision.riskClass === "A0") {
      return Object.freeze({
        authorized: false,
        permitted: decision.permitted,
        reason: decision.reason,
        riskClass: decision.riskClass ?? null
      });
    }

    let acceptedRevision = false;
    try {
      acceptedRevision = await policyRevisionStore.acceptRevision({
        policyId: validatedPolicy.policyId,
        revision: validatedPolicy.revision,
        policyHash: integrity.policyHash
      }) === true;
    } catch {
      acceptedRevision = false;
    }
    if (!acceptedRevision) {
      return Object.freeze({ authorized: false, reason: "policy-revision-rollback-or-store-failure" });
    }

    const expiresAt = Math.min(now + authorizationTtlMs, integrity.expiresAt);
    let reservation;
    try {
      reservation = await capabilityLedger.reserveAction({
        policyId: validatedPolicy.policyId,
        revision: validatedPolicy.revision,
        policyHash: integrity.policyHash,
        request: safeRequest,
        budgets: validatedPolicy.budgets,
        riskClass: decision.riskClass,
        now,
        expiresAt
      });
    } catch {
      reservation = null;
    }
    if (!reservation?.reserved || typeof reservation.reservationId !== "string") {
      return Object.freeze({
        authorized: false,
        reason: typeof reservation?.reason === "string"
          ? reservation.reason : "capability-ledger-unavailable"
      });
    }

    const authorization = Object.freeze({
      authorizationId: randomUUID(),
      policyId: validatedPolicy.policyId,
      revision: validatedPolicy.revision,
      policyHash: integrity.policyHash,
      assetId: safeRequest.assetId,
      environment: safeRequest.environment,
      incidentId: safeRequest.incidentId,
      action: safeRequest.action,
      riskClass: decision.riskClass,
      reservationId: reservation.reservationId,
      issuedAt: now,
      expiresAt
    });
    issued.add(authorization);
    return Object.freeze({ authorized: true, authorization });
  }

  async function assertAuthorization({ authorization } = {}) {
    if (!authorization || typeof authorization !== "object" || !issued.has(authorization) ||
        completed.has(authorization)) {
      return Object.freeze({ valid: false, reason: "unknown-or-consumed-authorization" });
    }
    const now = clock();
    let integrity;
    try {
      integrity = currentPolicy(now);
    } catch {
      return Object.freeze({ valid: false, reason: "policy-invalid-or-expired" });
    }
    if (now >= authorization.expiresAt ||
        authorization.policyId !== validatedPolicy.policyId ||
        authorization.revision !== validatedPolicy.revision ||
        authorization.policyHash !== integrity.policyHash) {
      return Object.freeze({ valid: false, reason: "authorization-expired-or-stale" });
    }
    let acceptedRevision = false;
    let reserved = false;
    try {
      acceptedRevision = await policyRevisionStore.acceptRevision({
        policyId: validatedPolicy.policyId,
        revision: validatedPolicy.revision,
        policyHash: integrity.policyHash
      }) === true;
      if (acceptedRevision) {
        reserved = await capabilityLedger.assertReservation({
          reservationId: authorization.reservationId,
          policyId: authorization.policyId,
          revision: authorization.revision,
          policyHash: authorization.policyHash,
          now
        }) === true;
      }
    } catch {
      reserved = false;
    }
    if (!acceptedRevision) {
      return Object.freeze({ valid: false, reason: "policy-revision-rollback-or-store-failure" });
    }
    return reserved
      ? Object.freeze({ valid: true, reason: null })
      : Object.freeze({ valid: false, reason: "capability-reservation-invalid-or-expired" });
  }

  async function completeAuthorization({ authorization, outcome } = {}) {
    if (!authorization || typeof authorization !== "object" || !issued.has(authorization) ||
        completed.has(authorization)) {
      return Object.freeze({ recorded: false, reason: "unknown-or-consumed-authorization" });
    }
    const now = clock();
    if (!["succeeded", "failed", "unverified", "cancelled-before-execution"].includes(outcome)) {
      return Object.freeze({ recorded: false, reason: "invalid-action-outcome" });
    }
    let recorded = false;
    try {
      recorded = await capabilityLedger.completeAction({
        reservationId: authorization.reservationId,
        outcome,
        completedAt: now
      }) === true;
    } catch {
      recorded = false;
    }
    if (!recorded) return Object.freeze({ recorded: false, reason: "capability-ledger-finalization-failed" });
    completed.add(authorization);
    return Object.freeze({ recorded: true, reason: null });
  }

  return Object.freeze({
    engine: "JB Resilience Policy Engine",
    version: "0.3.0",
    schema: validatedPolicy.schema,
    mode: validatedPolicy.mode,
    policy: validatedPolicy,
    evaluate,
    authorize,
    assertAuthorization,
    completeAuthorization
  });
}

export { ACTION_RISK };
