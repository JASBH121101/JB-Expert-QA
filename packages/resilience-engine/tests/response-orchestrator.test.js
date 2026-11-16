import test from "node:test";
import assert from "node:assert/strict";
import { createResponseOrchestrator } from "../src/response-orchestrator.js";

const NOW = 1_800_000_000_000;

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
    trace: [],
    evidenceRefs: [],
    preserveEvidence: true,
    authorizationGranted: false,
    mayAuthorizeRecovery: false,
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
    riskClass: "A1"
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
      return overrides.policyDecision ?? { permitted: true, riskClass: "A1", reason: "policy-permits-bounded-action" };
    },
    async authorize(request) {
      calls.authorized += 1;
      calls.authorizeRequest = request;
      return overrides.authorizationResult ?? { authorized: true, authorization };
    },
    async assertAuthorization(input) {
      calls.asserted += 1;
      calls.assertRequest = input.request;
      return overrides.assertResult ?? { valid: true };
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
    incidentEngine: {
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
  const result = await h.orchestrator.executeIncident({ source: "trusted-host-adapter" });

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
  assert.equal(h.calls.audit.some((entry) => entry.event === "action-authorized"), true);
  assert.equal(h.calls.audit.some((entry) => entry.event === "action-verified"), true);
});

test("rejects input whose provenance is not confirmed by the trusted host verifier", async () => {
  const h = harness({ trustedInput: false });
  const result = await h.orchestrator.executeIncident({ source: "untrusted-client" });

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
    const result = await h.orchestrator.executeIncident({});

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
