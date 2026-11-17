# JB Resilience ARC Certification

**ARC** means Autonomous Response Certification. It is a certification harness and evidence protocol inside `@jb/resilience-engine`, not a separate defensive engine or a grant of additional runtime authority.

## Certification profile

ARC certifies the implemented capability envelope, not the aspirational autonomy target.

| Capability | Current runtime boundary | ARC disposition |
|---|---|---|
| A0 observe | Read-only observation and incident analysis | Testable |
| A1 restart-service | Only exact allowlisted stateless, standard-criticality services; signed active policy, trusted fresh signals, durable claims/audit, mutation stop checks and post-action verification required | Candidate for operational lab certification |
| A2 bounded containment | Readiness evidence only; provider execution and independent verification gates are not all implemented as an executable runtime | Not executable; must remain denied |
| A3 controlled failover | Readiness evidence only; external monitor/quorum, target-enforced fencing, replication/RPO, cutover and independent verification are not a complete executable control plane | Not executable; must remain denied |

The runtime must continue to report `mode: semi-autonomous` and `targetMode: autonomous-advanced` until advanced capabilities are actually implemented and certified. ARC must never infer capability from a target profile, a risk score, a signed statement alone, or an all-green unit-test suite.

## ARC test layers

1. **Contract integrity:** exact schemas, immutable outputs, bounded inputs and no unsupported fields.
2. **A1 execution envelope:** exact service/asset/environment binding, trusted signal provenance, signed policy and current revision, durable atomic idempotency claim, mutation-stop checks immediately before execution, typed host adapter, bounded execution, service verification and application health verification.
3. **A2 denial boundary:** each required evidence item is independently necessary; stale, missing, false, malformed or unsupported evidence denies readiness; readiness never grants execution.
4. **A3 denial boundary:** every monitor, quorum, lease, fencing, replication, readiness, rollback and verification gate is independently necessary; readiness never grants execution.
5. **Fault injection:** store/audit outage, stale or replayed signal, policy revocation, expired authorization, adapter timeout, failed health verification, duplicate incident, circuit open, and mutation-stop activation must fail closed.
6. **Cross-platform:** run the same deterministic contracts on Ubuntu and Windows, Node.js 22 and 24. Platform adapters additionally require their own OS-specific integration lab.
7. **Evidence report:** record commit SHA, runtime matrix, test counts, failures, scenario IDs and capability disposition. Do not label a test-only result as production certification.

## Safety invariants

- A2 and A3 readiness results always contain `executable: false`.
- Missing, stale, future-dated, conflicting, untrusted or malformed evidence never increases authority.
- No caller-supplied boolean is accepted as proof without a host-owned verifier tied to authoritative evidence.
- No arbitrary shell command, executable path, firewall command, route change or external provider mutation is introduced by ARC.
- A failed or uncertain recovery verification is not reported as recovered.
- No A2/A3 capability is enabled by this certification harness.

## Certification status

This document defines the in-repository ARC lab. Passing its tests is necessary but not sufficient for production readiness. Production certification still requires host-specific deployments, real scanner/storage/provider integrations where applicable, independently verifiable telemetry, rollback exercises, operational monitoring and an approved risk owner.
