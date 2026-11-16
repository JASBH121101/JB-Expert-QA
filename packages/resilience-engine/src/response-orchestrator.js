import { createHash } from "node:crypto";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const SECURITY_STATES = new Set([
  "clear", "suspected", "confirmed", "conflicting", "stale", "unknown", "tampered"
]);
const INCIDENT_DECISIONS = new Set([
  "observe", "hold", "escalate", "human-review", "review-recovery-policy"
]);
const ACTION = "restart-service";
const ACTION_CLAIM_TTL_MS = 30_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeNow(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("orchestrator clock must return a non-negative safe integer");
  }
  return now;
}

function validateDecision(value) {
  if (!isRecord(value) ||
      value.schema !== "jb.resilience.incident-decision/v1" ||
      typeof value.incidentId !== "string" || !IDENTIFIER.test(value.incidentId) ||
      typeof value.assetId !== "string" || !IDENTIFIER.test(value.assetId) ||
      typeof value.environment !== "string" || !IDENTIFIER.test(value.environment) ||
      typeof value.serviceId !== "string" || !IDENTIFIER.test(value.serviceId) ||
      !isRecord(value.security) || !SECURITY_STATES.has(value.security.state) ||
      !isRecord(value.health) ||
      !["healthy", "unhealthy", "unknown", "conflicting"].includes(value.health.state) ||
      !Number.isSafeInteger(value.health.consecutiveFailures) ||
      value.health.consecutiveFailures < 0 ||
      !INCIDENT_DECISIONS.has(value.decision) ||
      typeof value.decisionRule !== "string" ||
      !Array.isArray(value.trace) ||
      value.preserveEvidence !== true ||
      value.authorizationGranted !== false ||
      value.mayAuthorizeRecovery !== false) {
    throw new TypeError("incident decision is invalid or violates the v0.5 read-only contract");
  }
  return value;
}

function makeIdempotencyKey({ incidentId, assetId, environment, action }) {
  return createHash("sha256")
    .update([incidentId, assetId, environment, action].join("\u0000"), "utf8")
    .digest("hex");
}

function isHealthy(value) {
  return value === true || (isRecord(value) && value.healthy === true);
}

async function invokeHealthCheck(callback, context, timeoutMs) {
  const controller = new AbortController();
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(() => {
      controller.abort();
      reject(new Error("application health check timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => callback({
        ...context,
        signal: controller.signal
      })),
      timeout
    ]);
  } finally {
    clearTimeout(handle);
  }
}

function result({
  incidentId = null,
  state = "FAILED_CLOSED",
  decision = "hold",
  decisionRule = null,
  action = null,
  executed = false,
  verified = false,
  reason
}) {
  return Object.freeze({
    schema: "jb.resilience.orchestration-result/v1",
    incidentId,
    state,
    decision,
    decisionRule,
    action,
    executed,
    verified,
    authorizationGranted: false,
    reason
  });
}

function hasStoreContract(store) {
  return isRecord(store) &&
    typeof store.recordIncidentState === "function" &&
    typeof store.getServiceState === "function" &&
    typeof store.getCircuitState === "function" &&
    typeof store.claimAction === "function" &&
    typeof store.completeAction === "function" &&
    typeof store.recordActionOutcome === "function";
}

/**
 * Creates the v0.6 Response Orchestrator.
 *
 * The orchestrator accepts trusted host-built v0.5 input, never client-created
 * security verdicts. Production requires durable orchestration and audit stores.
 * The only executable v0.6 capability is policy-authorized A1 restart-service.
 */
