# JB Security Guard — Offline recovery testing

## Purpose

This guide is for validating the recovery flow before a real ERP or customer database exists. The tests use synthetic account IDs and destinations only.

## What is simulated

- Email and SMS adapters store outbound test messages in bounded process memory.
- No email/SMS vendor SDK is invoked.
- No network requests are made by the mock adapters.
- No message content is written to disk or printed to logs.
- A random in-process test secret is generated for each test run.
- The real recovery implementation still generates cryptographic tokens/OTPs, stores only their keyed digests, enforces expiry and attempt limits, and validates single-use consumption.

The helper is located at `packages/security-guard/testing/recovery-adapters.js`. It is deliberately not exported by `@jb/security-guard` and is excluded from the package's `files` list, so application code cannot accidentally import it through the package's normal runtime entrypoint.

## Run

~~~bash
npm run test:security-guard
~~~

The focused test command exercises HTTP middleware, login throttling, recovery expiry/replay/rate-limiting, delivery failure handling, mock provider capacity, and the full email/SMS verification path.

## Production work intentionally deferred

No live mail or SMS credentials, real customer contacts, production recovery secret, Redis instance, database password update, or session store is configured here. Those are host-application responsibilities and should be connected only when the ERP integration is ready.

For production:
1. Resolve the account and verified contact server-side.
2. Use a stable secret from a secret manager; never rotate it on every process restart.
3. Inject vetted email/SMS delivery adapters with timeouts and provider-side abuse controls.
4. Implement the recovery store contract with atomic operations shared across all application instances.
5. Hash the new password using Argon2id or another approved password-hashing algorithm.
6. Revoke all existing sessions after a password reset.
7. Add integration tests against a disposable staging database and provider sandbox.

## Bounded in-memory store behavior

The in-memory recovery store no longer evicts live rate-limit buckets to make room for new keys. It first reclaims expired windows; when capacity is still exhausted, previously unseen keys are temporarily rejected until a live bucket expires. Live recovery challenges are also preserved: when the challenge store is full, new delivery is suppressed with the same generic public response rather than evicting a valid challenge.

Unknown/ineligible account requests use stable, channel-specific synthetic rate-limit buckets. This prevents unauthenticated requests from filling the bounded store with a unique account/destination key on every attempt. The store remains process-local and is not a global limiter in a multi-instance deployment.
