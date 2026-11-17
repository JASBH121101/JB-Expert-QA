import test from "node:test";
import assert from "node:assert/strict";
import {
  computeAdvancedPolicyHash,
  createMemoryCapabilityLedger,
  createMemoryPolicyRevisionStore,
  createResiliencePolicyEngine,
  validateAdvancedResiliencePolicy
} from "../src/policy-engine.js";

const NOW = Date.parse("2026-11-16T19:00:00Z");
const REQUEST = Object.freeze({
  assetId: "catalog-api-01",
  environment: "production",
  incidentId: "incident-2026-001",
  action: "restart-service",
  securityState: "clear",
  health: { consecutiveFailures: 3, lastRestartAt: null }
});

function makePolicy(overrides = {}) {
  const service = {
    id: "catalog-api-01",
    environment: "production",
    tier: "stateless",
    criticality: "standard",
    allowedActions: ["restart-service"],
    recovery: {
      failureThreshold: 3,
      maxRestartsPerHour: 2,
      cooldownMs: 300_000,
      requireApplicationHealth: true
    },
    containmentProfile: null,
    failoverProfile: null
  };
  const policy = {
    schema: "jb.resilience.policy/v2",
    policyId: "jb-prod-continuity",
    revision: 1,
    mode: "autonomous-advanced",
    validity: {
      notBefore: "2026-11-01T00:00:00Z",
      expiresAt: "2026-12-01T00:00:00Z"
    },
    signature: {
      keyId: "continuity-policy-owner-01",
      algorithm: "test-ed25519",
      value: "signed-policy-fixture-value"
    },
    policyHash: "0".repeat(64),
    defaults: {
      decision: "deny",
      unknownSignal: "hold-and-escalate",
      staleSignal: "hold-and-escalate",
      ledgerUnavailable: "block-mutations",
      policyInvalid: "block-mutations",
      preserveEvidence: true,
      requireDurableAudit: true
    },
    budgets: {
      maxConcurrentActionsPerIncident: 1,
      maxActionsPerIncident: 3,
      maxActionsPerAssetPerHour: 2,
      maxAutomaticContainmentsPerIncident: 1
    },
    services: [service],
    ...overrides
  };
  policy.policyHash = computeAdvancedPolicyHash(policy);
  return policy;
}

const verifySignature = ({ signature }) => signature.value === "signed-policy-fixture-value";

function makeEngine(policy = makePolicy(), options = {}) {
  const policyRevisionStore = options.policyRevisionStore ?? createMemoryPolicyRevisionStore();
  if (typeof policyRevisionStore.setCurrentPolicy === "function") {
    policyRevisionStore.setCurrentPolicy({
      policyId: policy.policyId,
      revision: policy.revision,
      policyHash: policy.policyHash
    });
  }
  return createResiliencePolicyEngine({
    policy,
    verifyPolicySignature: verifySignature,
    policyRevisionStore,
    capabilityLedger: options.capabilityLedger ?? createMemoryCapabilityLedger(),
    allowInMemoryStores: true,
    clock: options.clock ?? (() => NOW),
    authorizationTtlMs: options.authorizationTtlMs ?? 30_000
  });
}

test("valid v2 policy is normalized, frozen and signature-verified", () => {
  const input = makePolicy();
  const policy = validateAdvancedResiliencePolicy(input, {
    verifySignature, now: NOW
  });
  assert.equal(policy.schema, "jb.resilience.policy/v2");
  assert.equal(policy.mode, "autonomous-advanced");
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.services[0].allowedActions), true);
});

test("policy hash detects content tampering", () => {
  const policy = makePolicy();
  policy.services[0].environment = "staging";
  assert.throws(() => validateAdvancedResiliencePolicy(policy, {
    verifySignature, now: NOW
  }), /policy hash does not match/);
});

test("unsigned, invalid and asynchronous signature verifiers fail closed", () => {
  const policy = makePolicy();
  assert.throws(() => validateAdvancedResiliencePolicy(policy, {
    verifySignature: () => false, now: NOW
  }), /signature verification failed/);
  assert.throws(() => validateAdvancedResiliencePolicy(policy, {
    verifySignature: async () => true, now: NOW
  }), /signature verification failed/);
  assert.throws(() => validateAdvancedResiliencePolicy(policy, { now: NOW }),
    /cryptographic verifySignature/);
});

test("expired, not-yet-valid and malformed policy validity windows are rejected", () => {
  const policy = makePolicy();
  assert.throws(() => validateAdvancedResiliencePolicy(policy, {
    verifySignature, now: Date.parse("2026-12-01T00:00:00Z")
  }), /not currently valid/);
  const future = makePolicy({
    validity: { notBefore: "2026-11-17T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z" }
  });
  assert.throws(() => validateAdvancedResiliencePolicy(future, {
    verifySignature, now: NOW
  }), /not currently valid/);
  const malformed = makePolicy({
    validity: { notBefore: "tomorrow", expiresAt: "2026-12-01T00:00:00Z" }
  });
  assert.throws(() => validateAdvancedResiliencePolicy(malformed, {
    verifySignature, now: NOW
  }), /ISO-8601/);
});

