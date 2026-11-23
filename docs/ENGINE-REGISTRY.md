# JB Expert QA — Central Engine Registry (Phase 4, Block 1)

## Purpose

The Central Engine Registry defines one explicit discovery contract for trusted QA engine adapters. It complements, rather than replaces, the existing `createAuditEngineRegistry`, which continues to own the seven built-in project/site audit adapters.

The new registry is an index of registered capabilities and trusted runner references. It does not schedule work, execute handlers, load code from disk, import packages dynamically, grant permissions, or communicate with remote services.

## Adapter contract

Each adapter registers a manifest using `jb.qa-engine-adapter/v1`:

- `id`: stable, namespaced engine identifier.
- `name` and `version`: human-readable name and strict MAJOR.MINOR.PATCH version.
- `category`: capability family, such as `audit` or `api`.
- `targetType`: one of `path`, `url`, `path-or-url`, `payload`, or `none`.
- `executionMode`: one of `in-process`, `browser`, `local-process`, or `remote`.
- `capabilities`: unique, bounded capability identifiers.
- `description`: optional bounded description.
- `run`: an explicitly supplied trusted function reference.

Unknown fields, getters/setters, duplicate engine IDs, unsupported execution modes, invalid identifiers, and malformed versions are rejected. Metadata and capability arrays are copied and frozen at registration time. Runner functions are kept separately from public metadata.

## API

```js
import { createQaEngineRegistry } from "@jb/expert-qa/engine-registry";

const registry = createQaEngineRegistry();

registry.register({
  id: "jb.api-testing",
  name: "API Testing Engine",
  version: "0.1.0",
  category: "api",
  targetType: "url",
  executionMode: "in-process",
  capabilities: ["http", "assertions", "contracts", "rate-limit-observation"],
  description: "Bounded API request and response testing",
  run: async (input) => {
    // The API adapter is introduced in Phase 4, Block 2.
    return input;
  }
});

const apiEngines = registry.find({ category: "api" });
const metadata = registry.get("jb.api-testing");
const runner = registry.getRunner("jb.api-testing");

// Complete registration before freezing the registry for the host lifecycle.
registry.seal();
```

`register` accepts only explicit trusted handlers. `list`, `get`, `has`, and `find` discover metadata without running an engine. `getRunner` returns the trusted function reference for a future orchestrator; callers remain responsible for authorization and controlled invocation. `seal` prevents additional registrations after application startup.

## Boundaries

- This registry is not an execution engine or job queue.
- Registration does not imply permission to access a target or resource.
- The registry never executes a handler during registration or discovery.
- No filesystem scanning, dynamic imports, package installation, shell execution, Git operations, network access, or deployment is performed.
- Target validation, execution policy, timeouts, cancellation, resource budgets, retries and durable audit history remain responsibilities of the adapter and subsequent orchestration layers.
- The existing seven-adapter audit registry remains backward compatible and unchanged in this block.

## Verification

Run the focused tests with:

```sh
node --test tests/engine-registry.test.js
```

The complete regression, package distribution, and cross-platform certification workflows remain required before merge.
