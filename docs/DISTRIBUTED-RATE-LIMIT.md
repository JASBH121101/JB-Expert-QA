# Distributed rate limiting

## Purpose

`createDistributedRateLimit()` adds an asynchronous request limiter that can share counters across application instances. It is separate from the existing synchronous in-memory limiter, so current integrations are not silently changed.

## Atomic store contract

Supply a store implementing:

~~~js
async function consumeLimit({ key, now, windowMs, maxRequests }) {
  // In one atomic operation: increment the fixed-window counter,
  // set expiry on first use, and return the decision.
  return { allowed: true, count: 1, retryAfterMs: windowMs };
}
~~~

The operation MUST be atomic across every worker and application instance. A read-then-write implementation is unsafe because concurrent requests can all observe the same old count and bypass the threshold. The adapter must set an expiry/TTL, validate inputs, bound key length and storage growth, and never log raw keys.

Guard supplies an HMAC-derived key. The HMAC secret must contain at least 32 bytes and be identical across all instances. Load it from a secret manager; do not commit it or rotate it on each restart. Use a dedicated namespace per application and environment.

## Example

~~~js
import { createSecurityGuard } from "@jb/security-guard";

const guard = createSecurityGuard({
  mode: "balanced",
  rateLimit: { enabled: false }
});

const distributedLimit = guard.createDistributedRateLimit({
  store: sharedAtomicStore,
  secret: process.env.JB_GUARD_RATE_LIMIT_SECRET,
  namespace: "jb-guard:erp:production",
  windowMs: 60_000,
  maxRequests: 120,
  keyGenerator: (req) => req.socket?.remoteAddress ?? "unknown"
});

// Register early, before expensive parsers and application routes.
app.use(distributedLimit.middleware);
app.use(guard.securityHeaders);
app.use(guard.middleware);
~~~

Disable the built-in local limiter when using this middleware to avoid two independent limits. The middleware is asynchronous and compatible with Express-style `(req, res, next)` handlers. Adapter errors are caught internally.

## Failure behavior

The default is fail-closed: if the shared store is unavailable, malformed, or returns an invalid result, Guard responds with a generic HTTP 503 and does not invoke the protected route. This preserves the security boundary but reduces availability. `failClosed: false` is an explicit availability-over-security choice and should only be enabled after a threat-model review.

Denied requests receive HTTP 429, `Retry-After`, and `Cache-Control: no-store`. Events omit client identifiers, raw keys, request paths, and backend error messages. If the adapter returns a counter, Guard emits a threshold event only when the counter first crosses the configured limit to avoid log floods.

## What this does not provide yet

- It does not ship a Redis, PostgreSQL, Neon, or other network client.
- It does not make the existing synchronous authentication-failure tracker distributed.
- It does not replace edge/WAF limits or DDoS mitigation.
- It does not prove an adapter is atomic; the adapter must be independently reviewed and tested under concurrency.
- The included in-memory test adapter is only a deterministic test fixture, not a production shared store.

Before production, implement and test a concrete adapter (for example, a Redis atomic script or a database transaction/upsert with appropriate locking), run concurrency tests against the actual service, define TTL and outage behavior, and monitor store capacity and latency.
