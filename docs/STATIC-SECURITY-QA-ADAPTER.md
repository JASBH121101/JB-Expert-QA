# JB Expert QA — Static Security QA Adapter (Phase 4, Block 5)

## Purpose

Block 5 connects the existing canonical local-static Security Auditor to the central engine registry and Phase 4 orchestrator. It reuses `createAuditEngineRegistry().run("security", { path }, ...)`, which delegates to `auditSecurityProject`. Security rules, source scanning, scoring and dependency-manifest analysis are not duplicated.

The adapter ID is `jb.static-security-qa-engine`.

## Offline and read-only boundary

This adapter forces `onlineAdvisories: false`. It refuses to return a result if the native audit report indicates external advisory requests, database connections, project-code execution or reads of credential contents.

The canonical scanner continues to skip symbolic links and avoid opening environment files and sensitive credential/key files. The adapter never returns raw diagnostic evidence, recommendations or metadata. It returns a bounded summary containing at most 25 finding summaries; this keeps orchestrator output within a predictable budget and reduces accidental exposure of source-derived material.

Scan limits may be lowered but not raised above the canonical limits (2,500 files, 1 MB per file, 20 MB total, depth 20). An incomplete scan remains explicitly incomplete and must not be interpreted as a passed security assessment.

The optional `productionOnly` scope excludes test/fixture paths using the canonical auditor's existing rules. The default is `false` and audits the full supported project scope.

## Registry and orchestrator

```js
import {
  createQaEngineRegistry,
  registerStaticSecurityQaEngine,
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION
} from "@jb/expert-qa";

const registry = createQaEngineRegistry();
registerStaticSecurityQaEngine(registry);
registry.seal();

const actionType = getQaEngineActionType("jb.static-security-qa-engine");
const orchestrator = createQaEngineOrchestrator({
  registry,
  policy: {
    id: "local-static-security-qa-v1",
    grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
    rules: [{ type: actionType, maxRisk: "high" }]
  },
  requestApproval: async (request) => hostApprovalService.request(request)
});

const result = await orchestrator.execute({
  id: "project-security-audit",
  actions: [{
    id: "audit-workspace-security",
    type: actionType,
    input: { path: "./my-project", productionOnly: true }
  }]
});
```

The host must implement a real approval boundary. As the current registry manifest has no validated risk classification, the existing orchestrator treats each engine action as high risk and requires the exact policy allowlist, preauthorized `qa:engine-execute` permission and explicit approval.

## Cancellation note

The adapter rejects a pre-aborted signal before starting the filesystem scan. The canonical static auditor does not support cancellation during a scan; set a host timeout appropriate to the project's size. A timeout does not grant write capability: the underlying auditor remains read-only.

## Verification

```sh
node --test tests/static-security-qa-adapter.test.js
node --test tests/security-qa.test.js
npm run test:package-distributions
```

A clean static report is not proof that an application is secure. Authenticated penetration testing, runtime configuration, external services and deployment controls require separate validation.
