import test from "node:test";
import assert from "node:assert/strict";
import { createResponseOrchestrator } from "../src/response-orchestrator.js";
import { createIncidentCorrelationEngine } from "../src/incident-correlation-engine.js";
import {
  computeAdvancedPolicyHash,
  createMemoryCapabilityLedger,
  createMemoryPolicyRevisionStore,
  createResiliencePolicyEngine
} from "../src/policy-engine.js";

const NOW = Date.parse("2026-11-16T20:00:00Z");

function trustedIncidentInput(overrides = {}) {
  return {
    schema: "jb.resilience.incident-input/v1",
    assetId: "host-erp-01",
    environment: "production",
    serviceId: "catalog-api",
    securityState: { state: "clear" },
    healthObservations: [],
    ...overrides
  };
}

function incidentDecision(overrides = {}) {
  return {
    schema: "jb.resilience.incident-decision/v1",
    incidentId: "incident-0001",
    assetId: "host-erp-01",
    environment: "production",
    serviceId: "catalog-api",
    security: { state: "clear", reason: "all-required-sources-clear" },
    health: { state: "unhealthy", consecutiveFailures: 3 },
    decision: "review-recovery-policy",
    recommendedNextStep: "evaluate-a1-policy-separately",
    decisionRule: "HEALTH_FAILURE_THRESHOLD",
    trace: [{
      ruleId: "HEALTH_FAILURE_THRESHOLD",
      matched: true,
      selected: true
    }],
    evidenceRefs: [],
    preserveEvidence: true,
    authorizationGranted: false,
    mayAuthorizeRecovery: false,
    ...overrides
  };
}

function realV05IncidentInput(overrides = {}) {
  return {
    schema: "jb.resilience.incident-input/v1",
    assetId: "host-erp-01",
    environment: "production",
    serviceId: "catalog-api",
    securityState: {
      schema: "jb.resilience.signal-state/v1",
      state: "clear",
      reason: "all-sources-clear",
      assetId: "host-erp-01",
      environment: "production",
      sources: [{
        sourceId: "guard-01",
        sourceEngine: "security-guard",
        state: "clear",
        issuedAtMs: NOW,
        reasonCode: "GUARD_CLEAR"
      }],
      evidenceRefs: [],
      preserveEvidence: true,
      authorizationGranted: false
    },
    healthObservations: [{
      schema: "jb.resilience.health-observation/v1",
      observationId: "11111111-1111-4111-8111-111111111111",
      assetId: "host-erp-01",
      environment: "production",
      serviceId: "catalog-api",
      observedAtMs: NOW,
      status: "unhealthy",
      consecutiveFailures: 3,
      reasonCode: "SERVICE_FAILURE"
    }],
    ...overrides
  };
}

