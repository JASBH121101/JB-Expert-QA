# Phase 6 — Block 6.2: Local Operator Approval

## Purpose

Provide an explicit, local human decision point for actions submitted to the Phase 4 orchestrator. The gate never approves automatically. Approval, denial, timeout, abort, capacity exhaustion and gate shutdown resolve fail-closed.

## Application wiring

Create the local gate in the embedding application and pass it to the Phase 4 host factory as `approvalGate`. Pass the returned host controller to the local Dashboard as `phase5HostBootstrap`.

```js
import { createLocalApprovalGate, createPhase4AutonomousHostBootstrap, startDashboard } from "@jb/expert-qa";

const approvalGate = createLocalApprovalGate({
  timeoutMs: 120_000,
  maxPending: 4
});

const host = createPhase4AutonomousHostBootstrap({
  enabled: true,
  storageDirectory: "/var/lib/jb-expert-qa",
  signalSource: process,
  apiAllowedOrigins: ["https://api.example.test"],
  policy: productionPolicy,
  approvalGate
});

const dashboard = await startDashboard({
  port: 4173,
  phase5HostBootstrap: host
});

// During application shutdown:
await dashboard.close();
approvalGate.close();
```

The application must supply `productionPolicy` explicitly. It must grant only `qa:engine-execute`, allow only intentionally selected engine action types, require approval, and bound execution/input/output/time limits. The API origin allowlist must contain exact HTTP(S) origins. The example storage path must be provisioned by the operator with private ownership and permissions before activation.

## Dashboard contract

The host controller exposes the approval methods only when the local gate is injected. The loopback Dashboard reads:

- `GET /api/phase5/host/approvals`
- `POST /api/phase5/host/approvals/{requestId}/approve`
- `POST /api/phase5/host/approvals/{requestId}/deny`

Decision POST requests require the local Dashboard Origin, no query string and an empty JSON object. Decisions are rate-limited and single-use. The browser cannot provide an approval receipt, modify the policy, change allowed engines, submit arbitrary tasks or bypass execution preflight.

The operator sees the execution/action identifiers, action type, risk, required permission, expiry and a SHA-256 input digest. Raw input, target scope, credentials, payloads and output are not exposed by this approval view. Approving the request permits the orchestrator to continue only when its independent policy checks also pass.

## Failure and lifecycle behavior

- No configured gate means no local approval endpoint and no automatic approval.
- Denial, timeout, abort, a full pending queue or gate shutdown returns an explicit negative decision.
- Approval requests are in-memory and are not a durable approval queue. A process restart does not restore pending operator decisions.
- The gate does not start or stop the autonomous host, install OS services, provision host storage or recover interrupted jobs.
- Keep the Dashboard bound to loopback. Do not expose the approval endpoint through a public reverse proxy.
- An external approval provider can still be supplied through the existing `requestApproval` callback. Do not pass both `approvalGate` and `requestApproval`.

This block completes the local operator-decision integration contract. It does not certify a specific production policy, provision a real host, or activate an OS service.
