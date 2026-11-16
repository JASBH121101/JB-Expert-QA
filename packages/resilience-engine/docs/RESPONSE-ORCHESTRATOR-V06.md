# JB Resilience Engine v0.6 — Response Orchestrator

**Package:** `@jb/resilience-engine`  
**Target mode:** `autonomous-advanced`  
**Status:** implementation specification for the isolated v0.6 laboratory branch  
**Base:** current `main`, including the deterministic v0.5 Incident Correlation & Decision Engine

## 1. Objective

v0.6 connects the existing read-only v0.5 incident decision to the existing v2 policy authority and a narrowly typed execution path. It owns the response lifecycle: admission, pre-validation, authorization, idempotent action claiming, bounded execution, outcome verification, state transitions and audit.

Autonomy is bounded by the owner-signed policy. The orchestrator is not a policy issuer, does not elevate its privileges and cannot widen the adapter catalogue.

## 2. Reuse existing certified boundaries

v0.6 must reuse, not replace, these existing package components:

- **Trusted Signal Gateway v0.4:** authenticates and de-duplicates source signals. The orchestrator must not accept a browser/client-created security snapshot as trusted evidence.
- **Incident Correlation & Decision Engine v0.5:** supplies the deterministic incident ID, decision rule, trace, security state, health summary and evidence references. Its output remains non-authorizing.
- **Resilience Policy Engine v2 / v0.3:** validates the signed `jb.resilience.policy/v2` policy, checks the owner-activated revision, evaluates capability conditions, reserves budgets and issues short-lived authorization objects.
- **Typed platform adapters:** Linux systemd and Windows SCM expose fixed service operations through injected command runners; no shell text, dynamic command, executable path or script is accepted from an event.
- **Existing v1 recovery API:** remains backward-compatible and is not silently switched to the v2 runtime.

The orchestrator coordinates these boundaries; it must not import or modify Security Guard, Malware Engine or the independent Policy Engine's authority.

## 3. v0.6 autonomous execution envelope

The current v2 Policy Engine explicitly allows only the A1 `restart-service` action to reach an executable runtime. Although the policy schema knows about other capability names, `drain-instance` and `enter-degraded-mode` are not executable in this runtime, A2 `apply-containment-profile` is denied pending its certification gate, and A3 `switch-route` / `failover` are denied pending the external failover control plane.

Therefore v0.6 may autonomously execute only:

- one exact allowlisted service;
- one exact environment;
- action `restart-service`;
- A1 stateless, standard-criticality scope;
- clear, fresh trusted security state;
- a v0.5 decision of `review-recovery-policy` / `evaluate-a1-policy-separately`;
- fresh unhealthy health observations meeting the signed policy threshold;
- active signed policy revision, valid durable capability reservation and available action budgets;
- an enabled global and scoped mutation control;
- durable idempotency/action state and durable audit;
- service-manager and application-level post-action verification.

No other action may be inferred from severity, risk score, AI output, an unknown event, or a caller-supplied string.

## 4. Component model

```text
Trusted Signal Gateway + Host Health Monitor
                  |
                  v
      Incident Correlation Engine v0.5
                  |
          deterministic incident
                  |
                  v
       Response Orchestrator v0.6
         |       |        |
         |       |        +--> Mutation Stop / Scope Control
         |       +-----------> Durable Incident / Action Store
         +-------------------> Durable Audit Store
                  |
          Policy Engine v2
       evaluate -> authorize
                  |
        assertAuthorization
                  |
       typed A1 action planner
                  |
        Linux / Windows adapter
                  |
         service verification
                  |
        application health check
                  |
          outcome finalization
```

### Responsibilities

1. **Event admission:** accept only the exact v0.5 incident input contract built by trusted host integrations.
2. **Decision intake:** validate the v0.5 output shape and preserve its incident ID, selected rule, decision trace and evidence references.
3. **Lifecycle manager:** persist monotonic incident states and reject invalid state transitions.
4. **Policy bridge:** translate the exact v0.5 recovery recommendation into a fixed v2 capability request; never treat the v0.5 result as an authorization.
5. **Action planner:** create only a typed `restart-service` plan for the exact allowlisted asset and environment.
6. **Execution controller:** claim an idempotency key, assert authorization immediately before execution, check the mutation stop switch and call the typed adapter.
7. **Outcome verifier:** require both service-manager verification and host-owned application-level health verification.
8. **Circuit breaker:** prevent repeated automatic attempts after configured failures or uncertain outcomes.
9. **Audit writer:** record admission, decisions, policy revision/hash, denied gates, action claim, execution and verification outcome without secrets or raw command output.