function harness(overrides = {}) {
  const calls = {
    trustedInput: 0,
    evaluated: 0,
    authorized: 0,
    asserted: 0,
    completed: [],
    restart: 0,
    serviceVerify: 0,
    applicationVerify: 0,
    states: [],
    audit: [],
    actionCompletions: [],
    outcomes: []
  };
  const decision = overrides.decision ?? incidentDecision();
  const authorization = Object.freeze({
    authorizationId: "authorization-0001",
    policyId: "jb-prod",
    revision: 4,
    policyHash: "a".repeat(64),
    assetId: "host-erp-01",
    environment: "production",
    incidentId: "incident-0001",
    action: "restart-service",
    riskClass: "A1",
    reservationId: "reservation-0001",
    expiresAt: NOW + 30_000
  });
  const orchestrationStore = {
    durable: overrides.durable ?? true,
    async recordIncidentState(record) {
      calls.states.push(record);
      return overrides.recordIncidentState ? overrides.recordIncidentState(record) : true;
    },
    async getServiceState() {
      return overrides.serviceState ?? { lastActionAt: null };
    },
    async getCircuitState() {
      return overrides.circuitState ?? { open: false, retryAtMs: null };
    },
    async claimAction(input) {
      if (overrides.claimAction) return overrides.claimAction(input);
      return { claimed: true, actionId: "action-0001" };
    },
    async completeAction(input) {
      calls.actionCompletions.push(input);
      return overrides.completeAction ? overrides.completeAction(input) : true;
    },
    async recordActionOutcome(input) {
      calls.outcomes.push(input);
      return overrides.recordActionOutcome ? overrides.recordActionOutcome(input) : true;
    }
  };
  const auditStore = {
    durable: overrides.durable ?? true,
    async append(entry) {
      calls.audit.push(entry);
      return overrides.appendAudit ? overrides.appendAudit(entry) : true;
    }
  };
  const policyEngine = {
    policy: { policyId: "jb-prod", revision: 4, policyHash: "a".repeat(64) },
    evaluate(request) {
      calls.evaluated += 1;
      calls.request = request;
      return overrides.policyDecision ?? {
        permitted: true,
        riskClass: "A1",
        action: "restart-service",
        assetId: "host-erp-01",
        reason: "policy-permits-bounded-action"
      };
    },
    async authorize(request) {
      calls.authorized += 1;
      calls.authorizeRequest = request;
      return overrides.authorizationResult ?? { authorized: true, authorization };
    },
    async assertAuthorization(input) {
      calls.asserted += 1;
      calls.assertRequest = input.request;
      return typeof overrides.assertResult === "function"
        ? overrides.assertResult(input, calls.asserted)
        : overrides.assertResult ?? { valid: true };
    },
    async completeAuthorization(input) {
      calls.completed.push(input.outcome);
      return overrides.completeAuthorization ? overrides.completeAuthorization(input) : { recorded: true };
    }
  };
  const adapter = {
    platform: "linux-systemd",
    async restartService(serviceId) {
      calls.restart += 1;
      calls.restartServiceId = serviceId;
      if (overrides.restartError) throw new Error(overrides.restartError);
      return { exitCode: 0 };
    },
    async verifyService(serviceId) {
      calls.serviceVerify += 1;
      calls.verifyServiceId = serviceId;
      return overrides.serviceVerification ?? { healthy: true, state: "active" };
    }
  };
  const orchestrator = createResponseOrchestrator({
    incidentEngine: overrides.incidentEngine ?? {
      evaluateIncident() {
        calls.incidentEvaluations = (calls.incidentEvaluations ?? 0) + 1;
        return decision;
      }
    },
    policyEngine,
    adapter,
    applicationHealthCheck: async () => {
      calls.applicationVerify += 1;
      return overrides.applicationVerification ?? { healthy: true };
    },
    trustedInputVerifier: async () => {
      calls.trustedInput += 1;
      return overrides.trustedInput ?? true;
    },
    targetBindingVerifier: async (binding) => {
      calls.targetBinding ??= [];
      calls.targetBinding.push(binding);
      return overrides.targetBindingValid ?? true;
    },
    mutationControl: {
      async assertAllowed(context) {
        calls.mutationChecks = (calls.mutationChecks ?? 0) + 1;
        calls.mutationPhases ??= [];
        calls.mutationPhases.push(context.phase);
        return overrides.mutationAllowed
          ? overrides.mutationAllowed(context, calls.mutationChecks)
          : true;
      }
    },
    orchestrationStore,
    auditStore,
    allowInMemoryStores: overrides.allowInMemoryStores ?? false,
    clock: () => NOW
  });
  return { orchestrator, calls, orchestrationStore, auditStore, policyEngine };
}

