# Phase 5 — Block 13.2: Autonomous Host Service Lifecycle Adapter

## Objective

Provide one explicit lifecycle surface for embedding the durable autonomous execution host in a long-running local service process. The adapter coordinates host start, process-like signal handling and graceful stop without transferring boot, restart or service-installation authority into the library.

## Public API

```js
import {
  createAutonomousExecutionHost,
  createAutonomousExecutionHostService
} from "@jb/expert-qa";

const host = createAutonomousExecutionHost({
  orchestrator,
  storageDirectory: "/var/lib/jb-expert-qa",
  enabled: true
});

const service = createAutonomousExecutionHostService({
  host,
  signalSource: process,
  onError(error, signal) {
    logger.error({ code: error.code, signal }, "host shutdown failed");
  }
});

service.start();
```

The service adapter is also available from `@jb/expert-qa/autonomous-execution-host-service`.

## Lifecycle contract

- Construction is inert: no host start, signal listener, timer or queue claim is initiated by the service adapter.
- `start()` explicitly attaches the selected signal handlers and then calls the host's existing `start()` method.
- If host startup fails, the adapter removes the listeners it installed and leaves the service terminal.
- `SIGINT` and `SIGTERM` requests converge through the existing Host Signal Lifecycle Adapter and the host's idempotent `close()` operation.
- `stop()` detaches adapter-owned listeners, awaits the host's ordered graceful close and is single-flight across repeated calls.
- `getStatus()` exposes the host snapshot and a sanitized service/signal lifecycle summary. Raw exception messages and job payloads are not added to status.
- The host, runner, supervisor, queue and event journal remain the existing execution path. The service adapter does not create another polling loop or scheduler.

## External service manager responsibilities

The operating system's service manager remains responsible for installation, boot startup, process restart policy, service identity, environment provisioning, filesystem permissions, log collection and stop timeout configuration. It must send a supported signal through the supplied signal source when stopping the process.

This adapter does **not** install or register systemd/Windows services, execute shell commands, elevate privileges, change restart policy, call `process.exit()`, or automatically recover interrupted jobs. A process restart does not make interrupted work safe to replay; operator recovery remains explicit.

GitHub Actions remains a repository validation mechanism only. The local host execution path does not poll GitHub Actions, depend on a hosted scheduler or require a paid service.

## Validation

```sh
node --test tests/autonomous-execution-host-service.test.js tests/autonomous-host-signal-lifecycle.test.js tests/autonomous-execution-host.test.js
npm run test:package-distributions
```

Block 13.2 is complete only when lifecycle tests, standalone package-root/subpath imports, Core Validation, Security QA and JB Engines Certification pass on the exact same pull-request head.
