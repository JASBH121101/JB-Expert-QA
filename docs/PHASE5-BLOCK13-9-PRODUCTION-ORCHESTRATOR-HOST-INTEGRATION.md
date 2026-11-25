# Phase 5 — Block 13.9: Phase 4 Orchestrator / Autonomous Host Integration

## Scope

Add a factory that wires the eight built-in Phase 4 adapters into the sealed Central Engine Registry, connects that registry to the policy-bound QA Engine Orchestrator, and injects the orchestrator into the persistent autonomous-host bootstrap. The factory constructs an inert host controller; it never starts the service or invokes adapters.

## Built-in catalog

- API Testing Engine (requires exact HTTP(S) origin allowlist)
- Static QA Engine
- Static Security QA Engine
- Runtime Security QA Engine
- Accessibility QA Engine
- Performance QA Engine
- Visual QA Engine
- Report Certification Engine

## Required application-owned configuration

- `enabled: true` is an explicit opt-in.
- `storageDirectory` is a host-owned absolute private directory.
- `signalSource` is a trusted signal lifecycle source.
- `apiAllowedOrigins` is a non-empty explicit list of exact origins; wildcard, path, credentials and duplicate entries are rejected.
- `policy` defines exact permitted action types, `qa:engine-execute`, and bounded execution limits.
- `requestApproval` must be a real external approval provider. This factory does not auto-approve or supply a production approval UI.

## Start boundary

Importing the factory and constructing the controller are inert. The embedding application must explicitly call `start()` after configuring storage, policy, approval and origins. Preflight validates catalog, policy, storage and ledger before the persistent host starts. `stop()` performs graceful shutdown.

## Integration validation

`npm run test:phase4-autonomous-host` checks strict option gates, catalog sealing, construction inertness and a real local Static QA action through persistent host queue, orchestrator, exact policy, approval fixture, adapter and execution ledger. The test uses temporary directories and fixture approval; it is not a production activation or live service deployment.

## Production boundary

Production still requires the application to provide and independently operate an approval provider, create a policy with intentionally allowed engines, configure the API origin allowlist, provision private host storage and install an OS service if boot-time execution is desired. The factory does not activate any host automatically, use cloud services, require paid APIs, or install/modify host OS services.

## Verification

```sh
npm run test:phase4-autonomous-host
node --test tests/autonomous-execution-host-bootstrap.test.js tests/autonomous-execution-host-operations.test.js tests/engine-orchestrator.test.js
npm run test:package-distributions
```

