# JB Resilience Engine

Independent service-health and controlled-recovery engine for Linux and Windows.

## v1 laboratory scope

- Validated, server-owned service allowlist.
- Bounded recovery policy: failure threshold, restart limit and cooldown.
- Recovery proposals include random proposal IDs/nonces and expire after 60 seconds; expiry is rechecked after any asynchronous approval verification and immediately before adapter invocation.
- Automatic execution is limited to explicitly allowlisted, non-critical services.
- Critical services require an injected human-approval verifier. The host verifier must validate a signed approval bound to the exact proposal ID, nonce, service, action, issue/expiry times and authorized human subject; it must also enforce durable one-time replay protection.
- Linux systemd and Windows Service Control Manager adapters use fixed executables, fixed argument shapes, shell disabled, and caller-injected command runners. Windows recovery waits for SCM `STOPPED` before issuing `start`, then confirms `RUNNING` within a bounded timeout.
- A host-provided active Security Guard/Malware Engine threat or tamper signal suspends recovery. Resilience never overwrites binaries or attempts file repair.
- No daemon installation, host configuration changes, user creation, firewall changes, or production infrastructure access.

## Usage boundary

The host application provides health observations and a command runner with appropriate OS permissions. Adapters do not spawn processes themselves. The caller must authenticate and audit human approvals. A boolean supplied by an untrusted client is not an approval mechanism; use `approvalVerifier` to validate a signed, one-time, actor-bound record covering the exact proposal ID, nonce, service ID, action and expiry. The engine prevents in-process proposal reuse, but durable replay protection across process restarts is the host verifier's responsibility.

## Not included in v1

Cross-host failover, database restore, infrastructure provisioning, autonomous firewall changes, AI-driven shell commands, telemetry upload, and production service installation are out of scope. A fully unavailable host cannot recover itself; cross-host failover requires an independent external monitor and a separately provisioned healthy destination.

## State and deployment boundary

Health observations and restart-attempt counters are held in bounded in-memory state in v1. They reset when the host process restarts and are not a durable production recovery ledger. The host must persist and atomically reconcile recovery attempts before enabling host-level automation; this package does not provide a durable database store, resident agent, scheduler or background probe.
