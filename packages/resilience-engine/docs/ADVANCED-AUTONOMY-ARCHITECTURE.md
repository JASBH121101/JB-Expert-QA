# JB Resilience Engine — Advanced Autonomous Architecture & Policy

**Document type:** target architecture and policy specification  
**Target package:** `packages/resilience-engine` inside `JB-Expert-QA`  
**Target policy schema:** `jb.resilience.policy/v2`  
**Target autonomy mode:** `autonomous-advanced`  
**Status:** design only — not yet implemented or enabled by the current runtime

## 1. Executive decision

JB Resilience Engine will operate as an **advanced autonomous continuity orchestrator**. It may execute pre-authorized, bounded and verifiable recovery or containment actions without waiting for an operator. Human approval is an exception path for actions whose impact exceeds the policy's autonomous envelope.

Advanced autonomy does **not** mean unrestricted root/administrator access, arbitrary command execution, self-modifying policy, or permission to perform irreversible data operations. The engine is autonomous only inside an explicit capability envelope signed by the system owner.

The governing rules are:

1. **Deny by default.** An action must be explicitly allowed for the exact asset, action type, scope and policy revision.
2. **Evidence before action.** Inputs must be authenticated, fresh, replay-protected and attributable to a trusted producer.
3. **Bounded blast radius.** Every action has per-asset, per-incident and cluster-wide budgets.
4. **Verify outcomes.** A successful command is not proof of service recovery or successful containment.
5. **Fail closed on uncertainty.** Invalid signals, policy, clock, ledger, quorum, fencing or health verification block mutation.
6. **Preserve forensic evidence.** Resilience does not clean, overwrite or erase potentially compromised evidence.
7. **Human escalation remains available.** Irreversible, broad-scope or out-of-envelope operations are held for an authorized operator.
8. **No hidden authority transfer.** Security Guard and Malware Engine own their detection verdicts; Resilience owns only continuity decisions within its policy.

## 2. Responsibility boundaries

| Engine / subsystem | Owns | Does not own |
|---|---|---|
| JB Security Guard | Security telemetry, policy evaluation and security verdicts | Service recovery authority |
| JB Malware Engine | Malware/integrity findings and evidence references | Arbitrary service or infrastructure changes |
| JB Resilience Engine | Health correlation, continuity decisions, action budgets, recovery/containment orchestration and verification | Threat scanning, malware removal, policy weakening, evidence deletion |
| JB Expert QA | Source quality, test, contract and release validation | Runtime incident response |

Resilience consumes validated signals; it must never upgrade an untrusted alert into a confirmed attack, downgrade a confirmed verdict, or instruct another engine to disable its controls.

## 3. Target architecture

```text
 Security Guard ─────┐
 Malware Engine ─────┼──> Trusted Signal Gateway
 External Monitor ──┤          |
 OS / App Probes ────┘          v
                         Provenance & Replay Guard
                                  |
                         Event Normalizer / Evidence Index
                                  |
                   ┌──────────────┴──────────────┐
                   v                             v
           Health Intelligence             Threat Correlator
                   └──────────────┬──────────────┘
                                  v
                      Incident State Machine
                                  |
                    Deterministic Decision Engine
                                  |
                      Capability / Risk Policy Gate
                         /          |           \
                      DENY       ESCALATE       AUTHORIZE
                        |           |               |
                     Audit     Approval Broker   Action Planner
                                                     |
                                             Budget / Lease / Lock
                                                     |
                                           Response Orchestrator
                                                     |
                                    Typed, capability-limited adapters
                                    /          |             \
                              Service ops   Traffic ops   Containment
                                    \          |             /
                                             v
                                      Outcome Verifier
                                             |
                                Durable State + Audit Ledger
                                             |
                               Operator / Incident Notifications
```

### Component contracts