test("unknown fields, wildcard services and duplicate capabilities are rejected", () => {
  const extra = makePolicy({ hiddenGrant: true });
  assert.throws(() => validateAdvancedResiliencePolicy(extra, {
    verifySignature, now: NOW
  }), /missing or unsupported fields/);

  const wildcard = makePolicy();
  wildcard.services[0].id = "*";
  wildcard.policyHash = computeAdvancedPolicyHash(wildcard);
  assert.throws(() => validateAdvancedResiliencePolicy(wildcard, {
    verifySignature, now: NOW
  }), /exact identifiers/);

  const duplicate = makePolicy();
  duplicate.services[0].allowedActions = ["restart-service", "restart-service"];
  duplicate.policyHash = computeAdvancedPolicyHash(duplicate);
  assert.throws(() => validateAdvancedResiliencePolicy(duplicate, {
    verifySignature, now: NOW
  }), /unknown, duplicate or wildcard/);
});

test("unlisted actions and privilege-escalating action names are rejected", () => {
  for (const action of ["*", "execute-command", "run-shell", "delete-files", "disable-security-control"]) {
    const policy = makePolicy();
    policy.services[0].allowedActions = [action];
    policy.policyHash = computeAdvancedPolicyHash(policy);
    assert.throws(() => validateAdvancedResiliencePolicy(policy, {
      verifySignature, now: NOW
    }), /unknown, duplicate or wildcard/);
  }
});

test("A1 restart requires an exact allowlist entry, production environment match and clear security state", () => {
  const engine = makeEngine();
  assert.equal(engine.evaluate(REQUEST).permitted, true);
  assert.equal(engine.evaluate({ ...REQUEST, assetId: "other-service" }).reason, "asset-not-allowlisted");
  assert.equal(engine.evaluate({ ...REQUEST, environment: "staging" }).reason, "environment-mismatch");
  assert.equal(engine.evaluate({ ...REQUEST, securityState: "unknown" }).reason, "security-state-not-clear");
  assert.equal(engine.evaluate({ ...REQUEST, securityState: "suspected" }).reason, "security-state-not-clear");
  assert.equal(engine.evaluate({
    ...REQUEST, health: { consecutiveFailures: 2, lastRestartAt: null }
  }).reason, "failure-threshold-not-reached");
  assert.equal(engine.evaluate({
    ...REQUEST, health: { consecutiveFailures: 3, lastRestartAt: NOW - 1000 }
  }).reason, "restart-cooldown-active");
  assert.equal(engine.evaluate({
    ...REQUEST, health: { consecutiveFailures: 3, lastRestartAt: NOW + 1000 }
  }).reason, "health-clock-inconsistency");
  assert.equal(engine.evaluate({ ...REQUEST, health: null }).reason, "health-evidence-required");
  assert.equal(engine.evaluate({ ...REQUEST, action: "failover" }).reason, "action-not-allowlisted");
});

test("A1 restart is not granted to stateful, critical or data-bearing services", () => {
  for (const [tier, criticality] of [
    ["stateful", "standard"], ["stateless", "high"], ["data-bearing", "critical"]
  ]) {
    const policy = makePolicy();
    policy.services[0].tier = tier;
    policy.services[0].criticality = criticality;
    policy.policyHash = computeAdvancedPolicyHash(policy);
    assert.throws(() => validateAdvancedResiliencePolicy(policy, {
      verifySignature, now: NOW
    }), /autonomous restart is restricted/);
  }
});

test("A2 and A3 remain denied until trusted A2 authorization and the A3 failover control plane are certified", () => {
  const containment = makePolicy();
  containment.services[0].allowedActions = ["apply-containment-profile"];
  containment.services[0].recovery = null;
  containment.services[0].containmentProfile = "approved-containment";
  containment.policyHash = computeAdvancedPolicyHash(containment);
  const containmentEngine = makeEngine(containment);
  assert.equal(containmentEngine.evaluate({
    ...REQUEST, action: "apply-containment-profile", securityState: "confirmed"
  }).reason, "a2-trusted-evidence-context-required");
  assert.equal(containmentEngine.evaluate({
    ...REQUEST, action: "apply-containment-profile", securityState: "unknown"
  }).reason, "confirmed-security-verdict-required");

  const failover = makePolicy();
  failover.services[0].allowedActions = ["failover"];
  failover.services[0].recovery = null;
  failover.services[0].failoverProfile = "regional-failover-01";
  failover.policyHash = computeAdvancedPolicyHash(failover);
  const failoverEngine = makeEngine(failover);
  assert.equal(failoverEngine.evaluate({
    ...REQUEST, action: "failover"
  }).reason, "failover-control-plane-not-certified");
});