export function createResponseOrchestrator({
  incidentEngine,
  policyEngine,
  adapter,
  applicationHealthCheck,
  trustedInputVerifier,
  targetBindingVerifier,
  mutationControl,
  orchestrationStore,
  auditStore,
  allowInMemoryStores = false,
  clock = Date.now,
  applicationHealthTimeoutMs = 5_000,
  circuitFailureThreshold = 2,
  circuitCooldownMs = 5 * 60_000
} = {}) {
  if (!isRecord(incidentEngine) || typeof incidentEngine.evaluateIncident !== "function") {
    throw new TypeError("incidentEngine must implement evaluateIncident");
  }
  if (!isRecord(policyEngine) ||
      typeof policyEngine.evaluate !== "function" ||
      typeof policyEngine.authorize !== "function" ||
      typeof policyEngine.assertAuthorization !== "function" ||
      typeof policyEngine.completeAuthorization !== "function") {
    throw new TypeError("policyEngine must implement the v2 authorization contract");
  }
  if (!isRecord(adapter) ||
      !["linux-systemd", "windows-scm"].includes(adapter.platform) ||
      typeof adapter.restartService !== "function" ||
      typeof adapter.verifyService !== "function") {
    throw new TypeError("adapter must be a supported typed service adapter");
  }
  if (typeof applicationHealthCheck !== "function") {
    throw new TypeError("applicationHealthCheck is required for A1 recovery");
  }
  if (typeof trustedInputVerifier !== "function") {
    throw new TypeError("trustedInputVerifier is required to verify host-owned input provenance");
  }
  if (typeof targetBindingVerifier !== "function") {
    throw new TypeError("targetBindingVerifier is required to validate the exact asset/environment/service binding");
  }
  if (!isRecord(mutationControl) || typeof mutationControl.assertAllowed !== "function") {
    throw new TypeError("mutationControl.assertAllowed is required");
  }
  if (!hasStoreContract(orchestrationStore)) {
    throw new TypeError("orchestrationStore does not implement the durable orchestration contract");
  }
  if (!isRecord(auditStore) || typeof auditStore.append !== "function") {
    throw new TypeError("auditStore.append is required");
  }
  if (typeof allowInMemoryStores !== "boolean") {
    throw new TypeError("allowInMemoryStores must be boolean");
  }
  if (allowInMemoryStores !== true &&
      (orchestrationStore.durable !== true || auditStore.durable !== true)) {
    throw new TypeError("durable orchestration and audit stores are required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!Number.isSafeInteger(applicationHealthTimeoutMs) ||
      applicationHealthTimeoutMs < 100 || applicationHealthTimeoutMs > 60_000 ||
      !Number.isSafeInteger(circuitFailureThreshold) ||
      circuitFailureThreshold < 1 || circuitFailureThreshold > 10 ||
      !Number.isSafeInteger(circuitCooldownMs) ||
      circuitCooldownMs < 1_000 || circuitCooldownMs > 86_400_000) {
    throw new TypeError("orchestrator timeouts or circuit-breaker limits are invalid");
  }

  async function appendAudit(entry) {
    try {
      return await auditStore.append(Object.freeze(entry)) === true;
    } catch {
      return false;
    }
  }

  async function persistState(decision, state, reasonCode, at) {
    try {
      return await orchestrationStore.recordIncidentState(Object.freeze({
        incidentId: decision.incidentId,
        assetId: decision.assetId,
        environment: decision.environment,
        serviceId: decision.serviceId,
        state,
        decision: decision.decision,
        decisionRule: decision.decisionRule,
        reasonCode,
        at
      })) === true;
    } catch {
      return false;
    }
  }

  async function finishBeforeExecution({
    decision,
    actionId,
    authorization,
    request,
    reason,
    reasonCode,
    now
  }) {
    let cleanupOkay = true;
    if (authorization) {
      try {
        cleanupOkay = (await policyEngine.completeAuthorization({
          authorization,
          outcome: "cancelled-before-execution"
        }))?.recorded === true;
      } catch {
        cleanupOkay = false;
      }
    }
    if (actionId) {
      try {
        const actionClosed = await orchestrationStore.completeAction({
          actionId,
          outcome: "cancelled-before-execution",
          completedAt: now,
          reasonCode
        }) === true;
        const circuitUpdated = await orchestrationStore.recordActionOutcome({
          assetId: decision.assetId,
          action: ACTION,
          outcome: "cancelled-before-execution",
          at: now,
          failureThreshold: circuitFailureThreshold,
          cooldownMs: circuitCooldownMs
        }) === true;
        cleanupOkay = cleanupOkay && actionClosed && circuitUpdated;
      } catch {
        cleanupOkay = false;
      }
    }
    const state = cleanupOkay ? "HELD" : "RECONCILIATION_REQUIRED";
    const stateWritten = await persistState(decision, state, reasonCode, now);
    const auditWritten = await appendAudit({
      schema: "jb.resilience.audit-entry/v1",
      event: cleanupOkay ? "action-blocked" : "action-cleanup-reconciliation-required",
      incidentId: decision.incidentId,
      assetId: decision.assetId,
      environment: decision.environment,
      policyId: policyEngine.policy?.policyId ?? null,
      policyRevision: policyEngine.policy?.revision ?? null,
      action: ACTION,
      reasonCode,
      cleanupOkay,
      at: now
    });
    return result({
      incidentId: decision.incidentId,
      state: cleanupOkay && stateWritten && auditWritten ? state : "RECONCILIATION_REQUIRED",
      decision: decision.decision,
      decisionRule: decision.decisionRule,
      action: ACTION,
      reason: cleanupOkay && stateWritten && auditWritten
        ? reason : "pre-execution-cleanup-or-audit-reconciliation-required"
    });
  }

  async function executeIncident(incidentInput) {
    let now;
    try {
      now = safeNow(clock);
    } catch {
      return result({ reason: "invalid-clock" });
    }

    let trusted = false;
    try {
      trusted = await trustedInputVerifier(incidentInput) === true;
    } catch {
      trusted = false;
    }
    if (!trusted) {
      return result({ state: "FAILED_CLOSED", reason: "trusted-input-rejected" });
    }

    let decision;
    try {
      decision = validateDecision(await incidentEngine.evaluateIncident(incidentInput));
    } catch {
      return result({ state: "FAILED_CLOSED", reason: "incident-decision-invalid" });
    }

    const baseAudit = {
      schema: "jb.resilience.audit-entry/v1",
      incidentId: decision.incidentId,
      assetId: decision.assetId,
      environment: decision.environment,
      serviceId: decision.serviceId,
      decision: decision.decision,
      decisionRule: decision.decisionRule,
      policyId: policyEngine.policy?.policyId ?? null,
      policyRevision: policyEngine.policy?.revision ?? null,
      policyHash: policyEngine.policy?.policyHash ?? null,
      at: now
    };

    let targetBindingValid = false;
    try {
      targetBindingValid = await targetBindingVerifier(Object.freeze({
        assetId: decision.assetId,
        environment: decision.environment,
        serviceId: decision.serviceId,
        platform: adapter.platform
      })) === true;
    } catch {
      targetBindingValid = false;
    }
    if (!targetBindingValid) {
      const at = safeNow(clock);
      await persistState(decision, "FAILED_CLOSED", "ASSET_SERVICE_BINDING_REJECTED", at);
      await appendAudit({
        ...baseAudit,
        event: "asset-service-binding-rejected",
        reasonCode: "ASSET_SERVICE_BINDING_REJECTED",
        at
      });
      return result({
        incidentId: decision.incidentId,
        state: "FAILED_CLOSED",
        decision: decision.decision,
        decisionRule: decision.decisionRule,
        reason: "asset-service-binding-rejected"
      });
    }

    if (!await persistState(decision, "OBSERVING", "INCIDENT_EVALUATED", now) ||
        !await appendAudit({ ...baseAudit, event: "incident-evaluated" })) {
      return result({
        incidentId: decision.incidentId,
        state: "FAILED_CLOSED",
        decision: decision.decision,
        decisionRule: decision.decisionRule,
        reason: "incident-state-or-audit-store-unavailable"
      });
    }

    if (decision.decision !== "review-recovery-policy" ||
        decision.recommendedNextStep !== "evaluate-a1-policy-separately") {
      const state = decision.decision === "escalate" || decision.decision === "human-review"
        ? "ESCALATED"
        : decision.decision === "hold" ? "HELD" : "OBSERVING";
      const reasonCode = decision.security.state !== "clear"
        ? "SECURITY_STATE_NOT_CLEAR"
        : "NO_A1_RECOVERY_RECOMMENDATION";
      if (!await persistState(decision, state, reasonCode, safeNow(clock)) ||
          !await appendAudit({ ...baseAudit, event: "response-not-actionable", reasonCode, state })) {
        return result({
          incidentId: decision.incidentId,
          state: "FAILED_CLOSED",
          decision: decision.decision,
          decisionRule: decision.decisionRule,
          reason: "incident-finalization-failed"
        });
      }
      return result({
        incidentId: decision.incidentId,
        state,
        decision: decision.decision,
        decisionRule: decision.decisionRule,
        reason: reasonCode
      });
    }

    if (decision.security.state !== "clear" || decision.health.state !== "unhealthy") {
      const reasonCode = "A1_REQUIRES_CLEAR_SECURITY_AND_UNHEALTHY_SERVICE";
      const at = safeNow(clock);
      if (!await persistState(decision, "HELD", reasonCode, at) ||
          !await appendAudit({ ...baseAudit, event: "a1-precondition-rejected", reasonCode, at })) {
        return result({
          incidentId: decision.incidentId,
          state: "FAILED_CLOSED",
          decision: decision.decision,
          decisionRule: decision.decisionRule,
          reason: "a1-precondition-audit-failed"
        });
      }
      return result({
        incidentId: decision.incidentId,
        state: "HELD",
        decision: decision.decision,
        decisionRule: decision.decisionRule,
        reason: reasonCode
      });
    }

    const action = ACTION;
    const requestContext = {
      assetId: decision.assetId,
      environment: decision.environment,
      incidentId: decision.incidentId,
      action,
      securityState: decision.security.state
    };

    let serviceState;
    let circuitState;
    try {
      serviceState = await orchestrationStore.getServiceState({
        assetId: decision.assetId,
        environment: decision.environment
      });
      circuitState = await orchestrationStore.getCircuitState({
        assetId: decision.assetId,
        action,
        now: safeNow(clock)
      });
    } catch {
      await persistState(decision, "FAILED_CLOSED", "ORCHESTRATION_STORE_UNAVAILABLE", safeNow(clock));
      return result({
        incidentId: decision.incidentId,
        state: "FAILED_CLOSED",
        decision: decision.decision,
        decisionRule: decision.decisionRule,
        action,
        reason: "orchestration-store-unavailable"
      });
    }

    if (!isRecord(serviceState) ||
        !Object.hasOwn(serviceState, "lastActionAt") ||
        (serviceState.lastActionAt !== null &&
          (!Number.isSafeInteger(serviceState.lastActionAt) || serviceState.lastActionAt < 0)) ||
        !isRecord(circuitState) || typeof circuitState.open !== "boolean") {
      await persistState(decision, "FAILED_CLOSED", "ORCHESTRATION_STATE_INVALID", safeNow(clock));
      return result({
        incidentId: decision.incidentId,
        state: "FAILED_CLOSED",
        decision: decision.decision,
        decisionRule: decision.decisionRule,
        action,
        reason: "orchestration-state-invalid"
      });
    }

    if (circuitState.open) {
      await persistState(decision, "HELD", "CIRCUIT_BREAKER_OPEN", safeNow(clock));
      await appendAudit({ ...baseAudit, event: "circuit-open", action, retryAtMs: circuitState.retryAtMs ?? null });
      return result({
        incidentId: decision.incidentId,
        state: "HELD",
        decision: decision.decision,
        decisionRule: decision.decisionRule,
        action,
        reason: "circuit-breaker-open"
      });
    }

    const request = Object.freeze({
      ...requestContext,
      health: Object.freeze({
        consecutiveFailures: decision.health.consecutiveFailures,
        lastRestartAt: serviceState.lastActionAt ?? null
      })
    });

    let policyDecision;
    try {
      policyDecision = policyEngine.evaluate(request);
    } catch {
      policyDecision = null;
    }
    if (!policyDecision || policyDecision.permitted !== true ||
        policyDecision.riskClass !== "A1" ||
        policyDecision.action !== ACTION ||
        policyDecision.assetId !== decision.assetId) {
      const reasonCode = policyDecision?.reason ??
        (policyDecision?.riskClass !== "A1" ? "POLICY_RISK_CLASS_NOT_A1" :
          policyDecision?.action !== ACTION ? "POLICY_ACTION_MISMATCH" :
            policyDecision?.assetId !== decision.assetId ? "POLICY_ASSET_MISMATCH" :
              "POLICY_EVALUATION_FAILED");
      await persistState(decision, "HELD", reasonCode, safeNow(clock));
      await appendAudit({ ...baseAudit, event: "policy-denied", action, reasonCode });
      return result({
        incidentId: decision.incidentId,
        state: "HELD",
        decision: decision.decision,
        decisionRule: decision.decisionRule,
        action,
        reason: reasonCode
      });
    }

    let mutationAllowed = false;
    try {
      mutationAllowed = await mutationControl.assertAllowed({
        ...requestContext,
        phase: "pre-authorization"
      }) === true;
    } catch {
      mutationAllowed = false;
    }
    if (!mutationAllowed) {
      await persistState(decision, "HELD", "MUTATION_STOPPED", safeNow(clock));
      await appendAudit({ ...baseAudit, event: "mutation-stopped", action, phase: "pre-authorization" });
      return result({
        incidentId: decision.incidentId,
        state: "HELD",
        decision: decision.decision,
        decisionRule: decision.decisionRule,
        action,
        reason: "mutation-stopped"
      });
    }

    const claimedAt = safeNow(clock);
    const idempotencyKey = makeIdempotencyKey({
      incidentId: decision.incidentId,
      assetId: decision.assetId,
      environment: decision.environment,
      action
    });
    let claim;
    try {
      claim = await orchestrationStore.claimAction({
        idempotencyKey,
        incidentId: decision.incidentId,
        assetId: decision.assetId,
        environment: decision.environment,
        serviceId: decision.serviceId,
        action,
        claimedAt,
        expiresAt: claimedAt + ACTION_CLAIM_TTL_MS
      });
    } catch {
      claim = null;
    }
    if (!claim || claim.claimed !== true ||
        typeof claim.actionId !== "string" ||
        claim.actionId.length < 8 || claim.actionId.length > 128) {
      const reasonCode = claim?.reason ?? "ACTION_CLAIM_FAILED";
      await persistState(decision, "HELD", reasonCode, safeNow(clock));
      await appendAudit({ ...baseAudit, event: "action-claim-rejected", action, reasonCode });
      return result({
        incidentId: decision.incidentId,
        state: "HELD",
        decision: decision.decision,
        decisionRule: decision.decisionRule,
        action,
        reason: reasonCode
      });
    }

    let authorization;
    try {
      const issued = await policyEngine.authorize(request);
      if (issued?.authorized === true && isRecord(issued.authorization)) {
        const candidate = issued.authorization;
        authorization = candidate;
        const authorizationMatchesRequest =
          candidate.riskClass === "A1" &&
          candidate.assetId === decision.assetId &&
          candidate.environment === decision.environment &&
          candidate.incidentId === decision.incidentId &&
          candidate.action === ACTION &&
          candidate.policyId === policyEngine.policy?.policyId &&
          candidate.revision === policyEngine.policy?.revision &&
          candidate.policyHash === policyEngine.policy?.policyHash &&
          typeof candidate.authorizationId === "string" &&
          candidate.authorizationId.length >= 8 &&
          typeof candidate.reservationId === "string" &&
          candidate.reservationId.length >= 8 &&
          Number.isSafeInteger(candidate.expiresAt) &&
          candidate.expiresAt > safeNow(clock);
        if (!authorizationMatchesRequest) {
          return await finishBeforeExecution({
            decision,
            actionId: claim.actionId,
            authorization,
            request,
            reason: "policy-authorization-context-mismatch",
            reasonCode: "POLICY_AUTHORIZATION_CONTEXT_MISMATCH",
            now: safeNow(clock)
          });
        }
      } else {
        return await finishBeforeExecution({
          decision,
          actionId: claim.actionId,
          request,
          reason: issued?.reason ?? "policy-authorization-denied",
          reasonCode: issued?.reason ?? "POLICY_AUTHORIZATION_DENIED",
          now: safeNow(clock)
        });
      }
    } catch {
      return await finishBeforeExecution({
        decision,
        actionId: claim.actionId,
        request,
        reason: "policy-authorization-failed",
        reasonCode: "POLICY_AUTHORIZATION_FAILED",
        now: safeNow(clock)
      });
    }

    if (!authorization) {
      return await finishBeforeExecution({
        decision,
        actionId: claim.actionId,
        request,
        reason: "policy-authorization-context-mismatch",
        reasonCode: "POLICY_AUTHORIZATION_CONTEXT_MISMATCH",
        now: safeNow(clock)
      });
    }

    let asserted = false;
    try {
      asserted = (await policyEngine.assertAuthorization({ authorization, request }))?.valid === true;
    } catch {
      asserted = false;
    }
    if (!asserted) {
      return await finishBeforeExecution({
        decision,
        actionId: claim.actionId,
        authorization,
        request,
        reason: "policy-authorization-no-longer-valid",
        reasonCode: "AUTHORIZATION_ASSERTION_FAILED",
        now: safeNow(clock)
      });
    }

    mutationAllowed = false;
    try {
      mutationAllowed = await mutationControl.assertAllowed({
        ...requestContext,
        phase: "immediately-before-execution"
      }) === true;
    } catch {
      mutationAllowed = false;
    }
    if (!mutationAllowed) {
      return await finishBeforeExecution({
        decision,
        actionId: claim.actionId,
        authorization,
        request,
        reason: "mutation-stopped",
        reasonCode: "MUTATION_STOPPED_BEFORE_EXECUTION",
        now: safeNow(clock)
      });
    }

    const beforeExecutionAt = safeNow(clock);
    if (!await appendAudit({
      ...baseAudit,
      event: "action-authorized",
      action,
      authorizationId: authorization.authorizationId ?? null,
      riskClass: authorization.riskClass ?? "A1",
      at: beforeExecutionAt
    }) || !await persistState(decision, "EXECUTING", "AUTHORIZED_A1_RESTART", beforeExecutionAt)) {
      return await finishBeforeExecution({
        decision,
        actionId: claim.actionId,
        authorization,
        request,
        reason: "pre-execution-audit-or-state-write-failed",
        reasonCode: "PRE_EXECUTION_AUDIT_FAILED",
        now: safeNow(clock)
      });
    }

    let executionError = null;
    let serviceVerification = null;
    let applicationVerification = null;
    try {
      await adapter.restartService(decision.serviceId);
      if (!await persistState(decision, "VERIFYING", "RESTART_COMMAND_RETURNED", safeNow(clock))) {
        throw new Error("incident-state-write-failed");
      }
      serviceVerification = await adapter.verifyService(decision.serviceId);
      if (!isHealthy(serviceVerification)) {
        throw new Error("service-manager-verification-failed");
      }
      applicationVerification = await invokeHealthCheck(applicationHealthCheck, {
        assetId: decision.assetId,
        environment: decision.environment,
        serviceId: decision.serviceId,
        incidentId: decision.incidentId
      }, applicationHealthTimeoutMs);
      if (!isHealthy(applicationVerification)) {
        throw new Error("application-health-verification-failed");
      }
    } catch (error) {
      executionError = error;
    }

    const completedAt = safeNow(clock);
    const outcome = executionError ? "unverified" : "succeeded";
    let authorizationFinalized = false;
    try {
      authorizationFinalized = (await policyEngine.completeAuthorization({
        authorization,
        outcome
      }))?.recorded === true;
    } catch {
      authorizationFinalized = false;
    }

    const finalOutcome = authorizationFinalized ? outcome : "unverified";
    const reasonCode = executionError
      ? (executionError.message === "service-manager-verification-failed"
        ? "SERVICE_VERIFICATION_FAILED"
        : executionError.message === "application-health-verification-failed"
          ? "APPLICATION_VERIFICATION_FAILED"
          : "EXECUTION_RESULT_UNCERTAIN")
      : authorizationFinalized ? "A1_RESTART_VERIFIED" : "AUTHORIZATION_FINALIZATION_FAILED";

    const finalAuditWritten = await appendAudit({
      ...baseAudit,
      event: finalOutcome === "succeeded" ? "action-verified" : "action-unverified",
      action,
      outcome: finalOutcome,
      reasonCode,
      authorizationFinalized,
      serviceVerified: isHealthy(serviceVerification),
      applicationVerified: isHealthy(applicationVerification),
      at: completedAt
    });

    let actionFinalized = false;
    let circuitRecorded = false;
    try {
      actionFinalized = await orchestrationStore.completeAction({
        actionId: claim.actionId,
        outcome: finalAuditWritten ? finalOutcome : "unverified",
        completedAt,
        reasonCode: finalAuditWritten ? reasonCode : "FINAL_AUDIT_WRITE_FAILED"
      }) === true;
      circuitRecorded = await orchestrationStore.recordActionOutcome({
        assetId: decision.assetId,
        action,
        outcome: finalAuditWritten && authorizationFinalized ? outcome : "unverified",
        at: completedAt,
        failureThreshold: circuitFailureThreshold,
        cooldownMs: circuitCooldownMs
      }) === true;
    } catch {
      actionFinalized = false;
      circuitRecorded = false;
    }

    const fullyVerified = outcome === "succeeded" && authorizationFinalized &&
      finalAuditWritten && actionFinalized && circuitRecorded;
    const finalState = fullyVerified ? "RECOVERED" : "RECONCILIATION_REQUIRED";
    const finalReason = fullyVerified ? "A1_RESTART_VERIFIED" :
      !finalAuditWritten ? "FINAL_AUDIT_WRITE_FAILED" :
        !actionFinalized || !circuitRecorded ? "ACTION_LEDGER_FINALIZATION_FAILED" :
          reasonCode;

    const finalStatePersisted = await persistState(
      decision,
      finalState,
      finalReason,
      safeNow(clock)
    });

    if (!fullyVerified || !finalStatePersisted) {
      await appendAudit({
        ...baseAudit,
        event: "action-reconciliation-required",
        action,
        outcome: "unverified",
        reasonCode: finalStatePersisted ? finalReason : "INCIDENT_STATE_FINALIZATION_FAILED",
        at: safeNow(clock)
      });
    }

    return result({
      incidentId: decision.incidentId,
      state: fullyVerified && finalStatePersisted ? "RECOVERED" : "RECONCILIATION_REQUIRED",
      decision: decision.decision,
      decisionRule: decision.decisionRule,
      action,
      executed: true,
      verified: fullyVerified && finalStatePersisted,
      reason: finalStatePersisted ? finalReason : "INCIDENT_STATE_FINALIZATION_FAILED"
    });
  }

  return Object.freeze({
    engine: "JB Resilience Engine",
    module: "Response Orchestrator",
    version: "0.6.0",
    mode: "autonomous-advanced",
    executableActions: Object.freeze([ACTION]),
    executeIncident
  });
}