test("executes only a policy-authorized A1 restart and verifies both service and application health", async () => {
  const h = harness();
  const result = await h.orchestrator.executeIncident(trustedIncidentInput());

  assert.equal(result.schema, "jb.resilience.orchestration-result/v1");
  assert.equal(result.state, "RECOVERED");
  assert.equal(result.action, "restart-service");
  assert.equal(result.executed, true);
  assert.equal(result.verified, true);
  assert.equal(result.authorizationGranted, false);
  assert.equal(h.calls.restart, 1);
  assert.equal(h.calls.restartServiceId, "catalog-api");
  assert.equal(h.calls.serviceVerify, 1);
  assert.equal(h.calls.applicationVerify, 1);
  assert.deepEqual(h.calls.completed, ["succeeded"]);
  assert.equal(h.calls.states.some((entry) => entry.state === "EXECUTING"), true);
  assert.equal(h.calls.states.some((entry) => entry.state === "RECOVERED"), true);
  assert.equal(h.calls.audit.some((entry) => entry.event === "a1-plan-created"), true);
  assert.equal(h.calls.audit.some((entry) => entry.event === "authorization-issued"), true);
  assert.equal(h.calls.audit.some((entry) => entry.event === "execution-intent-recorded"), true);
  assert.equal(h.calls.audit.some((entry) => entry.event === "action-verified"), true);
  assert.deepEqual(
    h.calls.states.map((entry) => entry.state).filter((state) =>
      ["PLANNED", "AUTHORIZED", "EXECUTING", "VERIFYING", "RECOVERED"].includes(state)
    ),
    ["PLANNED", "AUTHORIZED", "EXECUTING", "VERIFYING", "RECOVERED"]
  );
});

test("rejects input whose provenance is not confirmed by the trusted host verifier", async () => {
  const h = harness({ trustedInput: false });
  const result = await h.orchestrator.executeIncident(trustedIncidentInput({ source: "untrusted-client" }));

  assert.equal(result.state, "FAILED_CLOSED");
  assert.equal(result.reason, "trusted-input-rejected");
  assert.equal(h.calls.incidentEvaluations, undefined);
  assert.equal(h.calls.restart, 0);
});

test("suspected, unknown, stale, confirmed, tampered and conflicting security states never reach the policy gate", async () => {
  for (const securityState of ["suspected", "unknown", "stale", "confirmed", "tampered", "conflicting"]) {
    const h = harness({
      decision: incidentDecision({
        security: { state: securityState, reason: "not-clear" },
        decision: "escalate",
        recommendedNextStep: "hold-and-human-review",
        decisionRule: "SECURITY_" + securityState.toUpperCase()
      })
    });
    const result = await h.orchestrator.executeIncident(trustedIncidentInput());

    assert.equal(result.state, "ESCALATED", securityState);
    assert.equal(h.calls.evaluated, 0, securityState);
    assert.equal(h.calls.authorized, 0, securityState);
    assert.equal(h.calls.restart, 0, securityState);
  }
});

test("does not execute when the policy gate denies the exact A1 capability", async () => {
  const h = harness({ policyDecision: { permitted: false, reason: "action-not-allowlisted" } });
  const result = await h.orchestrator.executeIncident({});

  assert.equal(result.state, "HELD");
  assert.equal(result.reason, "action-not-allowlisted");
  assert.equal(h.calls.authorized, 0);
  assert.equal(h.calls.restart, 0);
});

test("duplicate action claim is a no-op and cannot trigger a second mutation", async () => {
  const h = harness({
    claimAction: async () => ({ claimed: false, reason: "idempotency-key-already-claimed" })
  });
  const result = await h.orchestrator.executeIncident({});

  assert.equal(result.state, "HELD");
  assert.equal(result.reason, "idempotency-key-already-claimed");
  assert.equal(h.calls.authorized, 0);
  assert.equal(h.calls.restart, 0);
});

test("rechecks the mutation stop switch immediately before adapter invocation", async () => {
  const h = harness({
    mutationAllowed: (_context, count) => count === 1
  });
  const result = await h.orchestrator.executeIncident({});

  assert.equal(result.state, "HELD");
  assert.equal(result.reason, "mutation-stopped");
  assert.deepEqual(h.calls.mutationPhases, ["pre-authorization", "immediately-before-execution"]);
  assert.equal(h.calls.restart, 0);
  assert.deepEqual(h.calls.completed, ["cancelled-before-execution"]);
});

test("an unavailable audit sink blocks action execution", async () => {
  const h = harness({
    appendAudit: async (entry) => entry.event !== "action-authorized"
  });
  const result = await h.orchestrator.executeIncident({});

  assert.equal(result.state, "HELD");
  assert.equal(result.reason, "pre-execution-audit-or-state-write-failed");
  assert.equal(h.calls.restart, 0);
  assert.deepEqual(h.calls.completed, ["cancelled-before-execution"]);
});

