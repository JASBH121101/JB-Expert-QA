# Phase 5 — Block 10: Linux cgroup v2 Resource Containment

## Verified architectural gap

Block 9 added a separate Node child process and direct-child termination. It explicitly did not impose CPU or memory quotas and could not guarantee termination of adapter-created descendants. The JB Resilience A2 containment controller is a different subsystem: it orchestrates authorized incident-response containment against host/provider assets. It does not create local per-execution process resource groups and is not reused as a substitute.

## Scope delivered

Add an opt-in Linux cgroup v2 resource controller that creates one dedicated cgroup for each isolated engine invocation. It uses only Node built-in filesystem/process APIs and the host's already-delegated cgroup v2 subtree.

- `memory.max`: hard per-scope memory ceiling.
- `memory.swap.max`: explicit swap ceiling (default 0).
- `cpu.max`: CPU bandwidth quota and period.
- `pids.max`: hard task/process-count ceiling.
- `memory.oom.group`: best-effort group OOM behavior when exposed by the kernel.
- `cgroup.kill`: kernel-managed termination of the cgroup and all descendant cgroups/processes.
- `memory.current`, `memory.peak` (when available), `memory.events`, `cpu.stat`, and `pids.current`: read-only usage snapshots.

The controller never mounts cgroupfs, invokes sudo, enables controllers, changes parent limits, edits systemd configuration, or writes to a global/root cgroup.

## Host prerequisites and fail-closed behavior

The host administrator must provide an absolute delegated directory below `/sys/fs/cgroup`. The directory must already expose and have enabled `cpu`, `memory`, and `pids` in its `cgroup.controllers` and `cgroup.subtree_control` interfaces. The required per-scope control files, including `cgroup.kill`, must be present and writable.

If any prerequisite is missing, scope creation fails before the child process is started. The controller does not try to repair global cgroup topology or elevate permissions. This is intentional: cgroup controller delegation is a host-administration task.

## Runner integration

The process runner accepts a trusted host-supplied `resourceController` and optional `requireResourceContainment: true`.

1. Create the per-invocation cgroup and write its limits.
2. Spawn the fixed child bootstrap.
3. On the child's `spawn` event, move its PID into `cgroup.procs`.
4. Verify attachment, then and only then send the bootstrap `initialize` message.
5. The child loads the fixed adapter module and accepts bounded JSON input.
6. On normal completion, timeout, cancellation or runner shutdown, the scope is closed. If any process remains in the scope, `cgroup.kill` is used and closure waits for the cgroup to become empty within a bounded cleanup window.
7. If resource cleanup cannot be confirmed, the runner rejects the execution as `RESOURCE_CLEANUP_FAILED`; it does not report a successful isolated execution.

The cgroup controller and process runner expose resource mode, configured limits, active scope count and read-only usage counters. Legacy runners remain compatible when no resource controller is supplied. When `requireResourceContainment: true` is configured without a trusted resource controller, runner construction fails closed.

## Platform boundary

**Linux:** the built-in provider supports cgroup v2 only, and only under a pre-delegated subtree. cgroup v1 and non-delegated/root cgroup paths are rejected.

**Windows:** there is no built-in Job Object provider in this increment. Windows Job Objects can enforce process-group limits, but Node's public `child_process` API does not expose the native Job Object creation/assignment/limit APIs needed to implement that safely without a native bridge. The Linux provider returns `UNSUPPORTED_PLATFORM` on Windows; resource containment must not be described as active there. A separately reviewed native Job Object provider is a future platform adapter.

## Security and limitations

This is OS-enforced resource accounting/limiting for accidental runaway workloads and bounded process-tree cleanup, not a complete security sandbox for hostile code. The adapter still runs under the host's OS identity and inherits that identity's filesystem/network rights. A process able to write to the delegated parent cgroup may attempt to move itself; deployments that execute adversarial code still need a separate unprivileged identity, namespace/container boundary, filesystem/network policy and seccomp/AppArmor/SELinux controls.

A cgroup memory limit may trigger an OOM kill inside the cgroup; memory usage can temporarily cross the configured hard boundary under kernel reclaim/accounting conditions. `cpu.max` sets CPU bandwidth (quota/period), not CPU affinity. `pids.max` limits kernel tasks and includes threads. These are not wall-clock runtime or exactly-once guarantees.

No automatic retry, replay, scheduler, background poller, remote worker, distributed queue, native addon, third-party dependency or paid service is introduced. The Orchestrator remains the sole policy, permission, approval and dispatch authority. Phase 4 execution evidence, durable queue format and Block 8 event journal remain unchanged.

## Validation

- Configuration validation and non-delegated/root cgroup rejection.
- Runner fails before process startup when required containment is not configured.
- Child attachment occurs before the adapter bootstrap is initialized.
- Resource-scope attachment/cleanup failures fail closed.
- Cancellation and timeout invoke whole-scope termination after the cooperative grace period.
- Optional real cgroup v2 integration test runs only when `JBQA_CGROUP_V2_TEST_ROOT` points to an administrator-prepared delegated test subtree.
- NPM root/subpath imports and clean tarball build inclusion.
- Core Validation, Security QA, Security Guard multi-runtime, NPM Distribution, JB Engines Integration and JB Engines Certification must pass before merge.

## Host configuration example

The host administrator prepares a delegated cgroup v2 subtree and enables the required controllers before launching the service. The application does not attempt those privileged host changes.

```js
import {
  createLinuxCgroupV2ResourceController,
  createLocalProcessEngineRunner
} from "@jb/expert-qa";

const resourceController = createLinuxCgroupV2ResourceController({
  cgroupRoot: "/sys/fs/cgroup/user.slice/jb-expert-qa-delegated",
  limits: {
    maxMemoryBytes: 536870912,
    maxSwapBytes: 0,
    cpuQuotaMicros: 50000,
    cpuPeriodMicros: 100000,
    maxProcesses: 32
  }
});

const runner = createLocalProcessEngineRunner({
  engineId: "jb.static-qa-engine",
  moduleRoot: trustedAdapterRoot,
  modulePath: trustedAdapterModulePath,
  resourceController,
  requireResourceContainment: true
});
```

When this runner is registered with the existing engine registry, the same runner instance must also be supplied to the execution lifecycle supervisor's `processRunners` list so shutdown closes active scopes before durable queue storage is released.
