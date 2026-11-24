# Phase 5 — Block 12.8: Full-Pipeline Native Containment Integration

## Verified architectural gap

Block 12.7 certifies the native dispatcher, contained process runner and containment event journal directly on Linux cgroup v2 and Windows Job Objects. The surrounding Phase 5 components already provide the trusted engine registry, policy/approval orchestrator, autonomous runtime, bounded job queue, worker and lifecycle supervisor, but there is no host-native test that drives one real contained runner through that complete chain.

The existing process-runner tests cover parts of the orchestration and shutdown path with a generic runner or a test resource-controller double. Block 12.8 joins the actual native controller to the real policy and job lifecycle.

## Scope

- Register the contained runner as a trusted `local-process` QA engine.
- Verify the high-risk engine action remains blocked when the external approval provider is absent.
- Verify no child process or containment scope starts before approval.
- Run the approved plan through the real orchestrator, autonomous runtime, queue, worker and lifecycle supervisor.
- Record operational events in the shared bounded execution event journal.
- Complete one normal contained action and confirm the Phase 4 execution ledger remains valid and metadata-only.
- Enqueue a second authorized action that deliberately ignores cooperative cancellation and starts a descendant process.
- Close the supervisor with `abortActive: true`; verify the worker cancels the job, the native OS scope terminates, the runner/dispatcher close and no active containment scopes remain.
- Verify event ordering: controller closure must precede supervisor shutdown completion.
- Run the integration on Linux cgroup v2 and Windows Job Objects under Node 22 and Node 24.

## Host requirements

**Linux:** The native workflow prepares an ephemeral delegated cgroup v2 subtree and sets `JBQA_CGROUP_V2_TEST_ROOT`. The test uses only that delegated child path.

**Windows:** The native workflow uses Windows Server 2022 and the native Job Object controller through the built-in PowerShell host.

Unsupported developer platforms skip only this host-native end-to-end test. Portable unit tests continue to cover policy, registry, runtime, queue, worker and supervisor contracts.

## Security invariants

- Resource containment is mandatory: `required: true`.
- `allowUncontainedFallback: false`; both fallback lifecycle events must remain absent.
- Registry metadata and trusted adapter module paths are host-configured; job payloads cannot select a module, executable, path or OS controller.
- No adapter process starts before explicit authorization and approval.
- The policy orchestrator remains the authority for permissions, allowlisting and approval.
- Operational journal entries must not retain raw payloads, outputs, process IDs, source code or free-form errors.
- No direct writes to `main`, no new third-party dependency, no paid service and no host-wide privilege or cgroup configuration changes are introduced.

## Validation

- Native cgroup v2 controller + process-runner lab.
- Native Windows Job Object controller + process-runner lab.
- Block 12.7 native dispatcher/runner/journal integration.
- Block 12.8 native registry → orchestrator → runtime → queue → worker → supervisor integration.
- Core Validation, Security QA, Security Guard multi-runtime and JB Engines Certification.
- All six workflows must pass on the same `main` SHA after merge.

## Acceptance criteria

On both supported operating systems, the test must:
1. Block execution without an approval provider and show zero adapter starts.
2. Execute one approved plan under native resource enforcement.
3. Cancel a second non-cooperative action through supervisor shutdown and terminate its contained process scope and descendant.
4. Close the runner and dispatcher with zero active scopes.
5. Preserve Phase 4 ledger integrity and keep the operational journal free of payloads and PIDs.
6. Pass Node 22 and Node 24 native matrices and all post-merge certification workflows.

**Block 12.8 is complete only after the full host-native orchestration path and post-merge certification are green.**
