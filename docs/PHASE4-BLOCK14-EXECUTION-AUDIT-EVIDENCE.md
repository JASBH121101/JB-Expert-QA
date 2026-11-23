# Phase 4 Block 14 — Execution Audit & Evidence

## Purpose

Provide a bounded, read-only view of the autonomous execution ledger integrated in Block 13. The evidence view supports traceability of policy decisions, external approval outcomes, action lifecycle events and result integrity without adding another execution path.

## Data exposed

The dashboard exposes a strict projection of ledger metadata:
- Sequence, timestamp, event name, execution/plan/action identifiers and policy ID.
- Action risk, lifecycle status, safe bounded reason text and duration/count metadata.
- SHA-256 digests for input, output and scope, when present.
- Each record's hash and previous-hash link, plus the ledger's verification result.
- Approval lifecycle events (requested, approved, denied or timed out) without exposing the host approval receipt or approval ID.

Raw action inputs, raw outputs, approval IDs/receipts, request query strings, credentials and arbitrary ledger properties are not returned. The projection uses an allowlist rather than serializing source records.

## API and pagination

The local Control Center exposes `GET /api/phase4/audit`.
- `limit` defaults to 50 and is restricted to 1–100.
- `before` is an optional sequence cursor; the next page contains records with lower sequence numbers.
- The endpoint returns the chain integrity status and total entry count separately from the selected page.
- Duplicate, malformed or out-of-range pagination parameters are rejected with HTTP 400.
- When Phase 4 execution is not configured, the endpoint returns an explicit disabled state with an empty record list.

The host-side execution bridge exposes the same projection through `getAuditTrail({ limit, beforeSequence })`. It reads the orchestrator's existing ledger snapshot and verification result; it cannot append, mutate, approve or execute.

## Control Center

A new **Execution Audit & Evidence** panel displays the redacted JSON evidence and the chain status. It is view-only and refreshes explicitly. The UI writes API output using `textContent`; it does not interpret ledger text as HTML.

## Security boundaries

- No endpoint accepts an execution request, policy override or approval receipt through the audit route.
- The endpoint never serializes raw ledger records.
- Approval IDs are intentionally omitted; event names communicate approval lifecycle outcomes.
- Hash-chain verification is reported even when invalid so tampering is visible; records remain redacted and explicitly marked untrusted by the integrity state.
- Hash chaining detects modifications, truncation and reordering, but does not replace operating-system access controls or a remote immutable audit store.
- The existing Phase 4 execution default remains disabled and still requires the host's explicit policy and real external approval provider.

## Verification

```bash
node --test tests/dashboard.test.js tests/engine-orchestrator.test.js
node scripts/build-expert-qa-package.js
node --test packages/expert-qa/package-tests/complete-engine.spec.js packages/expert-qa/package-tests/browser-audit.spec.js
```
