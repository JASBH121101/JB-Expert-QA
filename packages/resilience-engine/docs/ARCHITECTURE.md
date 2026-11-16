# Resilience Engine architecture

## Independence

JB Resilience Engine is a separately versioned package with its own API, policy, tests, platform adapters, recovery ledger and release gate. It does not import Expert QA, Security Guard or Malware Engine. Integration is optional and uses versioned, validated messages only.

## Recovery flow

1. The host collects health observations and provides service IDs from a server-owned allowlist.
2. The policy evaluator checks allowlisting, failure threshold, restart cap, cooldown and threat/tamper state.
3. The engine issues an opaque in-process proposal with a random proposal ID, nonce and 60-second expiry.
4. Critical services require an external approval verifier to validate a signed, one-time, actor-bound human approval.
5. The engine rechecks expiry and obtains an atomic recovery claim from the recovery store. The store increments the service attempt counter before any OS operation.
6. The platform adapter requests the operation through a fixed command and injected runner. No shell is used.
7. The adapter verifies the service-manager state; an optional host health check can additionally validate application-level readiness.
8. The result is written to the ledger. A claimed operation whose result cannot be finalized remains consumed for operator review.

## Recovery ledger

- \`createMemoryRecoveryStore()\` is intended for tests and development only.
- \`createFileRecoveryStore()\` persists a bounded JSON ledger on one host. It uses exclusive lock creation, a bounded wait, recovery of locks owned by dead processes, restrictive file modes, temporary-file writes, fsync and atomic rename.
- The durable claim operation is serialized across local processes and rejects duplicate proposal IDs/nonces and attempts beyond policy limits.
- Storage errors, malformed state, exhausted capacity and unresolved live locks fail closed.
- The file store is not a distributed lock/consensus system. Multi-host deployments must inject a database-backed store with a transactional claim or unique constraint.
- The file ledger stores bounded operational metadata only. It does not store approval signatures, secrets or full command output.

The health monitor's detailed observation counters remain in-memory. The persistent recovery ledger separately protects actual recovery attempts across process restarts. This prevents a restart of the host process from resetting the enforced recovery budget, while the host monitoring system remains the source of detailed health history.

## Platform adapters

- Linux: systemd unit restart using \`systemctl restart\` with an allowlisted unit name. Verification uses \`systemctl is-active --quiet\`.
- Windows: Service Control Manager using \`sc.exe stop\`, bounded polling until \`STOPPED\`, \`sc.exe start\`, then bounded polling until \`RUNNING\`. A separate verification query confirms the service is still \`RUNNING\`.
- All commands use fixed executables/argument lists, shell disabled, an injected runner and bounded timeouts. Production runners must capture exit status, bound output, terminate timed-out processes and avoid exposing environment secrets.

## Integration contracts

- Expert QA may inspect package source, tests and recovery policy changes in CI. It is not required at runtime.
- Security Guard may publish sanitized security events or request a health review. It cannot grant Resilience permission to weaken security controls.
- Malware Engine may report host-integrity findings. A host-provided active malware/tamper signal from Malware Engine or Security Guard suspends recovery and requires human review; Resilience must not overwrite suspicious files or restore untrusted binaries.
- Each engine keeps its own policy authority, storage and release lifecycle.

## Safety boundaries

The engine never deletes files, restores databases, changes firewall or ACL policy, disables security controls, installs services, runs arbitrary shell text, or changes production infrastructure. Cross-host failover is deferred: a dead host requires an independent external monitor and a separately provisioned target. Database restore and infrastructure changes remain human-approved operations.

Approval verification and host health checks have configurable timeouts and receive an `AbortSignal`; host callbacks should observe it and stop work when aborted. Critical-service approval signatures, subject authorization and durable nonce replay checks remain the responsibility of the injected host approval verifier. The engine's in-process WeakSets are defense in depth and are not a replacement for a durable store or a trusted verifier.


## Target autonomy architecture

The selected target profile is **autonomous-advanced**. See [ADVANCED-AUTONOMY.md](./ADVANCED-AUTONOMY.md) for the target signal gateway, deterministic decision engine, capability policy gate, bounded containment, failover prerequisites, policy schema v2, hard prohibitions and validation roadmap. This specification does not change the current runtime mode or grant new permissions. The implemented v0.2 recovery foundation remains `semi-autonomous` until the staged implementation and certification gates are completed.