1. **Trusted Signal Gateway**
   - Accept only registered engine/monitor identities over authenticated channels.
   - Validate schema, producer identity, signature or authenticated message integrity, event ID, nonce/sequence, event time, expiry and asset binding.
   - Reject or quarantine invalid, stale, duplicated, unknown-version or replayed events.
   - Keep the original evidence reference and a normalized representation; do not silently rewrite source verdicts.

2. **Health Intelligence**
   - Track liveness, readiness, dependency state, error rate, latency, resource saturation and consecutive failures.
   - Distinguish host unreachable, process stopped, service-manager failure, application not-ready and dependency failure.
   - Use independent probes for critical decisions; do not treat a process being RUNNING as proof of application health.

3. **Threat Correlator**
   - Correlate Security Guard and Malware Engine events with asset identity, integrity findings, timestamps and health changes.
   - Preserve source verdicts and uncertainty. A numeric score is not a calibrated probability unless separately validated.
   - Treat unknown, conflicting or expired security state as unsafe for automatic recovery.

4. **Incident State Machine**
   - Own incident lifecycle and prevent competing recovery plans.
   - Deduplicate repeated events and associate related events with one incident.
   - Enforce transitions and prevent loops such as repeated restart → crash → restart.

5. **Deterministic Decision Engine**
   - Evaluate versioned, testable rules. It must not depend on a language model to authorize or construct an action.
   - Return a structured decision: evidence, rule IDs, policy revision, risk class, scope, action, limits, expiry and verification plan.
   - AI or heuristic analysis may suggest an investigation, but it cannot grant capabilities or bypass the Policy Gate.

6. **Capability / Risk Policy Gate**
   - Enforce exact asset/action allowlists, criticality, security state, maintenance window, freshness, budgets, concurrency, dependency and data-safety constraints.
   - Authorize only the minimum action required. A denied action cannot be retried through a different adapter.
   - Validate policy authenticity and validity before each mutation; an expired or invalid policy disables mutations.

7. **Action Planner and Response Orchestrator**
   - Convert an authorized decision into a typed action plan; no shell text, script strings or arbitrary executable path is accepted.
   - Use idempotency keys, bounded deadlines, cancellation, leases and per-action concurrency limits.
   - Before retrying an action with an unknown result, reconcile real system state. Never blindly retry a timed-out mutation.

8. **Typed adapter layer**
   - Expose narrow functions such as restart allowlisted service, drain registered instance, switch a preconfigured route, enter configured degraded mode, or apply an approved containment profile.
   - Each adapter declares capabilities, supported platform, required permissions, preconditions, timeout, expected postcondition and compensating action.
   - Adapter permissions must be narrower than host administrator privileges wherever the platform permits.

9. **Outcome Verifier**
   - Verify both control-plane state and application-level readiness.
   - For containment, verify that the affected asset is isolated while preserving approved management, logging and forensic collection paths.
   - For failover, verify the new leader/target, fencing epoch, traffic path and data consistency before reporting success.

10. **Durable State and Audit Ledger**
    - Store incident transitions, signal digests, decisions, policy revisions, action claims, budgets, approval references, verification and operator overrides.
    - Use transactional uniqueness/idempotency and concurrency control. Cluster-wide actions require a shared transactional or consensus-backed store, not the current local JSON ledger.
    - Store evidence references and hashes rather than secrets or unrestricted command output.
    - If the ledger is unavailable or corrupt, block new mutations.

11. **Approval Broker and Operator Interface**
    - Request human approval only for actions outside the autonomous envelope.
    - Bind approvals to the exact incident, asset, action, parameters, policy revision, approver identity, issue time and expiry.
    - Require durable one-time replay protection; high-impact overrides require two distinct authorized approvers.
    - A generic boolean or client-side confirmation is never sufficient.

## 4. Autonomy classes and action policy

Autonomy is assigned to an **action on an asset**, not just to a service's critical/non-critical label.

