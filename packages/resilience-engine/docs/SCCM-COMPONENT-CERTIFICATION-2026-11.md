# Resilience Engine — SCCM component certification scope (2026-11)

This record defines the bounded scope for the next SCCM assessments. It does not grant runtime permissions, switch the runtime mode, enable A2 containment, enable A3 failover, or claim production readiness.

## A1 — policy and authorization gates

- `jb.resilience-engine.policy.owner-approval`: validate signature-verifier fail-closed behavior, policy validity, exact owner-activated revision/hash, anti-rollback, critical-service human approval, approval timeout and one-time proposal consumption.
- `jb.resilience-engine.policy.action-eligibility`: validate exact asset/environment/action allowlists, service criticality restrictions, trusted security state, health thresholds, cooldowns, bounded retries, idempotency and budget enforcement.
- A1 component PASS means these policy/authorization contracts and the existing typed OS-adapter lab are verified. It does not mean a host has supplied a production trust store, approval broker, durable revision store or capability ledger.

## A2 — containment safety contract only

- `jb.resilience-engine.containment.action-safety`: validate disabled-by-default behavior, exact branded readiness/scope, durable claim and provider-start markers, idempotency, deadline/mutation-stop handling, held outcomes, and fail-closed reconciliation.
- `jb.resilience-engine.containment.operator-verification` is renamed to **Independent containment and release verification**. It validates distinct executor/verifier/forensic identities, operation- and evidence-bound verification receipts, and refusal to release on failed/uncertain verification.
- PASS for these components certifies laboratory safety contracts only. The A2 module/subbranch/branch remain PENDING until a concrete host provider, independently operated verifier, production-grade durable stores, restart/release recovery, rollback and end-to-end fault-injection are certified. The Policy Engine must continue denying A2.

## A3 — narrow PostgreSQL laboratory components

- `jb.resilience-engine.failover.fencing` is renamed to **PostgreSQL target-state fencing (single-primary lab)**. Its tested guarantee is restricted to writes made through the PostgreSQL-managed target store: exact active lease, monotonic fencing high-water mark, stale-lease/token rejection and idempotent mutation IDs. It does not fence systemd, Windows SCM, cloud resources, external APIs or arbitrary application data stores.
- `jb.resilience-engine.failover.replay` is renamed to **PostgreSQL trusted-signal replay protection (single-primary lab)**. Its tested guarantee is unique source/event admission and integrity verification across gateway instances sharing one PostgreSQL primary, with bounded capacity and no automatic expiry-based deletion.
- `jb.resilience-engine.failover.leader-election` remains PENDING. Lease acquisition on one PostgreSQL primary is not quorum-based leader election and does not prove split-brain resolution, multi-region consensus or an independent monitor.
- The A3 module/subbranch/branch remain PENDING until independent monitoring/quorum, target-enforced fencing at every real execution target, replication/RPO, traffic cutover, rollback and independent post-failover verification are supplied and certified. The Policy Engine must continue denying A3.

## Required evidence

The exact PR head must pass:
- Resilience Engine test suite on Ubuntu and Windows, Node.js 22 and 24.
- Real service-manager lab on Ubuntu/systemd and Windows SCM.
- PostgreSQL 16 integration on Node.js 22 and 24, including lease/fenced-target and cross-instance trusted-signal replay cases.
- SCCM inventory, append-only history, dependency and ancestor-gate tests.

Every assessment must cite exact commit-bound workflow evidence. A green workflow is supporting evidence, not automatic approval of unrelated descendants. Historical assessments must remain intact and validated against their own registered source snapshots.
