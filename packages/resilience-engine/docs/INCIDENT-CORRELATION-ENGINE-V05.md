# Incident Correlation & Decision Engine v0.5 (laboratory)

## Purpose

The v0.5 module correlates a trusted-signal snapshot from the Trusted Signal
Gateway with bounded host health observations for one exact asset,
environment and service. It creates a deterministic incident identity,
normalizes the active observation window, detects contradictory health events,
assigns deterministic priority/risk, and emits an ordered decision trace. The
risk score is a deterministic rule-weighted index, not a statistical
probability or calibrated likelihood.

## Input contracts

The module accepts only:

- **jb.resilience.incident-input/v1**: exact asset ID, environment, service ID,
  a direct Gateway jb.resilience.signal-state/v1 result, and a bounded array of
  health observations.
- **jb.resilience.health-observation/v1**: UUID observation ID, exact
  asset/environment/service scope, millisecond timestamp, healthy, unhealthy
  or unknown status, consecutive-failure count, and a normalized reason code.

The caller must obtain the security snapshot directly from the configured
Trusted Signal Gateway and health observations from its trusted host monitor.
Neither contract accepts browser/client-provided security or health state.

## Correlation and identity

The default correlation window is five minutes. It is bounded to 30 seconds
through 30 minutes; clock skew and observation count are bounded as well.
Observations older than the active window are excluded. Observations too far in
the future are rejected. Repeated identical observation IDs are idempotently
deduplicated. Reuse of an observation ID with changed content, or conflicting
health states at the same timestamp, is classified as a conflict and escalated.

The incident ID is a SHA-256-derived identifier from the exact asset,
environment, service and correlation-window bucket. It is stable for repeated
evaluations within that bucket and changes at the next window boundary. Input
permutation does not alter the incident ID, selected rule or trace.

## Decision precedence

The deterministic precedence is:

1. Observation-ID conflict.
2. Trusted tampering.
3. Confirmed threat.
4. Conflicting trusted sources.
5. Conflicting health observations.
6. Stale or unknown security state.
7. Suspected threat, with elevated priority if health is also failing.
8. Missing/unknown health.
9. Clear security with repeated health failures.
10. Degraded health below the escalation threshold.
11. Clear security and healthy service.

Every decision includes a risk score, priority, selected rule, complete
ordered rule trace, reason codes, affected asset/service, health summary and
preserved evidence references.

## Non-authority boundary

This module is read-only. It does not persist incident lifecycle state, gather
telemetry, call external services, change policy, create authorizations, restart
services, quarantine files, contain assets or fail over. It always returns:

- authorizationGranted: false
- mayAuthorizeRecovery: false
- preserveEvidence: true

A review-recovery-policy decision only recommends that the trusted host
evaluate the independent A1 policy gate. It is not a permit, authorization,
capability reservation, or recovery proposal. Unknown, stale, conflicting,
suspected, confirmed and tampered security states never recommend recovery
evaluation.

## Deferred

Durable incident lifecycle storage, cross-asset campaign correlation, external
event ingestion, automated response orchestration, A2 containment and A3
failover remain separate future modules and certification gates.
