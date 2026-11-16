# Resilience Engine v1 architecture

## Independence

JB Resilience Engine is a separately versioned package with its own API, policy, tests, platform adapters and release gate. It does not import Expert QA, Security Guard or Malware Engine. Integration is optional and uses versioned, validated messages only.

## v1 flow

1. The host collects a health observation and maintains bounded failure/restart counters.
2. The policy evaluator checks service allowlisting, failure threshold, restart cap and cooldown.
3. The engine issues an opaque in-process proposal with a random proposal ID, nonce and 60-second expiry.
4. A non-critical allowlisted service may be restarted under policy.
5. A critical service requires an external approval verifier to validate a signed, one-time, actor-bound human approval. The signature must cover the exact proposal ID, nonce, action, service ID, issued-at and expiry timestamps; the verifier must validate actor privileges and durably reject nonce replay.
6. A platform adapter requests the operation through a fixed command and an injected runner. No shell is used. Proposal expiry is checked again after asynchronous verification and immediately before adapter invocation.

## Platform adapters

- Linux: systemd unit restart using systemctl restart with an allowlisted unit name.
- Windows: Service Control Manager using `sc.exe stop`, bounded polling until `STOPPED`, `sc.exe start`, then bounded polling until `RUNNING`. Exit code zero from stop/start is treated only as command acceptance, not proof of service state.

Adapters do not spawn processes directly. The host injects the runner, owns OS permissions, records audit events and applies command timeouts. Production runners must capture exit status, bound output, terminate timed-out processes, and avoid exposing environment secrets.

## Integration contracts

- Expert QA may inspect package source, tests and recovery policy changes in CI. It is not required at runtime.
- Security Guard may publish sanitized security events or request a health review. It cannot grant Resilience permission to weaken security controls.
- Malware Engine may report host-integrity findings. A host-provided active malware/tamper signal from Malware Engine or Security Guard suspends recovery and requires human review; Resilience must not overwrite suspicious files or restore untrusted binaries.
- Each engine keeps its own policy authority, storage and release lifecycle.

## Safety boundaries

v1 never deletes files, restores databases, changes firewall or ACL policy, disables security controls, installs services, runs arbitrary shell text, or changes production infrastructure. Cross-host failover is deferred: a dead host requires an independent external monitor and a separately provisioned target. Database restore and infrastructure changes remain human-approved operations.

## State and autonomy limits

Health observations and restart-attempt counters are bounded in-memory state only and reset on process restart. v1 does not ship a durable store, background scheduler, resident agent or probe runner. The host is responsible for durable, atomic recording before enabling host-level automation. In-process WeakSet replay protection is defense in depth only; the injected approval verifier must provide durable one-time nonce consumption.
