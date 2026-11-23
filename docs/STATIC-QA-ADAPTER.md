# JB Expert QA — Static QA Engine Adapter (Phase 4, Block 4)

## Purpose

Block 4 connects the existing canonical local-static auditor to the central engine registry and the Phase 4 orchestrator. It does not duplicate static rules, scanners, language analysis or scoring logic.

The adapter ID is `jb.static-qa-engine`. Its canonical implementation is the existing `createAuditEngineRegistry().run("static", ...)` path backed by `auditProject`.

## Read-only boundary

The adapter runs only local static inspection. It does not execute project code, install dependencies, alter files, upload source to an AI provider or query an external dependency-advisory service. It fails closed if a future underlying configuration reports that external advisory lookups were enabled or performed.

The existing scanner skips symbolic links, ignores common generated/vendor directories, and excludes sensitive files such as environment files, credentials and private-key material. Scan limits can only be lowered or set at or below the existing defaults.

This adapter exposes a compact result rather than the full native report. It includes scoring, scan coverage, dependency-advisory status and at most 25 finding summaries. The full native audit report remains available through the pre-existing audit API.

## Registry use

```js
import {
  createQaEngineRegistry,
  registerStaticQaEngine,
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION
} from "@jb/expert-qa";

const registry = createQaEngineRegistry();
registerStaticQaEngine(registry);
registry.seal();

const actionType = getQaEngineActionType("jb.static-qa-engine");
const orchestrator = createQaEngineOrchestrator({
  registry,
  policy: {
    id: "local-static-qa-v1",
    grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
    rules: [{ type: actionType, maxRisk: "high" }]
  },
  requestApproval: async (request) => hostApprovalService.request(request)
});

const result = await orchestrator.execute({
  id: "project-static-audit",
  actions: [{
    id: "audit-workspace",
    type: actionType,
    input: { path: "./my-project" }
  }]
});
```

The example requires a real host approval service. The adapter is classified as high risk by the current orchestrator until the adapter contract includes separately validated risk metadata. Policy allowlisting, preauthorized `qa:engine-execute` permission and explicit external approval are therefore all required.

## Cancellation note

The adapter rejects a pre-aborted signal before starting the filesystem audit. The current canonical static auditor does not support mid-scan cancellation. Set the host action timeout to an appropriate value. If a timeout occurs, the underlying operation is still read-only; the scanner does not write project files or run project code.

## Verification

```sh
node --test tests/static-qa-adapter.test.js
npm run test:autonomous-execution
npm run test:package-distributions
```