test("a failed service or application health check is never reported as recovered", async () => {
  for (const overrides of [
    { serviceVerification: { healthy: false, state: "inactive" } },
    { applicationVerification: { healthy: false } }
  ]) {
    const h = harness(overrides);
    const result = await h.orchestrator.executeIncident({});

    assert.equal(result.state, "RECONCILIATION_REQUIRED");
    assert.equal(result.executed, true);
    assert.equal(result.verified, false);
    assert.equal(h.calls.completed[0], "unverified");
    assert.equal(h.calls.outcomes[0].outcome, "unverified");
  }
});

test("an open circuit breaker holds the incident without authorizing or executing", async () => {
  const h = harness({ circuitState: { open: true, retryAtMs: NOW + 60_000 } });
  const result = await h.orchestrator.executeIncident({});

  assert.equal(result.state, "HELD");
  assert.equal(result.reason, "circuit-breaker-open");
  assert.equal(h.calls.authorized, 0);
  assert.equal(h.calls.restart, 0);
});

test("rejects volatile orchestration and audit stores unless test-only opt-in is explicit", () => {
  assert.throws(() => harness({ durable: false }), /durable orchestration and audit stores are required/);
  assert.doesNotThrow(() => harness({ durable: false, allowInMemoryStores: true }));
});

test("unknown or non-recovery v0.5 decisions remain read-only", async () => {
  const h = harness({
    decision: incidentDecision({
      health: { state: "healthy", consecutiveFailures: 0 },
      decision: "observe",
      recommendedNextStep: "none",
      decisionRule: "ALL_CLEAR"
    })
  });
  const result = await h.orchestrator.executeIncident({});

  assert.equal(result.state, "OBSERVING");
  assert.equal(result.executed, false);
  assert.equal(h.calls.evaluated, 0);
  assert.equal(h.calls.restart, 0);
});


test("rejects an asset-to-service mapping not approved by the host registry", async () => {
  const h = harness({ targetBindingValid: false });
  const result = await h.orchestrator.executeIncident({});

  assert.equal(result.state, "FAILED_CLOSED");
  assert.equal(result.reason, "asset-service-binding-rejected");
  assert.equal(h.calls.targetBinding.length, 1);
  assert.deepEqual(h.calls.targetBinding[0], {
    assetId: "host-erp-01",
    environment: "production",
    serviceId: "catalog-api",
    platform: "linux-systemd"
  });
  assert.equal(h.calls.evaluated, 0);
  assert.equal(h.calls.restart, 0);
});

test("rejects a policy result that claims permission outside A1 restart-service", async () => {
  const h = harness({
    policyDecision: {
      permitted: true,
      riskClass: "A2",
      action: "apply-containment-profile",
      assetId: "host-erp-01"
    }
  });
  const result = await h.orchestrator.executeIncident({});

  assert.equal(result.state, "HELD");
  assert.equal(result.reason, "POLICY_RISK_CLASS_NOT_A1");
  assert.equal(h.calls.authorized, 0);
  assert.equal(h.calls.restart, 0);
});

test("rejects authorization not bound to the exact incident, asset and policy revision", async () => {
  const h = harness({
    authorizationResult: {
      authorized: true,
      authorization: Object.freeze({
        authorizationId: "authorization-0002",
        policyId: "jb-prod",
        revision: 4,
        policyHash: "a".repeat(64),
        assetId: "different-host",
        environment: "production",
        incidentId: "incident-0001",
        action: "restart-service",
        riskClass: "A1",
        reservationId: "reservation-0002",
        expiresAt: NOW + 30_000
      })
    }
  });
  const result = await h.orchestrator.executeIncident({});

  assert.equal(result.state, "HELD");
  assert.equal(result.reason, "policy-authorization-context-mismatch");
  assert.deepEqual(h.calls.completed, ["cancelled-before-execution"]);
  assert.equal(h.calls.restart, 0);
});

test("fails closed when the durable service-state response omits lastActionAt", async () => {
  const h = harness({ serviceState: {} });
  const result = await h.orchestrator.executeIncident({});

  assert.equal(result.state, "FAILED_CLOSED");
  assert.equal(result.reason, "orchestration-state-invalid");
  assert.equal(h.calls.authorized, 0);
  assert.equal(h.calls.restart, 0);
});

