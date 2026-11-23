# JB Expert QA — Autonomous Execution Engine

## Purpose and boundary

The Autonomous Execution Engine is a policy-bounded orchestration layer for trusted action handlers supplied by the embedding application. It is separate from the AI-assisted supervised autopilot and does not make model-generated plans executable by itself.

The engine ships with **no registered side-effect handlers**. An embedding application must explicitly register each handler and then allowlist its exact action type in policy. There is no built-in shell executor, arbitrary command runner, source-code patcher, deployment, publishing, database-write or production-mutation action.

The safe default is deny-by-default: an empty registry and empty policy rules authorize no work.

## Execution contract

A plan contains only an optional plan ID and an ordered array of action IDs, registered action types and JSON input. Plans cannot provide risk, permissions, scopes, approval receipts, timeouts or policy overrides.

A registered handler declares:

- an exact action type;
- risk level: `low`, `medium` or `high`;
- zero or more required permission names;
- an execution handler that receives an `AbortSignal`;
- optional input/output validators;
- an optional scope resolver for path-scoped actions;
- an optional per-action timeout.

Policy must explicitly allow the action type and preauthorize every required permission. A scope resolver requires policy scope patterns. Patterns are exact relative paths or directory prefixes such as `reports/**`; absolute paths and traversal segments are rejected. A registered `getScope` resolver must return the exact resource the handler will act on; handlers must independently enforce that same resource and must not use alternate unvalidated target fields.

Medium- and high-risk actions always require an external approval callback. A policy rule may also require approval for a low-risk action. The approval callback receives only action metadata, the scope, and an input digest rather than the raw input. It must return `{ approved: true, approvalId: "..." }`. Approval cannot grant missing permissions or enable an action type excluded by policy.

Input and output validators must explicitly return `true`. Any blocked, failed, cancelled, timed-out or invalid action stops the plan by default. Policy can opt into continuing after a failure, but the overall result is then partial unless every action succeeds.

## Limits and controls

Default policy limits are:

| Limit | Default |
| --- | ---: |
| Actions per plan | 10 |
| Total execution time | 120,000 ms |
| Per-action time | 30,000 ms |
| Approval wait | 30,000 ms |
| JSON input size | 32 KiB |
| JSON output size | 32 KiB |
| Ledger records | 100,000 |

Limits are configurable within implementation bounds. Plans are validated before the first handler runs. The engine checks ledger integrity and reserves enough ledger capacity for the planned events before execution. A single engine instance runs one plan at a time. Actions within a plan are sequential.

Timeout and cancellation signals are passed to both action handlers and approval callbacks. JavaScript cannot forcibly terminate an arbitrary handler function. Every registered handler must honor its AbortSignal and must not continue side effects after cancellation. Register only trusted handlers that enforce their own operation-specific safety constraints.

## Audit ledger

The engine uses an in-memory hash-chained ledger by default. For local persistence, create a JSONL ledger explicitly:

~~~js
import { createJsonlExecutionLedger } from "@jb/expert-qa";

const ledger = await createJsonlExecutionLedger(
  ".jb-expert-qa/executions/actions.jsonl"
);
~~~

Ledger entries include event type, execution/action IDs, policy ID, risk, approval receipt, status, duration, and SHA-256 digests of inputs, outputs and resource scopes. Raw input/output payloads and raw scope paths are not copied into ledger records. A hash chain detects accidental edits, truncation and reordering; it is not an immutable remote store or a defense against an attacker who can rewrite the entire file.

A JSONL ledger is single-writer and has a configurable record cap. Use one engine instance and one process per ledger file; do not share the same JSONL file across concurrently writing processes. Keep its directory protected by OS permissions, do not share one file between concurrent processes, and archive/rotate it deliberately before reaching the cap. Close it after use.

## Example

~~~js
import {
  createAutonomousExecutionEngine,
  createJsonlExecutionLedger
} from "@jb/expert-qa";

const ledger = await createJsonlExecutionLedger(
  ".jb-expert-qa/executions/actions.jsonl"
);

const engine = createAutonomousExecutionEngine({
  actions: [{
    type: "report.write",
    risk: "low",
    permissions: ["reports:write"],
    timeoutMs: 10000,
    getScope: (input) => input.path,
    validateInput: (input) =>
      typeof input.path === "string" && typeof input.content === "string",
    validateOutput: (output) => output.saved === true,
    execute: async ({ input, signal }) => {
      if (signal.aborted) throw new Error("Execution cancelled");
      // The host application owns and implements this trusted handler.
      await writeApprovedReport(input.path, input.content, { signal });
      return { saved: true };
    }
  }],
  policy: {
    id: "local-reports-v1",
    grantedPermissions: ["reports:write"],
    rules: [{
      type: "report.write",
      maxRisk: "low",
      scopes: ["reports/**"]
    }]
  },
  ledger
});

try {
  const result = await engine.execute({
    id: "report-plan-1",
    actions: [{
      id: "write-report-1",
      type: "report.write",
      input: {
        path: "reports/summary.json",
        content: "{\"status\":\"complete\"}"
      }
    }]
  });
  console.log(result.status, result.ledger);
} finally {
  await ledger.close();
}
~~~

The example assumes the embedding application supplies `writeApprovedReport`. JB Expert QA does not implement that side effect for the host.

For medium/high risk handlers, supply `requestApproval` to the engine. Do not build an approval callback that automatically approves every request.

## Test and certify

Run the focused suite:

~~~bash
npm run test:autonomous-execution
~~~

Run the expanded local certification profile (includes the autonomous execution suite):

~~~bash
npm run qa:local:full
~~~

The suite covers allowlisting, permissions, scope enforcement, risk ceilings, approval receipts, input/output validation, sequential failure handling, cancellation, timeouts, replay prevention, single-flight execution, ledger capacity, JSONL persistence and hash-chain tampering.

## Relationship to the supervised autopilot

The existing AI autopilot remains a separate supervised workflow. This engine does not automatically consume AI plans, upload source code, apply patches, create branches, push, open pull requests, merge or deploy. An application may connect a planner to the engine only after converting its output into a constrained plan and applying the same policy and approval gates described here.