| Class | Risk | Default execution |
|---|---|---|
| A0 — Observe | Read-only probes, correlation, reporting | Automatic |
| A1 — Routine recovery | Reversible single-service action on allowlisted stateless/non-critical workload | Automatic within budgets and health gates |
| A2 — Bounded containment | Reversible isolation or traffic removal for a specifically identified asset | Automatic only for trusted confirmed security verdicts and a pre-authorized containment profile |
| A3 — Controlled continuity | Switch traffic or fail over to a pre-provisioned target | Automatic only when every external monitor, fencing, quorum, replication and consistency gate passes |
| A4 — High-impact operations | Data restore, destructive cleanup, host rebuild, global credential rotation, broad network or identity changes | Human approval required; some actions remain prohibited to Resilience |

A4 approval does not grant permission to perform actions outside the adapter catalogue or violate hard prohibitions.

### 4.1 A1 — Routine recovery

Automatic restart/recovery is permitted only when all conditions hold:

- Service ID and exact action are in the signed allowlist.
- Asset is marked eligible for A1 and is not a security control-plane or protected data service.
- Health observations meet the configured failure threshold from independent or sufficiently diverse probes.
- No active, suspected, conflicting, stale or unknown security/tamper state affects the asset or its dependencies.
- Dependencies are healthy; otherwise recover the dependency or degrade safely rather than restart a dependent chain.
- Per-service, per-incident and cluster budgets have remaining capacity.
- Cooldown, maintenance and concurrency rules pass.
- Durable action claim succeeds before adapter invocation.
- Post-action service and application health can be verified.

An automatic action that exhausts its budget opens a circuit breaker and escalates. No infinite retry loop is permitted.

### 4.2 A2 — Bounded security containment

Autonomous containment is allowed only when:

- A trusted Security Guard or Malware Engine producer emits a valid, fresh, confirmed verdict for the exact asset, with an evidence reference and provenance.
- The signed policy explicitly allows the named containment profile for that asset class.
- The action is reversible, narrowly scoped and has a tested release procedure.
- Essential management, logging and forensic collection channels remain available where technically possible.
- The action does not disable endpoint protection, weaken firewall/ACL policy globally, delete files, alter evidence or restore binaries.
- A second independent signal or integrity finding is required when the policy marks the asset as high impact.

For **suspected**, conflicting, stale or unknown security signals: suspend recovery on the affected scope, preserve evidence, alert operators and do not automatically restart or isolate the entire host.

A confirmed tamper/integrity failure blocks restart, self-repair and binary restoration of the affected component. The approved action is containment and escalation, not cleanup.

### 4.3 A3 — Controlled failover

Failover can be autonomously executed only for a pre-provisioned target and only when all of the following are true:

- An independent monitor outside the failed host confirms unavailability.
- The control plane has a durable, transactional coordination store.
- A valid exclusive lease and monotonically increasing fencing epoch prevent the former primary from writing.
- Quorum/authority is unambiguous; split-brain is ruled out.
- Replication is healthy and measured lag is within the service's explicit RPO.
- Target capacity, dependencies, secrets access and health checks are ready.
- The source is fenced before a new writer is promoted.
- Traffic cutover and rollback are preconfigured and bounded.
- Post-failover integrity and application-level checks pass.

If any gate is unknown or cannot be independently verified, do not promote a new writer. Keep the service in safe degraded/read-only mode where configured and escalate. A host cannot recover itself after it is fully unreachable; external orchestration is mandatory.

The existing JSON file recovery ledger is single-host only and is **not sufficient** for A3. A transactional database/coordination backend with uniqueness, lease expiry and fencing semantics is a prerequisite.

## 5. Incident response decision matrix

