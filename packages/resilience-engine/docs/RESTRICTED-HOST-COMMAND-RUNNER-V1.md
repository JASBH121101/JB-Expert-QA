# JB Resilience Restricted Host Command Runner v1

**Status:** laboratory implementation pending certification  
**Package:** \`@jb/resilience-engine/adapters/restricted-host-command-runner\`

## Purpose

This runner provides a deliberately narrow \`execFile\` port for the existing typed Linux systemd and Windows SCM adapters. It is not a general command executor.

The caller supplies an absolute executable path and an exact service allowlist. The runner accepts only the service-manager operations required by the adapters:

| Platform | Executable | Allowed operation forms |
|---|---|---|
| Linux | Fixed absolute \`systemctl\` path | \`restart <allowlisted-unit>\`; \`is-active --quiet <allowlisted-unit>\` |
| Windows | Fixed absolute \`sc.exe\` path | \`stop <allowlisted-service>\`; \`query <allowlisted-service>\`; \`start <allowlisted-service>\` |

All other executables, verbs, flags, argument counts and target services are rejected before process creation.

## Configuration

Linux:

\`\`\`js
import { createRestrictedHostCommandRunner } from "@jb/resilience-engine/adapters/restricted-host-command-runner";
import { createLinuxSystemdAdapter } from "@jb/resilience-engine/adapters/linux-systemd";

const runner = createRestrictedHostCommandRunner({
  platform: "linux-systemd",
  binaries: { systemctl: "/usr/bin/systemctl" },
  allowedServices: ["catalog-api.service"],
  timeoutMs: 10_000
});

const serviceAdapter = createLinuxSystemdAdapter({
  allowedServices: ["catalog-api.service"],
  timeoutMs: 10_000,
  run: runner.run
});
\`\`\`

Windows uses the same boundary with an absolute \`sc.exe\` path and the Windows adapter:

\`\`\`js
const runner = createRestrictedHostCommandRunner({
  platform: "windows-scm",
  binaries: { "sc.exe": "C:\\\\Windows\\\\System32\\\\sc.exe" },
  allowedServices: ["CatalogApi"],
  timeoutMs: 10_000
});
\`\`\`

The Windows runner uses the host's actual \`SystemRoot\` environment value to construct a minimal child-process environment. It does not search \`PATH\` for the executable.

## Security controls

- Uses Node.js \`execFile\` with \`shell: false\`; no command string is constructed.
- Requires an absolute, fixed executable path. PATH-based executable lookup is not supported.
- Enforces an exact operation grammar and exact service allowlist.
- Rejects malformed arguments, control characters, extra arguments, unapproved flags and unknown option fields.
- Ignores caller preference for visible Windows console windows and always uses \`windowsHide: true\`.
- Uses a minimal fixed child environment; caller-provided environment overlays are not accepted.
- Applies a fixed maximum timeout of 60 seconds and clamps per-call timeouts to the configured runner limit.
- Sets a bounded output buffer and caps returned stdout/stderr at 16 KiB each after removing terminal control sequences.
- Returns a stable status (\`succeeded\`, \`failed\`, \`timed_out\`) and numeric exit code rather than exposing raw thrown process errors.
- Does not retry, elevate privileges, invoke \`sudo\`, use \`runas\`, install services, or change OS security settings.

## Privilege model

The runner does not grant privileges. It executes under the operating-system identity of the hosting process. Operators must provision the narrowest OS permissions needed to manage only the configured services. Do not run the entire JB application as root or LocalSystem merely to make a restart succeed; use service-specific authorization or a separately hardened host agent if the runtime identity cannot safely manage the service.

The existing v0.6 policy engine remains responsible for authorizing a recovery request before the typed platform adapter is called. This runner only constrains the process invocation at the last host boundary; it cannot replace signed policy, mutation-stop controls, durable action claims or audit.

## Operational behaviour

- A command that returns a non-zero code remains a failure and the typed adapter rejects it.
- A timeout returns \`timed_out\`; the caller must treat the service state as uncertain and follow the existing reconciliation path. The runner never repeats a command.
- The existing Linux adapter verifies active state after restart when requested by the orchestrator.
- The existing Windows adapter uses stop/query/start/query with a bounded state wait.
- Service installation, deletion and configuration changes are not in the accepted command grammar.

## Laboratory certification

Unit tests use injected \`execFile\` callbacks to verify exact executable paths, argument vectors, environment minimization, timeout clamping, output bounds, failure mapping and rejection of arbitrary commands. They also run both existing typed adapters through this runner to certify the expected Linux and Windows operation sequences.

The existing real service-manager CI lab separately exercises a disposable systemd unit and a disposable Windows SCM service. It does not install, restart or alter production services.

## Explicit limitations

This v1 does not provide:

- a privileged broker or host agent;
- per-service OS ACL provisioning;
- signed commands or remote attestation;
- monotonic execution fencing tokens;
- distributed host coordination, leader election or quorum;
- production deployment or automatic service installation.

Host permission hardening, durable cross-host fencing and multi-host coordination remain separate certification gates.