## 5. Integration contracts

All production stores must declare `durable: true`. Memory implementations are test-only and must require an explicit test-mode option.

### 5.1 Required dependencies

- `incidentEngine.evaluateIncident(input)` — existing v0.5 engine.
- `policyEngine.evaluate(request)`, `authorize(request)`, `assertAuthorization({ authorization, request })`, and `completeAuthorization({ authorization, outcome })` — existing v2 policy engine.
- `adapter.platform`, `adapter.restartService(serviceId)`, and `adapter.verifyService(serviceId)` — existing typed platform adapter.
- `applicationHealthCheck(context)` — host-owned application readiness verifier.
- `trustedInputVerifier(input)` — authenticates the host-owned provenance of the raw v0.5 input; it must not trust client-supplied verdicts.
- `targetBindingVerifier({ assetId, environment, serviceId, platform })` — verifies the exact mapping from the v0.5 asset/environment/service tuple to the configured adapter target. Asset and service IDs are separate identifiers and must not be assumed equal.
- `mutationControl.assertAllowed(context)` — host-owned global and scoped mutation stop control; only literal `true` permits progress.
- `orchestrationStore` — durable, atomic incident/action/circuit state. The branch includes `createFileOrchestrationStore(...)`, a single-host file ledger with exclusive process locking, atomic replacement, monotonic lifecycle transitions, permanent idempotency claims and fail-closed capacity limits.
- `auditStore.append(entry)` — durable append-only audit port. The branch includes `createFileAuditStore(...)`, a single-host append-only JSONL log with fsync and a SHA-256 hash chain. A corrupted chain blocks subsequent writes; independent signed checkpoints are still needed for stronger tamper resistance.
- `clock()` — injected clock returning a non-negative safe integer in milliseconds.

### 5.2 Orchestration store operations

The store must atomically implement:

- `recordIncidentState(record)` — append or validate a legal monotonic incident transition; return literal `true` on durable success.
- `getServiceState({ assetId, environment })` — return the last durable action timestamp and state for policy cooldown evaluation.
- `getCircuitState({ assetId, environment, action, now })` — return the current circuit state and retry deadline for the exact asset/environment/action tuple.
- `claimAction({ idempotencyKey, incidentId, assetId, environment, serviceId, action, claimedAt, expiresAt })` — enforce a unique idempotency claim and one active mutation per asset/incident.
- `completeAction({ actionId, outcome, completedAt, reasonCode })` — finalize a claimed action exactly once.
- `recordActionOutcome({ assetId, environment, action, outcome, at, failureThreshold, cooldownMs })` — atomically update the circuit breaker and last-action state for the exact asset/environment pair.

The included file stores are suitable only for a single host with a protected local volume. They are not a cross-host database, consensus service or distributed fencing system. Multi-host deployments require a transactional backend. The hash chain detects local record alteration but does not prevent an attacker with write access from rewriting the complete file; ship independently signed audit checkpoints for stronger tamper resistance.

### 5.3 Audit entry rules

Audit records must be bounded plain data, timestamped, correlated to the incident/action and contain policy ID, revision, hash, selected rule, decision, action, outcome and reason codes. Never persist signing keys, HMAC keys, approval signatures, secrets, environment dumps or unrestricted command output. If the required pre-execution audit append fails, the action must not execute.

## 6. Lifecycle and response algorithm

Allowed high-level states:

`OBSERVING`, `DEGRADED`, `HELD`, `ESCALATED`, `PLANNED`, `AUTHORIZED`, `EXECUTING`, `VERIFYING`, `RECOVERED`, `FAILED`, `FAILED_CLOSED`, `RECONCILIATION_REQUIRED`.

The exact transition graph must be encoded and tested. A failed or uncertain verification must never transition to `RECOVERED`.