| Incident / evidence | Automatic response | Prohibited automatic response | Escalation |
|---|---|---|---|
| Transient outage, no security signal, stateless allowlisted service | Bounded restart, verify, then circuit-break on failure | Unbounded retries or restarting dependencies blindly | After budget exhaustion or failed verification |
| Dependency unavailable | Mark dependent service degraded; recover dependency only if separately eligible | Restarting an entire dependency tree | If dependency is stateful/critical |
| Suspected or conflicting attack signal | Suspend recovery, preserve logs/evidence, notify | Restarting affected asset; broad network isolation | Immediate |
| Confirmed malware on allowlisted workload | Apply exact pre-approved containment profile; preserve evidence | Cleaning malware, deleting files, restoring executable, disabling protection | Immediate notification; human investigation |
| Configuration/binary tamper | Freeze recovery and contain if explicitly authorized | Auto-repair, overwrite, rollback binary | Immediate |
| Resource saturation | Apply bounded load shed, drain unhealthy stateless instance, configured degraded mode | Killing databases, dropping persistent queues, changing global quotas | If no safe degradation path |
| Host unreachable | External monitor may propose/execute A3 only when all failover gates pass | Local self-recovery claim; promote without fencing | If any prerequisite is unknown |
| Recovery command timed out / unknown result | Reconcile actual state; hold further mutation until resolved | Blind retry | If state cannot be reconciled |
| Recovery executed but health check fails | Open circuit breaker; stop retrying; preserve diagnostics | Marking incident recovered | Immediate for critical service |
| Ledger, clock, policy signature or adapter integrity failure | Block all mutations; continue read-only monitoring if safe | Fallback to memory ledger or unsigned policy | Immediate |

## 6. Proposed policy schema v2

The current runtime accepts `jb.resilience.policy/v1` with `mode: "semi-autonomous"`. The following is a **target contract**, not a currently accepted configuration.

```json
{
  "schema": "jb.resilience.policy/v2",
  "policyId": "jb-prod-continuity",
  "revision": 1,
  "mode": "autonomous-advanced",
  "validity": {
    "notBefore": "2026-11-16T00:00:00Z",
    "expiresAt": "2026-12-16T00:00:00Z"
  },
  "signature": {
    "keyId": "continuity-policy-owner-01",
    "algorithm": "approved-by-host-key-policy"
  },
  "defaults": {
    "decision": "deny",
    "unknownSignal": "hold-and-escalate",
    "staleSignal": "hold-and-escalate",
    "ledgerUnavailable": "block-mutations",
    "policyInvalid": "block-mutations",
    "preserveEvidence": true,
    "requireDurableAudit": true
  },
  "budgets": {
    "maxConcurrentActionsPerIncident": 1,
    "maxActionsPerIncident": 3,
    "maxActionsPerAssetPerHour": 2,
    "maxAutomaticContainmentsPerIncident": 1
  },
  "services": [
    {
      "id": "web-api-01",
      "tier": "stateless",
      "criticality": "standard",
      "allowedActions": [
        "restart-service",
        "drain-instance",
        "enter-degraded-mode"
      ],
      "recovery": {
        "failureThreshold": 3,
        "maxRestartsPerHour": 2,
        "cooldownMs": 300000,
        "requireApplicationHealth": true
      },
      "containmentProfile": null,
      "failoverProfile": null
    }
  ]
}
```

The host must validate the complete schema, issuer/key identity, signature, validity period, monotonic revision and policy hash. The example signature block is descriptive metadata only; the implementation must use the cryptographic verification mechanism selected by the host key-management design. No unsigned example policy is valid for production.

### Required policy dimensions

- **Asset identity:** immutable service/instance identifier, environment and ownership.
- **Tier and criticality:** stateless, stateful, critical, data-bearing, security-control-plane.
- **Capabilities:** exact actions permitted per asset; no wildcard mutation grant.
- **Preconditions:** evidence sources, freshness, dependency health, maintenance window and confidence/verdict requirements.
- **Budgets:** per action, asset, incident, time window and cluster.
- **Verification:** expected postconditions and independent check sources.
- **Containment:** named profile, exact scope, management/forensic exceptions and release criteria.
- **Failover:** target identity, RPO/RTO, lease/fencing, quorum, replication and cutover constraints.
- **Approval:** authorized roles, dual-control thresholds, expiry and replay protection.
- **Audit:** immutable policy revision/hash and mandatory decision/action records.