test("a contradictory v0.5 recovery recommendation is persisted as held, not executed", async () => {
  const h = harness({
    decision: incidentDecision({
      health: { state: "healthy", consecutiveFailures: 0 }
    })
  });
  const result = await h.orchestrator.executeIncident({});

  assert.equal(result.state, "HELD");
  assert.equal(result.reason, "A1_REQUIRES_CLEAR_SECURITY_AND_UNHEALTHY_SERVICE");
  assert.equal(h.calls.states.some((entry) => entry.state === "HELD"), true);
  assert.equal(h.calls.audit.some((entry) => entry.event === "a1-precondition-rejected"), true);
  assert.equal(h.calls.evaluated, 0);
  assert.equal(h.calls.restart, 0);
});


test("rejects event input containing accessors before invoking trusted callbacks", async () => {
  const h = harness();
  const input = trustedIncidentInput();
  Object.defineProperty(input, "source", {
    enumerable: true,
    get() { throw new Error("untrusted getter executed"); }
  });

  const result = await h.orchestrator.executeIncident(input);
  assert.equal(result.state, "FAILED_CLOSED");
  assert.equal(result.reason, "incident-input-invalid");
  assert.equal(h.calls.trustedInput, 0);
  assert.equal(h.calls.restart, 0);
});

test("rejects v0.5 decisions that change the asset, environment or service scope", async () => {
  const h = harness();
  const result = await h.orchestrator.executeIncident(
    trustedIncidentInput({ assetId: "host-another-tenant" })
  );

  assert.equal(result.state, "FAILED_CLOSED");
  assert.equal(result.reason, "incident-decision-scope-mismatch");
  assert.equal(h.calls.evaluated, 0);
  assert.equal(h.calls.authorized, 0);
  assert.equal(h.calls.restart, 0);
});


test("integrates the real v0.5 read-only correlation engine with the v0.6 response boundary", async () => {
  const incidentEngine = createIncidentCorrelationEngine({ clock: () => NOW });
  const h = harness({ incidentEngine });
  const result = await h.orchestrator.executeIncident(realV05IncidentInput());

  assert.equal(result.state, "RECOVERED");
  assert.equal(result.decision, "review-recovery-policy");
  assert.equal(result.decisionRule, "HEALTH_FAILURE_THRESHOLD");
  assert.equal(result.action, "restart-service");
  assert.equal(result.verified, true);
  assert.equal(h.calls.restart, 1);
  assert.equal(h.calls.request.assetId, "host-erp-01");
  assert.equal(h.calls.request.environment, "production");
  assert.equal(h.calls.request.incidentId, result.incidentId);
});


test("rechecks the mutation stop switch after authorization and audit, immediately before restart", async () => {
  const h = harness({
    mutationAllowed: (_context, count) => count < 3
  });
  const result = await h.orchestrator.executeIncident(trustedIncidentInput());

  assert.equal(result.state, "HELD");
  assert.equal(result.reason, "mutation-stopped-at-final-preflight");
  assert.deepEqual(h.calls.mutationPhases, [
    "pre-authorization",
    "immediately-before-execution",
    "final-preflight"
  ]);
  assert.equal(h.calls.restart, 0);
  assert.deepEqual(h.calls.completed, ["cancelled-before-execution"]);
  assert.equal(h.calls.states.some((entry) => entry.state === "HELD"), true);
});

test("consumes the single-use authorization once at the final pre-adapter preflight", async () => {
  const h = harness();
  const result = await h.orchestrator.executeIncident(trustedIncidentInput());

  assert.equal(result.state, "RECOVERED");
  assert.equal(h.calls.asserted, 1);
  assert.equal(h.calls.restart, 1);
});

test("fails closed when the one-time final authorization assertion fails", async () => {
  const h = harness({
    assertResult: () => ({ valid: false })
  });
  const result = await h.orchestrator.executeIncident(trustedIncidentInput());

  assert.equal(result.state, "HELD");
  assert.equal(result.reason, "policy-authorization-expired-before-adapter");
  assert.equal(h.calls.asserted, 1);
  assert.equal(h.calls.restart, 0);
  assert.deepEqual(h.calls.completed, ["cancelled-before-execution"]);
});


