# JB Resilience Engine — Advanced Autonomous Architecture

**Status:** design baseline for implementation and review  
**Repository:** `JASBH121101/JB-Expert-QA`  
**Package:** `packages/resilience-engine`  
**Autonomy profile:** `advanced-autonomous`  
**Scope:** bounded host/service continuity and incident response. This design does not authorize production deployment, infrastructure changes, or destructive operations.

## 1. Operating contract

JB Resilience Engine is the deterministic continuity decision and orchestration engine. It is not a threat detector, EDR, malware remover, or unrestricted agent.

Advanced autonomy authorizes automatic execution of explicitly pre-approved, bounded, reversible actions, including selected containment and recovery actions. It does **not** grant unrestricted administrative authority.

The engine must:
- deny by default when identity, evidence, policy, state, or authorization is missing or ambiguous;
- execute only typed actions from a versioned allowlist, never generated shell commands;
- enforce blast-radius, time, retry, concurrency, and resource budgets;
- preserve forensic evidence and immutable audit history;
- verify outcomes independently; command success is not service recovery;
- stop and escalate before irreversible, destructive, data-affecting, or infrastructure-wide actions;
- support an emergency autonomy kill switch that disables automatic execution without disabling monitoring or audit.

## 2. Trust boundaries and logical architecture

```text
Security Guard ──────┐
Malware Engine ──────┤
Host / App Probes ───┼─> Authenticated Signal Gateway
OS Service Manager ──┘              |
                                    v
                         Validation / Replay Defense
                                    |
                                    v
                           Incident Correlator
                                    |
                    +---------------+---------------+
                    |                               |
             Health Intelligence              Asset Registry
                    |                         + Criticality Map
                    +---------------+---------------+
                                    |
                           Deterministic Decision
                                    |
                         Mandatory Policy Gate
                           /        |        \
                        DENY    AUTO PLAN   ESCALATE
                         |         |           |
                       Audit   Response    Approval /
                              Orchestrator  Operator Queue
                                   |
                          Typed Adapter Layer
                         systemd / Windows SCM
                                   |
                          Recovery Verification
                                   |
                       Durable Ledger + Audit Trail
                                   |
                         Incident Report / Learning
```

### Component responsibilities

1. **Authenticated Signal Gateway** — accepts signals only from configured producers; validates producer identity, schema, signature or authenticated transport, timestamp, expiry, sequence/replay marker, asset identity and correlation ID.
2. **Health Intelligence** — evaluates liveness, readiness, dependencies, latency/error thresholds, consecutive failures and recovery history. Distinguishes host failure, process failure and application degradation.
3. **Asset Registry** — authoritative mapping of service IDs, owners, criticality, dependencies, allowed actions, recovery objectives, data sensitivity and approved recovery targets. Unknown assets are never auto-operated.
4. **Incident Correlator** — correlates independent evidence over bounded windows, retains source provenance and contradictions, and classifies uncertainty. Scores are not represented as calibrated probabilities.
5. **Decision Engine** — deterministic, versioned decision rules. It selects a typed plan based on incident class, evidence freshness, asset criticality, dependency graph, current state, action budget and autonomy profile.
6. **Policy Gate** — final mandatory enforcement point. Checks allowlist, blast radius, action parameters, cooldowns, attempt limits, maintenance windows, policy version, kill switch and authorization class.
7. **Response Orchestrator** — executes typed plans with deadlines, cancellation, idempotency keys, concurrency control, bounded retries and per-incident action budgets.
8. **Adapter Layer** — fixed, reviewed OS/service operations only. No arbitrary executable path, shell interpolation, dynamic command strings or AI-authored commands.
9. **Recovery Verification** — verifies OS service state and application readiness using independent probes and stability windows.
10. **Durable State and Audit Ledger** — persists incident transitions, evidence references, decisions, policy versions, action claims, approvals, execution results and verification outcomes.
11. **Operator Escalation** — queues actions requiring approval, exposes rationale and rollback/recovery implications, and supports authenticated cancellation or override.
12. **Incident Intelligence** — generates timelines and recommendations from evidence. It cannot change policy or grant itself permissions.

## 3. Incident classes

- **HEALTH_DEGRADED** — service is available but outside configured health objectives.
- **SERVICE_UNAVAILABLE** — trusted probes confirm service/process unavailable.
- **DEPENDENCY_FAILURE** — required dependency unhealthy; restarting dependents is not the default.
- **SUSPECTED_SECURITY_EVENT** — valid but unconfirmed or conflicting security signal; suspend recovery on affected scope.
- **CONFIRMED_SECURITY_INCIDENT** — authenticated trusted producer provides a confirmed verdict and evidence reference.
- **TAMPER_OR_INTEGRITY_FAILURE** — binary, configuration, boot or policy integrity failure; preserve evidence and block restart/repair of affected component.
- **HOST_UNREACHABLE** — independent external monitor cannot reach host; local self-recovery is impossible.
- **RECOVERY_UNVERIFIED** — action executed but service/application health cannot be proven.
- **RECOVERY_EXHAUSTED** — retry or action budget consumed.
- **SIGNAL_PIPELINE_DEGRADED** — trust, freshness or availability of detection/monitoring inputs is compromised.