## 7. Signal contract between engines

Every inter-engine event must use a versioned envelope such as:

```json
{
  "schema": "jb.security-event/v1",
  "eventId": "unique-event-id",
  "producer": {
    "engine": "JB Malware Engine",
    "version": "x.y.z",
    "identity": "registered-producer-id"
  },
  "asset": {
    "id": "web-api-01",
    "hostId": "host-17"
  },
  "event": {
    "type": "integrity-tamper",
    "verdict": "confirmed",
    "severity": "high",
    "occurredAt": "2026-11-16T19:00:00Z",
    "expiresAt": "2026-11-16T19:05:00Z"
  },
  "evidence": {
    "references": ["evidence://opaque-reference"],
    "digest": "sha256:..."
  },
  "replay": {
    "nonce": "unique-nonce",
    "sequence": 481
  },
  "signature": {
    "keyId": "registered-engine-key",
    "value": "detached-signature"
  }
}
```

This is a contract illustration, not a production credential. Resilience must verify producer authorization, event signature/integrity, asset binding, freshness, replay status and supported schema version before the event can influence a mutation. An event from an unknown or untrusted producer is informational only.

## 8. State machine and action lifecycle

Incident states:

`OBSERVING → DEGRADED → SUSPECTED_SECURITY | CONFIRMED_SECURITY | SERVICE_FAILURE → PLANNED → AUTHORIZED → EXECUTING → VERIFYING → RECOVERED | CONTAINED | DEGRADED_SAFE | ESCALATED | FAILED_CLOSED`

Rules:

- A security/tamper state blocks A1 recovery for the affected asset until an explicit clearance event from the owning security engine is validated.
- A confirmed event can enter A2 only through an approved containment profile.
- A failed or uncertain verification never transitions to `RECOVERED`.
- A crash after an action claim consumes that action budget and requires reconciliation; it does not silently reopen the budget.
- Duplicate event IDs, proposal IDs and action idempotency keys cannot trigger duplicate mutations.
- One incident may have only one active mutating plan per asset unless a policy explicitly permits safe parallelism.

## 9. Hard prohibitions

Resilience must never autonomously:

- Execute arbitrary shell commands, scripts, dynamic code or model-generated commands.
- Disable or weaken Security Guard, Malware Engine, endpoint protection, logging, audit or access controls.
- Delete, overwrite, sanitize or rotate forensic evidence.
- Restore a binary, package, driver or configuration that may be compromised.
- Delete databases, queues, disks, backups or user data.
- Restore database backups or roll data backward.
- Promote a stateful writer without fencing, quorum and consistency verification.
- Rebuild/reimage hosts, provision new infrastructure or change global identity/credential/network policy.
- Change its own policy, trust roots, signing keys, capability allowlists or approval requirements.
- Bypass its own ledger, retry limits, kill switch or verification gates.

Some of these operations may be available through a separately designed operator workflow; approval does not make them permissible through the Resilience autonomous adapter catalogue.

## 10. Emergency controls and human authority

- **Mutation stop switch:** immediately blocks new mutating plans while allowing safe read-only monitoring and audit to continue.
- **Scoped recovery disable:** suspend a named service, asset group or action class without disabling the full engine.
- **Policy rollback:** only to a previously signed, unexpired, monotonic-approved policy version; never to an unsigned or revoked policy.
- **Emergency override:** signed, time-bounded and scoped. For high-impact operations it requires two distinct authorized approvers. It cannot override hard prohibitions.
- **Operator escalation:** include incident ID, evidence references, current state, proposed action, denied gates, remaining budgets and exact reason approval is required.

## 11. Security, reliability and abuse controls