For each admitted incident:

1. Copy and freeze the untrusted input as bounded plain JSON data, authenticate its host-owned provenance, evaluate it with v0.5 and verify that the resulting asset/environment/service scope exactly matches the input.
2. If the decision is not `review-recovery-policy`, do not mutate. Persist the appropriate observe, hold or escalation outcome.
3. If security state is not exactly `clear`, or health is not exactly `unhealthy`, hold/ escalate. Unknown, stale, suspected, confirmed, tampered or conflicting evidence can never enter the A1 path.
4. Read the durable service action state and circuit state. If either read fails or the circuit is open, fail closed.
5. Build the fixed A1 request using the v0.5 incident ID and health failure count plus the durable last-action timestamp. Ask the policy engine to evaluate it.
6. Atomically claim the incident/action idempotency key. A duplicate claim is a no-op, not a second execution.
7. Obtain the short-lived capability authorization from the policy engine. A deny, stale policy, unavailable revision store or budget failure ends the response without mutation.
8. Persist the execution intent. Re-assert the short-lived capability and re-check the mutation stop control at the final preflight immediately before invoking the adapter; a failed preflight cancels the claim without dispatching the action.
9. Execute only `adapter.restartService(exactServiceId)`. The adapter must keep fixed executables/arguments, shell disabled and bounded timeouts.
10. Verify the service-manager state and then run the host-owned application health check. Command success alone is not recovery.
11. Finalize the policy reservation, action claim, incident state, circuit outcome and audit record. If the command result is uncertain, record `RECONCILIATION_REQUIRED`, consume the action budget and do not blindly retry.

## 7. Fail-safe rules

- Missing/invalid dependency, unsigned or stale policy, unavailable durable store, audit failure, clock error, failed mutation control, invalid decision, unknown action, expired authorization or failed reservation blocks mutation.
- Conflicting, stale, unknown, suspected, confirmed or tampered security signals block A1 recovery and preserve evidence.
- A timed-out or ambiguous mutation is reconciled against actual service state before any retry.
- The orchestrator cannot modify its policy, trust roots, capability catalogue, approval requirements, audit settings, stop switch or its own privileges.
- No arbitrary command execution, file deletion/cleanup, evidence modification, binary restoration, database restore, firewall/ACL weakening, security-control disablement, global credential/network change, host rebuild or un-fenced failover.
- Human approval is not a way to bypass hard prohibitions. Approval workflows for out-of-envelope but permitted future actions require their own signed, scoped and replay-protected contract.

## 8. Validation and certification gates

The v0.6 laboratory must include:

1. Contract tests for exact input/output shapes, unknown fields, unsafe accessors, unsupported actions and malformed stores.
2. Policy tests for invalid signature, expired policy, stale revision, missing capability, insufficient health threshold, cooldown and exhausted budgets.
3. Signal tests for unknown, stale, suspected, confirmed, tampered, replayed and conflicting events; none may execute A1.
4. Idempotency and concurrency tests for duplicate incident delivery, simultaneous same-asset responses and duplicate action claims.
5. Mutation-stop tests at admission and immediately before adapter invocation.
6. Fault injection for audit-store outage, action-store outage, clock failure, policy-store outage, adapter timeout, partial command result and application-health failure.
7. Circuit-breaker tests for bounded failures, cooldown, successful reset and no infinite retry loop.
8. Linux and Windows adapter contract tests; real OS VM validation remains a separate platform certification gate.
9. Regression tests proving v0.1–v0.5 APIs and tests remain unchanged and passing.

No action is production-certified merely because unit tests pass. Production activation remains a separate operator decision after laboratory, platform and release gates are complete.

## 9. Deferred beyond v0.6

- A2 autonomous containment remains blocked until the trusted-signal, containment-profile adapter and evidence-preservation gates are certified.
- A3 route switching/failover remains blocked until independent monitoring, durable cross-host coordination, quorum, leases, fencing and consistency verification are certified.
- Cluster-wide consensus, multi-region incident coordination and full operator approval broker remain later stages.
- AI may assist investigation or explain a decision, but it cannot select arbitrary actions, grant capabilities or bypass deterministic rules and the signed policy gate.
