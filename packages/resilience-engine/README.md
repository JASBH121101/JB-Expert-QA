# JB Resilience Engine

Independent service-health and controlled-recovery engine for Linux and Windows.

## v1 laboratory scope

- Validated, server-owned service allowlist.
- Bounded recovery policy: failure threshold, restart limit and cooldown.
- Recovery proposals expire after 60 seconds.
- Automatic execution is limited to explicitly allowlisted, non-critical services.
- Critical services require an injected human-approval verifier.
- Linux systemd and Windows Service Control Manager adapters use fixed executables, fixed argument shapes, shell disabled, and caller-injected command runners.
- No daemon installation, host configuration changes, user creation, firewall changes, or production infrastructure access.

## Usage boundary

The host application provides health observations and a command runner with appropriate OS permissions. Adapters do not spawn processes themselves. The caller must authenticate and audit human approvals. A boolean supplied by an untrusted client is not an approval mechanism; use approvalVerifier to validate a signed, one-time, actor-bound approval record.

## Not included in v1

Cross-host failover, database restore, infrastructure provisioning, autonomous firewall changes, AI-driven shell commands, telemetry upload, and production service installation are out of scope. A fully unavailable host cannot recover itself; cross-host failover requires an independent external monitor and a separately provisioned healthy destination.