test("policy revision registry requires owner activation and rejects rollback/hash substitution", async () => {
  const store = createMemoryPolicyRevisionStore();
  const first = { policyId: "jb-prod-continuity", revision: 4, policyHash: "a".repeat(64) };
  assert.equal(await store.assertCurrent(first), false);
  assert.equal(store.setCurrentPolicy(first), true);
  assert.equal(await store.assertCurrent(first), true);
  assert.equal(store.setCurrentPolicy({ ...first, policyHash: "b".repeat(64) }), false);
  assert.equal(store.setCurrentPolicy({ ...first, revision: 3 }), false);
  const next = { ...first, revision: 5 };
  assert.equal(store.setCurrentPolicy(next), true);
  assert.equal(await store.assertCurrent(first), false);
  assert.equal(await store.assertCurrent(next), true);
});

test("old authorization becomes invalid as soon as a newer policy revision is accepted", async () => {
  const revisionStore = createMemoryPolicyRevisionStore();
  const ledger = createMemoryCapabilityLedger();
  const oldEngine = makeEngine(makePolicy({ revision: 1 }), { policyRevisionStore: revisionStore, capabilityLedger: ledger });
  const first = await oldEngine.authorize(REQUEST);
  assert.equal(first.authorized, true);

  const newEngine = makeEngine(makePolicy({ revision: 2 }), { policyRevisionStore: revisionStore, capabilityLedger: ledger });
  const second = await newEngine.authorize({
    ...REQUEST, incidentId: "incident-2026-002"
  });
  assert.equal(second.authorized, true);
  assert.deepEqual(
    await oldEngine.assertAuthorization({ authorization: first.authorization, request: REQUEST }),
    { valid: false, reason: "policy-revision-not-current-or-store-failure" }
  );
});

test("durable stores are mandatory unless test-only in-memory mode is explicitly selected", () => {
  assert.throws(() => createResiliencePolicyEngine({
    policy: makePolicy(),
    verifyPolicySignature: verifySignature,
    policyRevisionStore: createMemoryPolicyRevisionStore(),
    capabilityLedger: createMemoryCapabilityLedger(),
    clock: () => NOW
  }), /durable policy revision and capability stores are required/);
});

test("capability reservations enforce per-incident concurrency and action budgets", async () => {
  const policy = makePolicy({
    budgets: {
      maxConcurrentActionsPerIncident: 1,
      maxActionsPerIncident: 2,
      maxActionsPerAssetPerHour: 2,
      maxAutomaticContainmentsPerIncident: 1
    }
  });
  const engine = makeEngine(policy);
  const [first, second] = await Promise.all([
    engine.authorize(REQUEST),
    engine.authorize(REQUEST)
  ]);
  assert.equal([first, second].filter((entry) => entry.authorized).length, 1);
  const accepted = first.authorized ? first : second;
  const denied = first.authorized ? second : first;
  assert.equal(denied.reason, "incident-concurrency-limit-reached");
  assert.equal((await engine.assertAuthorization({
    authorization: accepted.authorization, request: REQUEST
  })).valid, true);
  assert.equal((await engine.completeAuthorization({
    authorization: accepted.authorization, outcome: "succeeded"
  })).recorded, true);

  const next = await engine.authorize(REQUEST);
  assert.equal(next.authorized, true);
  assert.equal((await engine.assertAuthorization({
    authorization: next.authorization, request: REQUEST
  })).valid, true);
  assert.equal((await engine.completeAuthorization({
    authorization: next.authorization, outcome: "succeeded"
  })).recorded, true);

  const exhausted = await engine.authorize(REQUEST);
  assert.equal(exhausted.authorized, false);
  assert.equal(exhausted.reason, "incident-action-budget-exhausted");
});

test("service maxRestartsPerHour narrows the global hourly asset budget", async () => {
  const policy = makePolicy({
    budgets: {
      maxConcurrentActionsPerIncident: 1,
      maxActionsPerIncident: 3,
      maxActionsPerAssetPerHour: 3,
      maxAutomaticContainmentsPerIncident: 1
    }
  });
  policy.services[0].recovery.maxRestartsPerHour = 1;
  policy.policyHash = computeAdvancedPolicyHash(policy);
  const engine = makeEngine(policy);
  const first = await engine.authorize(REQUEST);
  assert.equal(first.authorized, true);
  assert.equal((await engine.assertAuthorization({
    authorization: first.authorization, request: REQUEST
  })).valid, true);
  await engine.completeAuthorization({ authorization: first.authorization, outcome: "succeeded" });
  const second = await engine.authorize(REQUEST);
  assert.equal(second.authorized, false);
  assert.equal(second.reason, "asset-hourly-budget-exhausted");
});