- Separate the read-only monitoring identity from mutation-capable adapter identities.
- Use least-privilege service accounts and OS permissions restricted to configured service units.
- Require signed policy deployment, authenticated producer registration and key rotation with overlap/revocation.
- Protect the ledger with OS permissions, encryption at rest where supported, integrity checks and bounded retention.
- Apply per-incident locks, idempotency, monotonic epochs and cluster-wide action budgets.
- Use jittered backoff and circuit breakers; do not retry an unknown outcome until state reconciliation completes.
- Keep a tamper-evident audit chain or ship signed audit checkpoints to an independent sink.
- Monitor the Resilience process itself from an independent host. A dead Resilience host cannot execute recovery.
- Do not make automatic decisions from uncalibrated risk scores or model-generated explanations.

## 12. Required validation before enabling advanced autonomy

1. **Contract/unit tests:** schema, signatures, freshness, replay, policy expiry, capability allowlists, decision matrix and deterministic output.
2. **Concurrency tests:** duplicate event, duplicate approval, same-asset parallel actions, ledger lock contention, crash after claim and multi-process budget races.
3. **Fault injection:** timeout, partial command result, corrupt ledger, clock skew, missing monitor, stale event, lost management path and failed health probe.
4. **Security simulation:** suspected vs confirmed malware, tamper event, conflicting producer verdicts, invalid signature and replayed event. Verify no restart or evidence destruction.
5. **Continuity lab:** dependency outage, service flapping, degraded mode, drain, preconfigured failover, split-brain attempt, expired lease and replication lag above RPO.
6. **Platform validation:** isolated Windows VM with SCM and Linux VM with systemd. Existing injected command-runner tests are not equivalent to real OS validation.
7. **Shadow mode:** compute and audit decisions without executing mutations; compare decisions with operator judgments.
8. **Canary:** enable only A1 first on one non-critical service; then A2 containment on a deliberately isolated lab asset; A3 only after fencing and multi-host ledger certification.
9. **Release gate:** no production activation while any safety-critical scenario is failing, unverified or skipped.

## 13. Implementation sequence

| Stage | Deliverable | Acceptance gate |
|---|---|---|
| v0.3 | Policy schema v2, policy signature/expiry validation, explicit autonomy mode and capability catalogue | Invalid/unsigned/expired policy blocks mutation; existing v1 tests remain covered during migration |
| v0.4 | Trusted signal gateway and signed event contracts for Security Guard / Malware Engine | Replay, spoofing, stale and malformed events cannot authorize actions |
| v0.5 | Deterministic Decision Engine, incident state machine and audit decision records | Scenario matrix passes with explainable rule IDs and no unauthorized action |
| v0.6 | Typed A1/A2 action adapters, budgets, circuit breakers and mutation stop switch | Lab recovery/containment remains inside exact allowlists and verifies outcomes |
| v0.7 | External monitor contract and A3 failover planner | Fencing, quorum, consistency and independent observer tests pass; no split-brain |
| v0.8 | Durable cluster ledger, operator approval broker and tamper-evident audit | Crash/race/replay/approval tests pass across processes and hosts |
| v1.0 | Integrated autonomous-advanced certification | Full lab, shadow and canary gates pass; production enablement remains an explicit operator decision |

## 14. Current implementation gap

The current package is still the v0.2 recovery foundation:

- Current policy schema is `jb.resilience.policy/v1` and accepts `mode: "semi-autonomous"`.
- Current automatic action is a bounded service restart for an allowlisted non-critical service.
- Critical services still rely on an injected signed, one-time human approval verifier.
- Current adapters cover Linux systemd and Windows SCM restart/verification.
- The built-in JSON recovery ledger is single-host; it is not a cluster coordination store.
- Security/tamper signals are host-provided booleans in the current API, not yet the signed event contract above.
- No A2 containment adapter, A3 external failover controller, policy-signature registry, incident correlator or autonomous decision engine exists yet.

Therefore this document does not authorize activating `autonomous-advanced` in the present runtime. Implementation must follow the stages above, remain in a lab branch, pass tests, then be reviewed and merged through the normal repository process.
