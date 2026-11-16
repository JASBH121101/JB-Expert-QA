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
  onCoreDecision: ({ attempt, decision }) => {
    // A validated authentication.decision/v1 paired with its attempt.
  },
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
  onCoreDecision: ({ attempt, decision }) => {},
  onCoreEvent(event) {}
});
```

The distributed protector still requires a real store that atomically implements `recordFailure`, `getStatus`, and `clearFailures`. Core v1 normalizes the contract and telemetry; it does not make a process-local store distributed.

## Contract meaning and privacy

- `recordFailure(request)` emits `authentication.attempt/v1` with `outcome: "failure"`.
- `recordSuccess(request)` emits `outcome: "success"`.
- The paired decision describes the security throttle only. `allow` means the throttle did not block the authentication handler; it does **not** mean that credentials were correct or accepted.
- `monitor` reports a would-be lockout without claiming that the request was denied. `deny` maps to HTTP 429. Store failures map to enforced `unavailable`/503 in distributed middleware.
- Core v1 limits `retryAfterSeconds` to 3600, so longer configured lockouts are capped in Core telemetry; the existing middleware response retains its runtime retry interval.
- Events are emitted when a lockout is first triggered, not for each subsequent rejected request, to avoid flooding telemetry.
- Raw account identifiers, IP addresses, passwords, cookies, session tokens, recovery codes, and request bodies are not included. The Core bridge derives tenant/application-separated HMAC keys from the runtime's existing HMAC identity digests.
- The Core attempt schema requires an account key. When an application resolver cannot provide an account, the bridge uses a tenant/application-separated anonymous-subject HMAC; configure a reliable server-side account resolver whenever possible.

## Recovery module integration

The recovery module has an independent, opt-in Core v1 bridge. It is enabled with `coreContract` and uses the recovery module's existing stable `secret` to derive tenant/application-scoped HMAC identities:

```js
const recovery = guard.createAccountRecovery({
  secret: process.env.JB_RECOVERY_HMAC_SECRET,
  coreContract: {
    tenantId: "tenant-01",
    applicationId: "catalog-api",
    accountKeyId: "recovery-account-hmac-2026-01",
    clientKeyId: "recovery-client-hmac-2026-01"
  },
  onCoreAttempt(attempt) {},
  onCoreDecision: ({ attempt, decision }) => {},
  onCoreEvent(event) {}
});
```

The operation is fixed to `account_recovery`; supplying another operation is rejected. Without `coreContract`, all Core callbacks remain inactive and the existing recovery behavior is preserved.

- `requestRecovery()` deliberately does **not** emit a successful authentication attempt when it returns `{ accepted: true }`. That response is generic and also covers unknown/unverified accounts, rate-limited requests, missing providers, and challenge-store capacity suppression.
- Core recovery events report rate limiting, generic suppression, challenge delivery success, provider delivery failure, challenge-store capacity, and dependency outages. Provider success is reported only after the provider promise resolves. Provider errors and raw delivery destinations are never included.
- `verifyRecovery()` emits an authentication attempt with operation `account_recovery` only after the verification outcome is known. Invalid, expired, locked, and missing-or-consumed challenges have distinct sanitized event rules. A missing challenge is intentionally described as missing-or-consumed; the module cannot safely infer replay versus an unknown identifier.
- The paired authentication decision describes the **per-IP verification throttle only**. `allow` means the attempt passed that throttle; it does not mean the OTP was valid. A throttled attempt yields enforced HTTP 429 in Core telemetry, while the module's public response remains `{ valid: false }`.
- Storage outages emit a sanitized `recovery` event with outcome `unavailable`, while preserving the module's existing thrown-error behavior. Telemetry callback errors never change recovery outcomes.
- Raw account IDs, destinations, IP addresses, OTPs, recovery tokens, provider errors, and request bodies are excluded. Subject correlation uses tenant/application-separated HMACs.

The existing IP/account/destination request limits, per-IP verification limit, one-time challenge consumption, generic public responses, and provider-failure cleanup remain in force. As before, production multi-instance deployments must inject a store whose challenge and limit operations are atomic across instances; the in-memory store is process-local only.

## Safety boundaries

- Resolve identities in trusted server-side code; do not trust values supplied directly by the browser.
- Keep HMAC secrets in runtime secret storage and never in contracts, event payloads, logs, or source control.
- The Core events are telemetry, not an authorization source. The application remains responsible for credential verification, MFA, account state, and recovery eligibility.
- Core mode is not a claim of protection against every attack; continue adversarial testing, monitoring, secret rotation, and operational review.
