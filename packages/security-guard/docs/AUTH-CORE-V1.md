# Authentication Core v1 integration (Node.js)

The Authentication Core v1 bridge is opt-in. Without `coreContract`, `onCoreAttempt`, `onCoreDecision`, or `onCoreEvent`, the existing authentication protector retains its existing enforcement and return behavior.

## Local authentication protector

```js
const auth = guard.createAuthProtection({
  identityKeyGenerator: (request) => request.body?.email,
  clientKeyGenerator: (request) => request.socket?.remoteAddress,
  keySecret: process.env.JB_AUTH_HMAC_SECRET,
  coreContract: {
    tenantId: "tenant-01",
    applicationId: "catalog-api",
    operation: "login",
    accountKeyId: "account-hmac-2026-01",
    clientKeyId: "client-hmac-2026-01"
  },
  onCoreAttempt(attempt) {
    // A validated authentication.attempt/v1, with opaque HMAC subjects.
  },
  onCoreDecision(({ attempt, decision }) => {
    // A validated authentication.decision/v1 paired with its attempt.
  }),
  onCoreEvent(event) {
    // Optional sanitized security-event/v1 sink.
  }
});
```

Use a stable secret with at least 32 bytes when Core mode is enabled. Key IDs identify the secret version; they are not secret material. Rotate the secret and its key ID together under your key-rotation procedure.

## Distributed authentication protector

```js
import { createDistributedAuthProtection } from "@jb/security-guard";

const auth = createDistributedAuthProtection({
  store, // Must implement the existing atomic shared authentication-store contract.
  secret: process.env.JB_AUTH_DISTRIBUTED_SECRET,
  identityKeyGenerator: (request) => request.authenticatedAccountId,
  clientKeyGenerator: (request) => request.socket?.remoteAddress,
  mode: "balanced",
  coreContract: {
    tenantId: "tenant-01",
    applicationId: "catalog-api",
    operation: "login",
    accountKeyId: "account-hmac-2026-01",
    clientKeyId: "client-hmac-2026-01"
  },
  onCoreAttempt(attempt) {},
  onCoreDecision(({ attempt, decision }) => {}),
  onCoreEvent(event) {}
});
```

The distributed protector still requires a real store that atomically implements `recordFailure`, `getStatus`, and `clearFailures`. Core v1 normalizes the contract and telemetry; it does not make a process-local store distributed.

## Contract meaning and privacy

- `recordFailure(request)` emits `authentication.attempt/v1` with `outcome: "failure"`.
- `recordSuccess(request)` emits `outcome: "success"`.
- The paired decision describes the security throttle only. `allow` means the throttle did not block the authentication handler; it does **not** mean that credentials were correct or accepted.
- `monitor` reports a would-be lockout without claiming that the request was denied. `deny` maps to HTTP 429. Store failures map to enforced `unavailable`/503 in distributed middleware.
- Events are emitted when a lockout is first triggered, not for each subsequent rejected request, to avoid flooding telemetry.
- Raw account identifiers, IP addresses, passwords, cookies, session tokens, recovery codes, and request bodies are not included. The Core bridge derives tenant/application-separated HMAC keys from the runtime's existing HMAC identity digests.
- The Core attempt schema requires an account key. When an application resolver cannot provide an account, the bridge uses a tenant/application-separated anonymous-subject HMAC; configure a reliable server-side account resolver whenever possible.

## Recovery protection

`createAccountRecovery()` retains its separate IP/account/destination request limits, per-IP verification limit, one-time challenge store, generic public responses, and provider-failure cleanup. This integration does not change those public responses or replace those quotas. For a recovery endpoint protected by the authentication protector, set `operation: "account_recovery"`; the recovery module's own quota/event bridge is a separate future integration.

## Safety boundaries

- Resolve identities in trusted server-side code; do not trust values supplied directly by the browser.
- Keep HMAC secrets in runtime secret storage and never in contracts, event payloads, logs, or source control.
- The Core events are telemetry, not an authorization source. The application remains responsible for credential verification, MFA, account state, and recovery eligibility.
- Core mode is not a claim of protection against every attack; continue adversarial testing, monitoring, secret rotation, and operational review.
