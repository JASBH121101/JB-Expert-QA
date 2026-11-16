# JB Security Guard rate-limit contract

## Shared JavaScript contract

The Worker and Pages adapters use the same runtime-neutral JavaScript contract from:

```js
import {
  normalizeRateLimitCheckInput,
  normalizeRateLimitServiceDecision
} from "@jb/security-guard/rate-limit-contract";
```

The request shape is `{ identity, scope?, policy? }`. Identity must be resolved by trusted server-side application code; browser-supplied IDs, cookies, passwords, tokens, and request-body fields are not trusted identities. Scope and policy are 1-96 characters from `[A-Za-z0-9:_-]`; identity is a non-empty string up to 512 characters and is trimmed before use.

The service decision shape is:

```json
{
  "allowed": false,
  "exceeded": true,
  "enforced": true,
  "unavailable": false,
  "policy": "auth",
  "scope": "login",
  "status": 429,
  "retryAfterSeconds": 10
}
```

Allowed decisions have `status: null` and `retryAfterSeconds: null`. A blocked limit decision uses HTTP 429 and must set `exceeded` and `enforced` to true. A blocked backend-unavailable decision uses HTTP 503 and must set `unavailable` and `enforced` to true. Retry values, when present, are integers from 1 through 60.

## Runtime boundary

This package currently provides executable JavaScript contract helpers and adapters for Node.js, Cloudflare Workers, and Cloudflare Pages. The wire shape is language-neutral, but no public authenticated HTTP endpoint or PHP/Python SDK is provided by this change. The Worker service endpoint remains intended for a private Pages Service Binding; do not expose it publicly.

A future non-JavaScript integration requires an authenticated service protocol with per-application credentials, request signing/replay protection, tenant isolation, bounded request parsing, timeouts, and explicit fail-open/fail-closed behavior. Do not send raw identity values through a public endpoint.

## Identity-key protection

Cloudflare Worker enforce-mode policies require `identitySecret` (at least 32 bytes). The adapter derives a keyed HMAC-SHA-256 digest over application namespace, policy, scope, and trusted identity before passing the opaque key to the Cloudflare binding. Keep the secret stable across participating Worker instances and outside source control. Rotating it creates a new counter keyspace.

Monitor-mode compatibility may continue using an unkeyed SHA-256 digest when no secret is configured; that mode does not provide protection against offline guessing of low-entropy identity values if a digest is exposed. Do not use that legacy fallback for enforcement.
