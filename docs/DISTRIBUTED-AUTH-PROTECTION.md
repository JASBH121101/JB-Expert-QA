# Distributed authentication protection

`createDistributedAuthProtection()` is an asynchronous alternative to the existing process-local `createAuthProtection()`. It preserves the existing account, account+client and client-wide policy model while delegating counters and lockout state to a shared atomic store.

## Required store contract

The store must implement three methods:

- `recordFailure({ key, scope, now, windowMs, resetAfterMs, maxFailures, lockoutMs, maxLockoutMs })`: atomically increment one scope, reset expired windows, apply progressive lockout and return `{ blocked, retryAfterMs, triggered }`.
- `getStatus({ keys, now, resetAfterMs })`: read all requested scopes consistently enough for enforcement and return `{ blocked, retryAfterMs, scopes }`.
- `clearFailures({ keys, now, resetAfterMs })`: atomically clear account and account+client scopes after successful authentication. Never clear the client-wide bucket on login success.

All keys are HMAC digests. The secret must be at least 32 bytes, stable across workers and stored in a secret manager. The adapter must use atomic database operations/transactions or Redis scripts, TTL/expiry, bounded key sizes and strict input validation. Never implement counters as a separate read followed by write.

## Example

~~~js
const authGuard = guard.createDistributedAuthProtection({
  store: sharedAtomicAuthStore,
  secret: process.env.JB_GUARD_AUTH_SECRET,
  namespace: "jb-guard:erp:production",
  identityKeyGenerator: (req) => req.authAccountId,
  mode: "balanced"
});

app.post("/login", authGuard.middleware, loginHandler);
~~~

After credential verification, call `await authGuard.recordFailure(req)` only for a genuine failed attempt. After successful verification call `await authGuard.recordSuccess(req)`. The identity resolver must return an opaque, server-resolved account ID; never trust an account ID supplied only by the request body. Do not call `recordFailure` for malformed requests, unavailable identity providers or internal errors.

This API is asynchronous; callers must await `recordFailure` and `recordSuccess`. If recording a failed attempt errors, the login handler must fail closed and must not proceed with authentication. Middleware fails closed with HTTP 503 if the store cannot be read, the injected clock is invalid, or both server-resolved identity functions fail to produce a usable account/client key. At least one trustworthy identity is required; if account resolution fails, the client IP bucket remains active. A failed `recordFailure` call may have partially committed independent scope counters if the backend fails mid-operation; the host application must fail closed and the adapter should make per-scope writes atomic and observable. Do not blindly retry a failed recording operation. Keep the existing synchronous module if the host framework cannot safely await the new API.

## Limitations

No Redis, SQL, Neon or external service client is included. The test adapter is process-local and is not suitable for production. Store atomicity, consistency, TTL and outage handling must be tested against the selected backend before production. This does not replace MFA, secure password hashing, session revocation, account recovery, edge rate limiting or authorization checks.
