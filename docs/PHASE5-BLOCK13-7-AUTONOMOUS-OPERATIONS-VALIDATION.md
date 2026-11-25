# Phase 5 — Block 13.7: Autonomous Operations Validation

## Objective

Provide a repeatable, local Node.js validation that proves the autonomous host can execute a durable QA job without relying on GitHub Actions or CI environment variables, enforces single-process ownership of persistent stores, and preserves completed job, event-journal and execution-ledger state across a real operating-system process restart.

## Run locally

Requirements: Node.js 22 or newer. No GitHub CLI, GitHub token, network service, container runtime, paid API or GitHub Actions workflow is required.

From the repository root:

```sh
npm run test:autonomous-host-operations
```

The same test is included in the repository's normal `node --test` regression suite.

## What the operations lab does

The test creates a private temporary storage directory and launches separate Node.js processes with a deliberately minimal environment. The child processes do not receive `GITHUB_ACTIONS`, `CI`, runner metadata or GitHub credentials.

1. **Local execution:** process A constructs the trusted fixture orchestrator, starts the actual bootstrap and local runner, submits one bounded QA job, waits for completion, and verifies persistent queue/journal state and a JSONL hash-chain ledger.
2. **Single-host ownership:** while process A owns its persistent locks, a second independent Node.js process tries to start against the same storage directory. The second process must fail closed with `STORE_LOCKED`; it must not start a second runner.
3. **Graceful shutdown:** process A stops the host, closes the journal and queue stores, and releases both exclusive lock files.
4. **OS-process restart:** process B starts a new bootstrap instance against the same directory. It verifies that the completed job and `EXECUTION_SUCCEEDED` / `JOB_COMPLETED` event records survived the process boundary.
5. **No duplicate execution:** the JSONL execution ledger is reopened and hash-chain verified. Its entry count must remain exactly one after process B starts and polls the durable queue. A completed job must not be replayed.

The lab uses the real durable queue, persistent event journal, host bootstrap, execution runner, worker, lifecycle supervisor and `createJsonlExecutionLedger()`. Only the QA orchestrator is a deterministic, local fixture; this isolates host runtime behavior from any production engine, remote approval system or external service.

## Pass conditions

- Each child process runs with `GITHUB_ACTIONS` and `CI` absent.
- The local host reaches ready/running and completes the test job.
- Queue and event-journal persistence are enabled.
- A competing process is rejected while the first process owns the persistent locks.
- Both lock files are removed after graceful shutdown.
- A fresh OS process reads the completed job and prior operational events.
- The persistent JSONL ledger passes SHA-256 hash-chain verification.
- The ledger remains at one entry; no automatic replay occurs.

The test fails on any unmet condition and returns a non-zero test status.

## Scope and limitations

This is an operational integration proof for the local single-host runtime, not a performance/load test, multi-node deployment test, OS service installation, production engine certification, external human-approval certification, or proof of high availability. A deterministic fixture validates the host contract; production orchestrator policy, approvals, engine adapters, storage identity and service-manager settings must still be supplied and validated by the embedding application.

GitHub Actions may run this test as repository CI, but it does not start or coordinate the child host processes. The test also runs locally through the npm script with no GitHub Actions or CI environment.