Each incident retains severity, assets, source signals, provenance, evidence freshness, timestamps, policy version, uncertainty, decisions and outcome.

## 4. Autonomy classes and policy

### A0 — Observe only
Always available. Collect signals, correlate, classify, preserve evidence and notify. No remediation.

### A1 — Automatic reversible actions
May execute without per-action human approval only when all policy predicates pass:
- target is explicitly registered and allowlisted;
- action is typed, tested, reversible and within approved scope;
- evidence is fresh and sufficiently corroborated for that action;
- no active tamper/integrity block or unresolved security conflict exists;
- action budget, retry cap, cooldown and dependency checks pass;
- durable ledger and audit sink are healthy;
- kill switch is off and the current policy is valid.

Examples: bounded restart of a non-critical allowlisted service after confirmed non-security outage; drain a single unhealthy instance from a preconfigured local pool; pause a non-critical job queue; switch a feature flag to a pre-approved safe mode; apply a pre-approved rate-limiting profile through a typed adapter.

### A2 — Autonomous containment under explicit playbook
Can execute pre-authorized containment when the signal is authenticated and the playbook precisely limits target and impact. Examples: isolate a specific non-critical workload from a local service mesh; disable a compromised service account token through a pre-integrated identity adapter; quarantine a process using a supported endpoint adapter while preserving forensic artifacts.

A2 must never disable the security sensor, logging, audit, backup, identity control plane, or the Resilience kill switch. Containment actions require a tested compensating action and expiry/lease where technically possible. If the adapter cannot prove the target identity or scope, deny.

### A3 — Human approval required
Always escalate:
- actions on critical services or shared control planes;
- changes with broad blast radius or cross-host impact;
- network/firewall/security-group changes outside an exact pre-approved rule;
- failover, traffic/DNS changes or promotion of a secondary host;
- database restore, rollback, schema/data mutation or backup replacement;
- credential rotation/revocation beyond an exact pre-authorized emergency playbook;
- deleting, overwriting, rebuilding or replacing files/binaries;
- actions with uncertain rollback, possible data loss, or legal/compliance implications;
- policy, trust root, allowlist, autonomy profile or kill-switch changes.

Approval must be signed, one-time, actor-bound and bound to the exact proposal ID, nonce, asset, action, parameters, reason, policy version, issue/expiry times and approver role. Approval is revalidated immediately before execution. Expired, replayed, mismatched or unverifiable approvals are rejected.

### A4 — Prohibited
Never permitted, even in advanced autonomous mode:
- arbitrary shell or code execution;
- AI-generated commands or dynamic executable arguments;
- disabling or tampering with Security Guard, Malware Engine, audit, backups or monitoring to restore availability;
- deleting forensic evidence, logs or suspicious artifacts;
- restoring a known-suspect binary or snapshot;
- self-modifying policies, permissions, trust roots or its own code;
- uncontrolled lateral movement, credential harvesting or destructive retaliation;
- destructive data operations without a separate explicitly authorized operator workflow.

## 5. Decision algorithm

For every candidate response:

1. Authenticate source and validate schema, asset, timestamp, expiry and replay protection.
2. Correlate evidence; preserve conflicting signals and uncertainty.
3. Resolve asset criticality and dependency graph from the trusted registry.
4. Classify incident using deterministic rules.
5. Generate candidate typed actions from the approved playbook registry.
6. Evaluate each action against policy predicates, blast-radius budget, retry/cooldown, reversibility, evidence requirements and kill switch.
7. Choose the least-impact action that meets the recovery objective. If no safe action qualifies, take no action and escalate.
8. Atomically claim the action in durable storage before execution; enforce idempotency and per-asset locks.
9. Execute through the fixed adapter with a strict timeout and cancellation path.
10. Verify OS state and application readiness; observe a stability window before marking recovered.
11. Record result and evidence; stop further automatic actions if verification fails, state is ambiguous, or a budget is exhausted.
12. Notify the operator with the decision rationale and next safe action.

The decision record must include: incident ID, signal references, asset, classification, policy version, selected action, rejected alternatives and reasons, autonomy class, budget before/after, approval reference if any, execution result, verification result and timestamps.

## 6. Default response matrix

| Condition | Autonomous response | Guardrail |
|---|---|---|
| Non-critical service unavailable; no security signal | One bounded restart, then verify | Allowlist, cooldown, attempt cap |
| Repeated failures after restart | Stop and escalate | No restart loop |
| Dependency unavailable | Wait/notify or use exact dependency playbook | Do not restart all dependents |
| Suspected attack or conflicting signals | Preserve evidence, suspend recovery on affected scope, alert | No blind restart |
| Confirmed compromise of non-critical workload | Execute exact pre-approved containment playbook | Target identity and scope must verify |
| Integrity/tamper failure | Freeze recovery, preserve artifacts, alert | Never replace/restart suspect binary |
| Critical service outage | Diagnose and prepare proposal | Approval before action |
| Host unreachable | External monitor may prepare failover proposal | No self-recovery claim; external target required |
| Recovery verification fails | Stop, mark unverified, escalate | No repeated action cascade |
| Ledger/audit unavailable | Observe and alert only | Fail closed for remediation |