function realPolicyFixture() {
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
    services: [{
      id: "host-erp-01",
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
    }]
  };
  policy.policyHash = computeAdvancedPolicyHash(policy);
  return policy;
}

test("executes A1 through the real signed Policy Engine v2 and completes its one-time reservation", async () => {
  const policy = realPolicyFixture();
  const revisionStore = createMemoryPolicyRevisionStore();
  assert.equal(revisionStore.setCurrentPolicy({
    policyId: policy.policyId,
    revision: policy.revision,
    policyHash: policy.policyHash
  }), true);
  const capabilityLedger = createMemoryCapabilityLedger();
  const policyEngine = createResiliencePolicyEngine({
    policy,
    verifyPolicySignature: ({ signature }) =>
      signature.value === "signed-policy-fixture-value",
    policyRevisionStore: revisionStore,
    capabilityLedger,
    allowInMemoryStores: true,
    clock: () => NOW,
    authorizationTtlMs: 30_000
  });

  const calls = { restarts: 0, serviceChecks: 0, appChecks: 0, mutations: [] };
  const orchestrationStore = {
    durable: false,
    async recordIncidentState() { return true; },
    async getServiceState() { return { lastActionAt: null }; },
    async getCircuitState() { return { open: false, retryAtMs: null }; },
    async claimAction() { return { claimed: true, actionId: "action-real-policy-01" }; },
    async completeAction() { return true; },
    async recordActionOutcome() { return true; }
  };
  const auditStore = {
    durable: false,
    async append() { return true; }
  };
  const orchestrator = createResponseOrchestrator({
    incidentEngine: createIncidentCorrelationEngine({ clock: () => NOW }),
    policyEngine,
    adapter: {
      platform: "linux-systemd",
      async restartService(serviceId) {
        assert.equal(serviceId, "catalog-api");
        calls.restarts += 1;
        return { exitCode: 0 };
      },
      async verifyService(serviceId) {
        assert.equal(serviceId, "catalog-api");
        calls.serviceChecks += 1;
        return { healthy: true, state: "active" };
      }
    },
    async applicationHealthCheck() {
      calls.appChecks += 1;
      return { healthy: true };
    },
    async trustedInputVerifier(input) {
      return input.schema === "jb.resilience.incident-input/v1";
    },
    async targetBindingVerifier(binding) {
      return binding.assetId === "host-erp-01" &&
        binding.environment === "production" &&
        binding.serviceId === "catalog-api" &&
        binding.platform === "linux-systemd";
    },
    mutationControl: {
      async assertAllowed(context) {
        calls.mutations.push(context.phase);
        return true;
      }
    },
    orchestrationStore,
    auditStore,
    allowInMemoryStores: true,
    clock: () => NOW
  });

  const result = await orchestrator.executeIncident(realV05IncidentInput());

  assert.equal(result.state, "RECOVERED");
  assert.equal(result.decision, "review-recovery-policy");
  assert.equal(result.decisionRule, "HEALTH_FAILURE_THRESHOLD");
  assert.equal(result.action, "restart-service");
  assert.equal(result.executed, true);
  assert.equal(result.verified, true);
  assert.equal(calls.restarts, 1);
  assert.equal(calls.serviceChecks, 1);
  assert.equal(calls.appChecks, 1);
  assert.deepEqual(calls.mutations, [
    "pre-authorization",
    "immediately-before-execution",
    "final-preflight"
  ]);
});


test("rejects incident input exceeding the pre-normalization byte budget", async () => {
  const h = harness();
  const result = await h.orchestrator.executeIncident(
    trustedIncidentInput({ oversized: "x".repeat(1_048_577) })
  );
  assert.equal(result.state, "FAILED_CLOSED");
  assert.equal(result.reason, "incident-input-invalid");
  assert.equal(h.calls.trustedInput, 0);
  assert.equal(h.calls.restart, 0);
});
