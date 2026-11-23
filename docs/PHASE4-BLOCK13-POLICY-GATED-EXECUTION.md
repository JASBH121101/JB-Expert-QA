# Phase 4 Block 13 — Policy-Gated Dashboard Engine Execution

## Purpose

Connect the local Control Center to the existing Phase 4 engine registry and the existing policy-bounded Engine Orchestrator. This block does not create a second execution runtime, a browser-supplied policy, an automatic approval path or a privileged runner endpoint.

## Host configuration

The host must explicitly create and seal the engine registry, define the policy allowlist and supply a real approval callback. The browser cannot provide or change any of those values.

```js
import {
  createDashboardPhase4Catalog,
  createDashboardPhase4Execution,
  startDashboard,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION
} from "@jb/expert-qa";

const phase4Registry = createDashboardPhase4Catalog();

const phase4Execution = createDashboardPhase4Execution({
  registry: phase4Registry,
  policy: {
    id: "local-control-center-visual-qa-v1",
    grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
    rules: [{
      type: getQaEngineActionType("jb.visual-qa-engine"),
      maxRisk: "high",
      requireApproval: true
    }],
    limits: {
      maxActions: 1,
      maxExecutionMs: 120000,
      maxActionMs: 30000,
      approvalTimeoutMs: 30000,
      maxInputBytes: 16384,
      maxOutputBytes: 32768
    }
  },
  requestApproval: async (request) => {
    // Connect to a real human/host approval system.
    // Review actionType, risk, permissions, scope, inputDigest and reviewContext.
    // Never auto-approve every request.
    return await hostApprovalService.request(request);
  }
});

const dashboard = await startDashboard({
  port: 4173,
  phase4Registry,
  phase4Execution
});
```

The example assumes that the embedding host provides `hostApprovalService`. No external approval service or auto-approval implementation is supplied by JB Expert QA. A missing provider prevents bridge construction. A provider that denies or times out prevents engine invocation.\n\nThe default catalog keeps API Testing network access inert with the non-routable placeholder origin `https://catalog.invalid`. A host that explicitly enables the API Testing Engine must pass its exact approved origins, for example `createDashboardPhase4Catalog({ apiAllowedOrigins: ["https://api.example.test"] })`. Do not use broad origin patterns or origins the host does not control.

## Policy contract

- The registry must be sealed before creating the execution bridge.
- The policy must have a valid explicit ID.
- `qa:engine-execute` must be explicitly preauthorized.
- At least one exact action type from the sealed registry must be listed.
- Every enabled engine rule must explicitly set `maxRisk: "high"` and `requireApproval: true`.
- Rules are exact IDs only; wildcards and browser-supplied rules are not supported.
- The host may enable a subset of engines; unlisted engines are rejected before approval.
- The bridge enforces one action per dashboard request.
- Dashboard-specific limits are capped at 120 seconds total, 30 seconds per action, 30 seconds for approval, 16 KiB input and 32 KiB output.
- The action type, action ID, plan ID, permissions and risk are created server-side. The browser submits only an engine ID and a JSON object input.

All Phase 4 adapters remain high-risk under the current orchestrator contract. The existing orchestrator validates policy, permission and an external approval receipt before calling the trusted runner. The approval callback receives an input digest rather than raw engine input. The Dashboard bridge also supplies a separate `reviewContext` containing only allowlisted, sanitized metadata: engine ID, input field names, operation/format labels, a URL origin and path without query strings, or a local path basename plus SHA-256 prefix. It never copies raw input values, query strings or local absolute paths into this review context.

## Dashboard routes

- `GET /api/phase4/engines`: read-only engine catalog plus whether execution is configured.
- `GET /api/phase4/execution`: safe policy status and allowed engine IDs; never exposes policy mutation controls or approval receipts.
- `POST /api/phase4/execute`: accepts exactly `{ engineId, input }`. The host-side bridge chooses the action type and creates IDs. The endpoint is same-origin only, rate-limited, single-flight and disabled by default.

The Control Center adds a JSON input panel. It lists only policy-allowlisted engines when the host has enabled execution. The browser cannot set permissions, risk, action types, approval IDs, scopes or policy rules.

## Audit and data handling

The Autonomous Execution Engine maintains its hash-chained execution ledger, recording event metadata and payload digests rather than raw action inputs or outputs. The Dashboard does not persist the raw execution input or output to its legacy audit history. The immediate response contains the bounded action result for the local user. Ledger integrity is checked and returned with the result.

Execution requests are serialized with other dashboard audit work. The dashboard uses a separate five-request-per-minute execution rate limit and the existing loopback host/origin checks.

## Fail-closed behavior

- Default Dashboard configuration has no Phase 4 execution bridge; POST returns HTTP 503.
- Invalid policy, missing permission, an unsealed registry, missing approval provider, mismatched registry, unknown engine or unapproved request cannot invoke a runner.
- The browser cannot pass a policy or approval receipt in the execution body.
- The host approval callback is the human/host trust boundary. It must not return approval without a real authorization decision.

## Verification

```bash
node --test tests/dashboard.test.js tests/engine-orchestrator.test.js
node scripts/build-expert-qa-package.js
node --test packages/expert-qa/package-tests/complete-engine.spec.js packages/expert-qa/package-tests/browser-audit.spec.js
```