## 7. Safety invariants

- **Fail closed:** missing policy, unavailable durable ledger, invalid signal, stale evidence or adapter ambiguity blocks automatic action.
- **Least privilege:** separate read, containment and recovery permissions; short-lived credentials; no broad administrator token in the decision process.
- **Blast-radius limits:** per-action, per-incident, per-host and global concurrency ceilings.
- **Circuit breaker:** repeated failure or verification mismatch disables the affected playbook until explicit reset.
- **Evidence preservation:** append-only audit, evidence references, trusted timestamps and restricted access.
- **No split brain:** cross-host promotion requires external fencing/lease and authoritative ownership confirmation.
- **Kill switch:** authenticated operator can disable automatic actions; monitoring and audit remain on.
- **Policy integrity:** signed/versioned policy, monotonic version checks and dual control for policy/trust-root changes.
- **No false recovery:** only independent health checks plus a stability window can close a recovery incident.
- **Bounded autonomy:** no action outside the exact registered target, parameters, time window and budget.

## 8. State model

Incident lifecycle:

`NEW -> VALIDATING -> CORRELATED -> CLASSIFIED -> DECIDING -> (DENIED | AWAITING_APPROVAL | EXECUTING) -> VERIFYING -> (RECOVERED | UNVERIFIED | FAILED | ESCALATED)`

Action lifecycle:

`PROPOSED -> POLICY_CHECKED -> CLAIMED -> (AWAITING_APPROVAL -> APPROVED) -> EXECUTING -> VERIFYING -> (SUCCEEDED | FAILED | UNVERIFIED | EXPIRED | CANCELLED)`

All transitions are persisted atomically. Illegal transitions are rejected. Restarting the engine must not reset attempt limits, replay protection, incident ownership or active circuit breakers.

## 9. Required policy configuration

A host deployment must explicitly configure:
- autonomy profile and enabled classes (A0-A2 only for automatic execution);
- asset registry, criticality and dependency graph;
- exact typed playbooks, parameter schemas and allowed targets;
- evidence sources, trust identities, freshness and corroboration requirements;
- per-service and global retry/concurrency/action budgets;
- cooldowns, timeouts, health probes and stability windows;
- durable transactional ledger and append-only audit destination;
- approval verifier and authorized operator roles for A3;
- external monitor/fencing integration for any failover capability;
- emergency kill-switch owner and operational procedure.

No permissive defaults. Unconfigured policy means observe-only.

## 10. Rollout and certification gates

1. **Design and policy tests:** decision table, deny-by-default, stale/replayed/forged signals, conflicting verdicts, policy version rollback and kill-switch tests.
2. **Simulation:** outage, cascading dependency failure, suspected attack, confirmed compromise, tamper, ledger outage, adapter timeout, crash during action, repeated restart and verification failure.
3. **Isolated host labs:** real systemd and Windows SCM on disposable VMs; no production credentials or data.
4. **Shadow mode:** decisions logged but no actions; compare decisions with operator judgment and tune deterministic thresholds.
5. **Canary autonomy:** A1 first on explicitly non-critical services; A2 only after playbook-specific safety certification.
6. **Operational certification:** recovery objectives, evidence retention, audit review, rollback drills, kill-switch drill, failure injection and security review.
7. **Production authorization:** separate explicit approval; never implied by merging code or passing CI.

## 11. Non-goals and unresolved dependencies

This architecture does not itself provide cross-host failover, external monitoring, database restore, cloud infrastructure provisioning, identity-provider integration, network enforcement or a resident daemon. Those require separately reviewed adapters and independent control planes. A host that is completely down cannot recover itself.

The existing package currently provides bounded service recovery, a durable single-host file ledger, fixed Linux/Windows service adapters and post-action verification hooks. The advanced-autonomy design above is a target architecture, **not a claim that these capabilities are already implemented**. Multi-host operation requires a transactional shared store and fencing; security containment requires authenticated integrations and playbook-specific adapters.

## 12. Implementation sequence

- **Phase 1 — Policy foundation:** policy schema/versioning, asset criticality registry, typed playbook registry, autonomy classes, kill switch, deterministic decision records.
- **Phase 2 — Signal trust:** authenticated producer contracts, signature/transport validation, replay defense, freshness and correlation.
- **Phase 3 — Orchestration safety:** action budgets, idempotency, per-asset locks, circuit breakers, cancellation, durable state transitions.
- **Phase 4 — Verified containment:** exact Security Guard/Malware Engine signal contracts and isolated, reversible containment adapters.
- **Phase 5 — External resilience:** independent monitoring, fencing/lease, transactional shared ledger and controlled failover proposals.
- **Phase 6 — Certification:** simulation suite, Windows/Linux VM labs, shadow mode, canary, audit and recovery drills.

Each phase is developed on its own feature branch, tested in isolation, repaired and rerun before PR review and merge. No production deployment or paid infrastructure is part of this design approval.
