# JB Expert QA — Engine Orchestrator (Phase 4, Block 3)

## Purpose

The Engine Orchestrator connects the sealed Central Engine Registry to the existing Autonomous Execution Engine. It does not introduce a second execution runtime, job queue, scheduler or implicit plugin loader.

Each registered engine receives a stable action type:

`qa.engine.<engine-id>`

For example, `jb.api-testing-engine` maps to `qa.engine.jb.api-testing-engine`. The plan selects an action type; it cannot supply a runner, risk level, permission, policy rule, approval receipt or timeout.

## Fail-closed construction

Create and populate the registry with trusted adapters, then seal it before creating the orchestrator:

```js
import {
  createQaEngineRegistry,
  registerApiTestingEngine,
  createQaEngineOrchestrator,
  getQaEngineActionType
} from "@jb/expert-qa";

const registry = createQaEngineRegistry();
registerApiTestingEngine(registry, {
  allowedOrigins: ["https://api.example.test"]
});
registry.seal();

const apiAction = getQaEngineActionType("jb.api-testing-engine");
const orchestrator = createQaEngineOrchestrator({
  registry,
  policy: {
    id: "host-api-qa-v1",
    grantedPermissions: ["qa:engine-execute"],
    rules: [{ type: apiAction, maxRisk: "high" }]
  },
  requestApproval: async (request) => {
    // Connect this callback to a real human/host approval boundary.
    // Never auto-approve every request.
    return await hostApprovalService.request(request);
  }
});

const result = await orchestrator.execute({
  id: "health-check",
  actions: [{
    id: "api-health",
    type: apiAction,
    input: {
      operation: "request",
      request: { method: "GET", url: "https://api.example.test/health" }
    }
  }]
});
```

The example requires the host application to implement `hostApprovalService`. JB Expert QA does not provide or simulate a human approval UI.

## Authorization model

Every engine action is classified as **high risk** in this first orchestrator contract because the current registry manifest does not carry a validated risk classification. Each invocation therefore requires all of the following:

1. The registry was explicitly populated and sealed.
2. The host policy allowlists the exact `qa.engine.<engine-id>` action.
3. The policy preauthorizes `qa:engine-execute`.
4. The host supplies an approval provider and returns `{ approved: true, approvalId: "..." }`.

A missing policy rule, permission, approval provider, approval receipt or valid engine runner blocks execution. Approval never grants a missing permission or adds an action to policy. The orchestrator passes the execution AbortSignal to the registered adapter runner.

## Audit and boundaries

The existing autonomous execution engine provides sequential execution, input/output JSON bounds, deadlines, cancellation, single-flight protection and a hash-chained audit ledger. Ledger entries contain digests rather than raw input/output payloads.

The orchestrator does not load code from disk, dynamically import packages, grant permissions, discover engines, install dependencies, execute shell commands, mutate Git, push branches, merge pull requests, deploy, or modify production data. Adapter-specific controls remain mandatory; for example, API requests continue to require a configured origin allowlist and active rate-limit testing remains explicitly opt-in.

## Verification

```sh
node --test tests/engine-orchestrator.test.js
npm run test:autonomous-execution
npm run test:api-testing
npm run test:package-distributions
```

The orchestrator is a host integration point, not a blanket authorization to execute every registered engine. Keep policy and approval decisions in the embedding application.
