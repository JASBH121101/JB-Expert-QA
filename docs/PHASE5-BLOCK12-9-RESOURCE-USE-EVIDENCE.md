# Phase 5 — Block 12.9: Native Resource Usage Evidence

## Verified architectural gap

Blocks 10 and 11 added native per-execution resource accounting on Linux cgroup v2 and Windows Job Objects. The controllers expose read-only usage snapshots while a scope is active, and the process runner exposes the current scope through `getStatus()`. Blocks 12.7 and 12.8 correlate lifecycle events and prove scope termination, but their event journal does not retain a final, queryable resource-usage record after a scope is closed.

Block 12.9 adds one sanitized resource snapshot to the existing bounded execution event journal when each enforced native scope closes.

## Scope delivered

- Capture the controller's last read-only usage snapshot immediately before the native scope is closed.
- Normalize platform-specific values to a small, fixed numeric schema.
- Correlate the snapshot with the trusted engine ID and generated execution ID.
- Keep the snapshot before `CONTAINMENT_SCOPE_CLOSED` in the execution event sequence.
- Preserve observer isolation: a journal or metrics-read failure is recorded as a safe containment failure event and never changes the controller's enforcement/cleanup operation.
- Do not emit a resource snapshot when the dispatcher reports an uncontained fallback.

## Resource evidence schema

The journal event type is `CONTAINMENT_RESOURCE_SNAPSHOT`. Every optional metric is a non-negative safe integer. Unsupported fields, nested records and payloads remain rejected.

| Metric | Linux cgroup v2 | Windows Job Object |
|---|---|---|
| `memoryCurrentBytes` | Current cgroup memory | Not exposed by this controller |
| `memoryPeakBytes` | cgroup peak memory when available | Peak Job Object committed memory |
| `memoryLimitBytes` | Configured `memory.max` | Configured Job Object committed-memory limit |
| `cpuUsageMicros` | cgroup CPU usage | Job Object total user + kernel CPU time |
| `cpuLimitPercent` | Unified CPU policy percentage | Enforced hard CPU-rate percentage |
| `cpuPeriods` | cgroup CPU periods | Not exposed |
| `cpuThrottledPeriods` | cgroup throttled periods | Not exposed |
| `cpuThrottledMicros` | cgroup throttled time | Not exposed |
| `processCount` | Current cgroup tasks | Current Job Object processes |
| `processLimit` | Configured pids limit | Configured active-process limit |
| `totalProcesses` | Not exposed | Cumulative Job Object process count |
| `terminatedProcesses` | Not exposed | Cumulative terminated Job Object process count |
| `memoryMaxEvents` | cgroup memory max events | Not exposed |
| `memoryOomEvents` | cgroup OOM events | Not exposed |
| `memoryOomKillEvents` | cgroup OOM-kill events | Not exposed |

A metric not supplied by a platform adapter is omitted rather than fabricated. Windows Job Object committed memory is not physical RAM/working-set usage; the event preserves that controller's documented semantics. CPU percentages represent the configured CPU rate limit, not measured utilization.

## Security invariants

- The snapshot is emitted only when the dispatcher reports `enforced: true`.
- The event contains only engine/execution correlation IDs, a fixed event code and allowlisted numeric counters.
- PIDs, attached PIDs, raw input/output, module paths, source code, environment values, raw error messages and arbitrary nested usage objects are never accepted.
- All counters must be non-negative safe integers.
- Resource metrics are accepted only on `CONTAINMENT_RESOURCE_SNAPSHOT`, never on unrelated lifecycle events.
- Metrics are observed before scope close; native controller termination and cleanup semantics remain unchanged.
- A failed metrics observer does not authorize fallback, skip cleanup or turn a failed execution into a successful one.
- No dependency, native addon, paid service, host privilege change or cgroup topology mutation is introduced.

## Validation

- Journal schema accepts valid platform-neutral numeric metrics and rejects negative, fractional, non-finite, unsafe, unapproved and PID fields.
- Linux native integration verifies the resource snapshot contains the policy limits and final CPU/process counters.
- Windows native integration verifies the resource snapshot uses the Job Object memory, CPU and process counters.
- Full supervisor integration verifies one snapshot for both successful and forcibly cancelled scopes, correlated by execution ID and sequenced before scope closure.
- Fallback integration remains free of native resource evidence.
- Linux cgroup v2 and Windows Job Object labs run on Node 22 and Node 24.
- Core Validation, Security QA, Security Guard multi-runtime and JB Engines Certification pass before merge.
- All six post-merge workflows pass on the same `main` SHA.

**Block 12.9 is complete only when native snapshots are captured on both operating systems and all post-merge certification gates are green.**
