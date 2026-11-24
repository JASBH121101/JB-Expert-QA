# Phase 5 — Block 11: Windows Job Object Resource Containment

## Status and scope

This block adds the Windows counterpart to the Linux cgroup v2 resource controller. It is opt-in and integrates with the existing local process runner through the same `resourceController` contract.

The controller creates one native Windows Job Object per execution. A small host process uses the inbox Windows PowerShell installation and .NET P/Invoke declarations for `kernel32.dll`; no npm native addon, compiler dependency at install time, paid service, or third-party package is added.

## Enforced controls

- **Job committed-memory limit:** `JOB_OBJECT_LIMIT_JOB_MEMORY` caps the committed memory charge across the job. This is not a physical-RAM or working-set ceiling.
- **Hard CPU-rate cap:** `JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP` applies a hard rate ceiling. `cpuRatePercent` is from 1 to 100; Windows receives percentage × 100.
- **Active process count:** `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` caps the number of active processes in the job.
- **Process-tree termination:** `TerminateJobObject` terminates the entire job, not only the Node worker PID.
- **Fail-safe close:** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates associated processes when the helper's last Job Object handle closes. Breakaway flags are not enabled.

Windows automatically associates child processes with their parent's job unless a permitted breakaway policy applies. This controller does not enable breakaway. The process runner still attaches the trusted Node bootstrap before sending its `initialize` message, so the adapter module is not loaded before OS assignment succeeds.

## Usage

```js
import {
  createLocalProcessEngineRunner,
  createWindowsJobObjectResourceController
} from "@jb/expert-qa";

const resourceController = createWindowsJobObjectResourceController({
  limits: {
    maxMemoryBytes: 512 * 1024 * 1024,
    cpuRatePercent: 50,
    maxProcesses: 32
  }
});

const runner = createLocalProcessEngineRunner({
  engineId: "jb.audit.visual",
  moduleRoot: "C:\\jb-qa\\adapters",
  modulePath: "C:\\jb-qa\\adapters\\visual.mjs",
  resourceController,
  requireResourceContainment: true
});

try {
  const report = await runner.run({ target: "local-project" });
  console.log(report);
} finally {
  await runner.close();
  await resourceController.close();
}
```

Defaults: 512 MiB committed-memory limit, 50% CPU hard cap, 32 active processes, 10-second helper startup deadline, 5-second command deadline and 5-second cleanup deadline. All limits are host-controlled; adapter input cannot override them.

## Platform and failure behavior

- Windows only. The controller resolves the inbox Windows PowerShell executable under `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`; it does not search an arbitrary PATH entry.
- Windows Job Objects with CPU hard-rate control require a supported modern Windows release. The CI lab uses Windows Server 2022.
- Job Object nesting can be constrained by an outer job applied by a service or runner. If Windows rejects assignment or a requested limit, the controller reports an error; it does not downgrade to best-effort process-only isolation.
- Use `requireResourceContainment: true` when OS enforcement is mandatory. Without a controller, the existing process runner retains its backward-compatible behavior.
- Usage snapshots report native job CPU time, active/total/terminated process counts, and peak job memory. The memory limit is committed memory, not current resident RAM.
- The PowerShell helper is a control process outside the workload job. If it exits unexpectedly, closing its Job Object handle triggers the kill-on-close policy.

## Security boundary

Job Objects provide resource governance and process-tree lifecycle control, not a complete security sandbox. The adapter still runs under the same Windows user identity and may inherit that identity's file and network permissions. Hostile adapters require separate OS identity and additional filesystem, network, integrity-level, AppContainer, or other platform security controls.

## Validation

The dedicated `.github/workflows/windows-job-object-containment.yml` workflow runs the native integration lab on Windows Server 2022 with Node 22 and 24. The lab verifies policy validation, native Job Object creation, process assignment before adapter initialization, descendant process termination, cleanup, and runner integration. Package distribution smoke tests verify both the root and package subpath exports.

The existing Linux cgroup v2 backend remains independent and unchanged.
