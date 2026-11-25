# Phase 5 — Block 13.8: Final Autonomous Independence Certification

## Certification result

**Certified scope: local single-host autonomous runtime, independent of GitHub Actions as an execution dependency.**

This certification is deliberately narrower than a claim of total application or infrastructure independence. The host runtime can start, poll, execute policy-approved queued work, persist state, stop gracefully and resume reading durable state after an OS-process restart without GitHub Actions, CI variables, a cloud scheduler, a remote queue or a paid API.

It does not certify that a production application has already supplied its trusted orchestrator, real approval provider, engine registrations, service account, storage permissions or deployment supervisor. Those remain application/operator responsibilities.

## Reproducible certification command

Requirements: Node.js 22 or newer and the repository's development dependencies installed.

Run:

```sh
npm run certify:autonomous-independence
```

Write a machine-readable JSON certificate to a file:

```sh
npm run certify:autonomous-independence -- --output=./autonomous-independence-certificate.json
```

The command statically traverses the bootstrap entrypoint's transitive ESM import graph, resolves local modules, parses source with Acorn, inventories Node built-ins, and fails when it discovers unresolved local imports, third-party imports, GitHub/Actions package dependencies or network client primitives in the host core dependency graph. It also validates the documented Node version, repository and standalone package exports, loopback-only dashboard default, inert bootstrap tests and the cross-process operations lab.

The script emits schema `jb.expert-qa.autonomous-independence-certificate/v1`, includes the exact CI source revision when available, and exits non-zero if any check fails. Core Validation runs this command on Node 22 and Node 24 and uploads the JSON certificate as a 30-day workflow artifact.

The static import-graph result is paired with dynamic evidence from Block 13.7. Static analysis alone does not prove runtime behavior.

## Independence matrix

| Capability | Result | Evidence / boundary |
|---|---|---|
| Host process startup | Independent | Explicit Node.js bootstrap; no Actions API or service required |
| Autonomous polling and work dispatch | Independent | Local host runner drains the local queue |
| Durable jobs and event journal | Independent of cloud | Local files, checksums, atomic persistence and exclusive process locks |
| Execution ledger | Independent of cloud | Local JSONL hash-chain ledger |
| Process restart continuity | Validated | Block 13.7 launches a second OS process and verifies queue, events and ledger |
| Duplicate-host prevention | Validated for one storage directory | Competing process fails with `STORE_LOCKED` |
| GitHub Actions | Not a runtime dependency | Used for repository CI and artifact archival only |
| Remote queue / cloud scheduler | Not required | No remote coordinator in the host core |
| Paid API | Not required by host core | Application's configured engines may independently use paid/remote APIs; none are provisioned by the host |
| Dashboard operations | Conditional | Requires an application-owned `phase5HostBootstrap` injection; default dashboard CLI leaves controls disconnected |
| OS service manager | Optional for persistence across machine boot | Linux systemd and Windows SCM/WinSW profiles are generated and were validated in disposable CI labs; installation and identity provisioning remain operator-controlled |
| Distributed / multi-host execution | Not certified | The durable stores are single-process/single-host and intentionally lock concurrent owners |
| Production policy and approvals | Application-owned | Bootstrap validates policy/permission shape and ledger integrity, but does not provide the real approval authority |

## Runtime dependency boundary

The certified host entrypoint is `src/agent/autonomous-execution-host-bootstrap.js`. Its transitive execution graph is composed of repository-local ES modules and Node.js built-ins for filesystem access, paths, cryptography and process/OS metadata. The host core does not import a third-party runtime package or GitHub/Actions client, and does not require an HTTP client, remote queue or cloud control plane.

The full Expert QA product has additional dependencies for other features (for example browser, accessibility, image and parser tooling). Those are not transitively required by the host bootstrap module graph, but the full product may need those packages installed. Engines and adapters selected by the embedding application can also perform network access—for example when auditing remote URLs or using a configured external provider. This certification does not disable or certify those engine-specific integrations.

A compatible Node.js runtime (22 or newer), local storage, an application-supplied trusted orchestrator, a valid policy/permission allowlist and an approval integration appropriate to the application remain required. No paid infrastructure is required by the host core; physical host, power, operating-system and optional network costs are outside that software-cost statement.

## Startup, permissions and service deployment

- Constructing/importing the bootstrap is inert. `enabled: true` is explicit opt-in and `start()` is explicit.
- Preflight checks the trusted engine catalog, policy and permission allowlist, ledger and protected storage before runner start.
- Persistent queue and event journal use exclusive locks; a second process cannot acquire the same stores while the first host owns them.
- POSIX storage ownership and private permissions are verified by the bootstrap. Windows ACLs are not inspected or changed by the bootstrap; operators must provision and verify them.
- The service-profile builders only generate reviewable configuration. They do not install services, create accounts, write service files, change ACLs or elevate privileges.
- Interrupted jobs remain quarantined. Recovery, disposition and retries require explicit operator calls; the host does not replay work automatically.
- A stopped or failed bootstrap instance is terminal. An application supervisor must inspect the failure and construct a new bootstrap when appropriate.

Block 13.4 exercised generated systemd and WinSW v2 profiles through the actual service managers on disposable Ubuntu 24.04 and Windows Server 2022 CI runners. This is platform-lab evidence, not installation on a customer machine.

## Evidence chain

- **Block 13.4 / PR #290:** disposable Linux systemd and Windows SCM/WinSW service-profile execution and cleanup labs.
- **Block 13.5 / PR #291:** inert bootstrap, secure preflight, dual durable locks, readiness/liveness, sanitized diagnostics and manual-only interrupted-job handling.
- **Block 13.6 / PR #292:** application-owned bootstrap injection and same-origin dashboard start/stop controls; 38/38 CI jobs passed.
- **Block 13.7 / PR #293:** local job execution, process-lock contention, graceful shutdown, second-process restart, durable queue/journal continuity and JSONL hash-chain verification with `GITHUB_ACTIONS` and `CI` absent in the host child processes; 54/54 CI jobs passed.
- **Block 13.8:** this transitive-import certification command, Node 22/24 CI execution and retained JSON evidence.

Each workflow artifact is bound to the exact source revision and runner that produced it. A passed CI certificate is evidence for that source revision and test environment; it is not a warranty for a later deployment or an unconfigured production application.

## Final determination

**The JB Expert QA autonomous host core is independent of GitHub Actions for runtime execution on one local host.** GitHub Actions remains a convenient CI and evidence-delivery system, not the process that owns or runs autonomous work.

**The product is not yet “zero-dependency in every sense.”** It needs Node.js, local storage, a trusted application orchestrator and appropriate policy/approval integration. Some QA engines may need network access. Permanent boot-time operation needs an operator-provisioned OS service or an equivalent process supervisor. The default standalone dashboard CLI does not inject a production bootstrap automatically.

Therefore Phase 5's autonomous host architecture and its independence certification are complete within the stated local single-host scope. Production activation is a deployment/integration task for the application that owns the real engine registry, policies, approvals, service identity and storage—not a remaining GitHub Actions runtime dependency.