test("capability ledger and revision-store failures block authorization", async () => {
  const failingRevisionStore = {
    durable: true,
    async assertCurrent() { throw new Error("database unavailable"); }
  };
  const engine = makeEngine(makePolicy(), { policyRevisionStore: failingRevisionStore });
  assert.equal((await engine.authorize(REQUEST)).reason, "policy-revision-not-current-or-store-failure");

  const failingLedger = {
    durable: true,
    async reserveAction() { throw new Error("ledger unavailable"); },
    async assertReservation() { return false; },
    async completeAction() { return false; }
  };
  const other = makeEngine(makePolicy(), { capabilityLedger: failingLedger });
  assert.equal((await other.authorize(REQUEST)).reason, "capability-ledger-unavailable");
});

test("authorization is short-lived, rechecks policy validity and is one-time completed", async () => {
  let now = NOW;
  const engine = makeEngine(makePolicy(), { clock: () => now, authorizationTtlMs: 1000 });
  const result = await engine.authorize(REQUEST);
  assert.equal(result.authorized, true);
  assert.equal((await engine.assertAuthorization({ authorization: result.authorization, request: REQUEST })).valid, true);
  now += 1000;
  assert.equal((await engine.assertAuthorization({ authorization: result.authorization, request: REQUEST })).reason,
    "authorization-already-asserted-or-checking");
  // A successful execution may be finalized after the TTL if the one-time pre-execution
  // assertion was valid before expiry.
  assert.equal((await engine.completeAuthorization({
    authorization: result.authorization, outcome: "succeeded"
  })).recorded, true);
  assert.equal((await engine.completeAuthorization({
    authorization: result.authorization, outcome: "succeeded"
  })).recorded, false);
});

test("authorization rechecks live security and health conditions immediately before use", async () => {
  const engine = makeEngine();
  const result = await engine.authorize(REQUEST);
  assert.equal(result.authorized, true);
  const changed = await engine.assertAuthorization({
    authorization: result.authorization,
    request: { ...REQUEST, securityState: "suspected" }
  });
  assert.equal(changed.valid, false);
  assert.equal(changed.reason, "capability-conditions-no-longer-met");
});


test("successful outcomes require a one-time pre-execution authorization assertion", async () => {
  const engine = makeEngine();
  const result = await engine.authorize(REQUEST);
  assert.equal(result.authorized, true);
  assert.deepEqual(
    await engine.completeAuthorization({
      authorization: result.authorization, outcome: "succeeded"
    }),
    { recorded: false, reason: "execution-authorization-not-asserted" }
  );
  assert.equal((await engine.assertAuthorization({
    authorization: result.authorization, request: REQUEST
  })).valid, true);
  assert.equal((await engine.assertAuthorization({
    authorization: result.authorization, request: REQUEST
  })).reason, "authorization-already-asserted-or-checking");
  assert.equal((await engine.completeAuthorization({
    authorization: result.authorization, outcome: "succeeded"
  })).recorded, true);
});


test("authorization expiry is rechecked after asynchronous policy-store verification", async () => {
  let now = NOW;
  let revisionChecks = 0;
  const revisionStore = {
    durable: true,
    async assertCurrent() {
      revisionChecks += 1;
      if (revisionChecks === 2) now += 1000;
      return true;
    }
  };
  const ledger = {
    durable: true,
    async reserveAction() {
      return { reserved: true, reservationId: "reservation-12345678" };
    },
    async assertReservation({ now: checkedAt }) {
      return checkedAt < NOW + 1000;
    },
    async completeAction() { return true; }
  };
  const engine = createResiliencePolicyEngine({
    policy: makePolicy(),
    verifyPolicySignature: verifySignature,
    policyRevisionStore: revisionStore,
    capabilityLedger: ledger,
    clock: () => now,
    authorizationTtlMs: 1000
  });
  const result = await engine.authorize(REQUEST);
  assert.equal(result.authorized, true);
  assert.deepEqual(
    await engine.assertAuthorization({ authorization: result.authorization, request: REQUEST }),
    { valid: false, reason: "authorization-expired-or-stale" }
  );
});

test("signature is checked again before each authorization", async () => {
  let valid = true;
  const engine = createResiliencePolicyEngine({
    policy: makePolicy(),
    verifyPolicySignature: () => valid,
    policyRevisionStore: createMemoryPolicyRevisionStore(),
    capabilityLedger: createMemoryCapabilityLedger(),
    allowInMemoryStores: true,
    clock: () => NOW
  });
  valid = false;
  assert.equal((await engine.authorize(REQUEST)).reason, "policy-invalid-or-expired");
});
