# JB Resilience Engine — A2/A3 readiness gates (laboratory)

## Status

This increment adds a read-only readiness evaluator for the A2 containment and A3 controlled-failover capability classes. It does not execute containment, promote a writer, change routes, invoke an operating-system command or grant policy authorization.

The evaluator is deliberately not an executor. Its output always has `executable: false`, including when every readiness predicate is true.

## A2 — bounded containment

A2 readiness requires all of the following host-verified predicates:

- Confirmed security verdict from a trusted source.
- Authenticated and replay-protected signal.
- Exact asset binding.
- Owner-approved containment profile.
- Reversible typed adapter.
- Independent verification of containment.
- Tested rollback plan.
- Forensic evidence preservation.
- Available containment budget.

The host must derive each predicate from authoritative integrations. Passing `true` from an untrusted client is not evidence. No concrete network, cloud, hypervisor or endpoint isolation provider is bundled; therefore A2 execution remains disabled.

## A3 — controlled failover

A3 readiness requires all of the following host-verified predicates:

- Independent external monitor and unambiguous monitor quorum.
- Durable coordination and an exclusive, unexpired lease.
- Monotonic fencing and enforcement at the actual target.
- Source fenced before promotion.
- Healthy replication within the service's explicit RPO.
- Ready target and dependencies.
- Prepared bounded traffic cutover and rollback.
- Post-failover verification.
- Available failover budget.

The PostgreSQL fenced target protects state mutations committed to the same PostgreSQL primary. It does not fence unrelated databases, systemd, Windows SCM, storage systems or external APIs. A lease or a point-in-time `verifyLease()` call alone is insufficient.

No independent monitor, consensus/quorum provider, replication observer, target promotion adapter or traffic controller is bundled. Therefore A3 execution remains disabled.

## API

```js
import {
  evaluateA2ContainmentReadiness,
  evaluateA3FailoverReadiness
} from "@jb/resilience-engine/continuity-gates";

const result = evaluateA3FailoverReadiness({
  independentExternalMonitor: true,
  monitorQuorum: true,
  durableCoordination: true,
  exclusiveUnexpiredLease: true,
  monotonicFencing: true,
  targetEnforcesFencing: true,
  sourceFenced: true,
  replicationHealthy: true,
  replicationWithinRpo: true,
  targetReady: true,
  dependenciesReady: true,
  trafficCutoverPrepared: true,
  rollbackPrepared: true,
  postFailoverVerification: true,
  budgetAvailable: true,
  observedAt: Date.now(),
  expiresAt: Date.now() + 10_000,
  now: Date.now()
});

// Readiness only. Never pass this result as an authorization token.
if (result.eligible) {
  // A separately certified, host-owned execution control plane is still required.
}
```

The time window is checked fail-closed. Unknown fields, missing predicates, false predicates, malformed timestamps, future observations and expired evidence deny readiness.

## Certification boundary

Tests in `tests/continuity-gates.test.js` validate the readiness contract and negative cases. They do not certify external providers or production infrastructure. A2/A3 remain blocked until real provider integrations, threat/fault injection and end-to-end target tests pass in an isolated environment.
