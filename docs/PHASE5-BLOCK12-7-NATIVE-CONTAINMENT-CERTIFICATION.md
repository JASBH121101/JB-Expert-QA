# Phase 5 — Block 12.7: Native Containment Integration Certification

## Purpose

Certify the complete Block 12 containment path on real supported operating systems. Existing adapter labs verify cgroup v2 and Windows Job Object primitives, while this block verifies that the capability detector, unified policy, OS dispatcher, contained process runner and lifecycle journal work together without an uncontained downgrade.

## Scope

- Add a host-gated integration test that uses `createContainedLocalProcessEngineRunner`.
- Require native containment in the test policy; fallback is prohibited.
- Verify the selected native mode is Linux cgroup v2 or Windows Job Object on the matching host.
- Execute a real adapter process through the managed runner.
- Verify attach-before-execution through the native controller's process-attachment event.
- Verify execution-correlated journal events and absence of fallback events.
- Verify orderly runner/dispatcher shutdown and zero active scopes.
- Verify the operational journal does not retain the adapter PID or input payload.
- Expand the Linux and Windows native workflows so changes to the dispatcher, policy, capability detection, contained runner and event journal trigger both their host-specific lab and this integration test.
- Run the native jobs on both configured Node LTS lines.

## Host requirements

**Linux:** The existing lab prepares an ephemeral delegated cgroup v2 subtree and sets `JBQA_CGROUP_V2_TEST_ROOT`. The integration test uses that path and leaves host delegation setup to the workflow.

**Windows:** The existing Windows Server 2022 lab uses the inbox Windows PowerShell and native Job Object adapter. The integration test does not require a cgroup path.

Unsupported developer hosts skip only the native-host integration test. The existing deterministic dispatcher and contained-runner tests remain separate and portable.

## Security invariants

- `required: true`; fallback is not permitted.
- No direct changes to `main`.
- No privileged host setup is introduced into application code.
- No shell command execution or arbitrary adapter mutation is added.
- No new dependency, native addon, paid service, or hosted infrastructure is introduced.
- Journal records contain correlation identifiers and fixed lifecycle metadata only.

## Validation

- Linux cgroup v2 controller and process-runner lab.
- Windows Job Object controller and process-runner lab.
- Native dispatcher → contained runner → event journal integration test.
- Existing deterministic containment policy, capability detection, dispatcher, process-runner and journal suites.
- Core Validation, Security QA, Security Guard multi-runtime and JB Engines Certification before merge.
- Re-run both native OS workflows and general certification against the resulting `main` commit after merge.

## Acceptance criteria

The Linux job must report `linux-cgroup-v2` with `enforced: true`; the Windows job must report `windows-job-object` with `enforced: true`. Both must complete an adapter execution, record an attached process and correlated lifecycle events, record no fallback event, close all scopes and pass their native adapter lab.

**Block 12.7 is complete only when both host-native jobs and the required general post-merge workflows succeed.**
