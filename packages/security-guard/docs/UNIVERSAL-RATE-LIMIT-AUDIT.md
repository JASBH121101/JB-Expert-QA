# JB Security Guard — Universal Rate Limit audit

Date: 2026-11-16
Base: `main` at `1265daca22d1f9b03ffec6b38d4dd65af3c7d5d2`
Audit branch: `feature/security-guard-universal-rate-limit-audit`

## Executive conclusion

Do not create a second security engine or a second independent rate limiter. Security Guard already contains several complementary rate-limit implementations. The next change should consolidate their contracts and provide portable integration points while preserving runtime-specific adapters.

This audit is source-level. It does not claim live multi-region consistency, production deployment, penetration testing, or provider-side atomicity beyond the contracts explicitly required from adapters.

## Existing components

| Component | Current role | Runtime / state |
|---|---|---|
| Main `createSecurityGuard()` limiter | General request throttling and findings | Node/Express-compatible; bounded in-memory, process-local |
| `createDistributedRateLimit()` | Shared fixed-window throttling | Node middleware; requires injected atomic `store.consumeLimit()` |
| `createDistributedAuthProtection()` | Distributed authentication-failure protection | Separate auth-specific store/contract |
| Account recovery throttles | Request, destination/account, and verification limits | Recovery store; default memory store is process-local |
| `createCloudflareWorkerRateLimit()` | Worker-native Cloudflare binding adapter | Workers Rate Limiting binding; approximate/location-local counters |
| `createCloudflareWorkerRateLimitService()` | Bounded HTTP endpoint for Pages Service Binding | Worker runtime |
| `createCloudflarePagesRateLimit()` | Pages-side Service Binding client | Pages Functions runtime |

## Duplication and gaps found

1. **Multiple policy surfaces:** the main middleware, distributed middleware, auth protection, account recovery, and Cloudflare adapter each expose their own configuration and decision semantics. They are related but not interchangeable; authentication and recovery require their own identity scopes and anti-enumeration behavior.
2. **No portable cross-runtime core contract:** `distributed-rate-limit.js` imports `node:crypto` and implements Node middleware. It cannot be imported unchanged by Workers, PHP, Python, or other runtimes.
3. **Cloudflare-specific approximation:** the Workers adapter uses Cloudflare Rate Limiting bindings. The repository documentation correctly states that these counters are approximate and local to Cloudflare locations; they are not a strict global counter.
4. **Identity hashing differs:** the Node distributed adapter uses keyed HMAC-SHA256 with a stable secret. The Worker adapter currently uses unkeyed SHA-256. That avoids sending raw identifiers to the binding, but low-entropy identifiers can be guessed offline if the digest is exposed. A portable keyed derivation contract should be considered without leaking secrets to clients.
5. **Store contract is narrow:** the distributed adapter expects an atomic fixed-window `consumeLimit({ key, now, windowMs, maxRequests })`. This is a good starting point, but there is no documented cross-language HTTP protocol/SDK contract for applications hosted outside Node or Cloudflare.
6. **No built-in production shared-store implementation is established by these files:** an injected store and in-memory test fixture prove the adapter contract, not that Redis/Valkey/Postgres or another backend is configured, atomic, durable, or deployed.
7. **Different failure modes:** Node distributed middleware uses `failClosed`; Worker policies use `failureMode`; Pages has its own service-failure behavior. These need consistent documented semantics, not a blind rename that breaks compatibility.
8. **Operational visibility is local:** request counters/stats are instance-local. There is no central policy administration, tenant/application registry, global audit pipeline, or cross-runtime observability contract established by the audited components.

## Reuse plan — no duplicate engine

Keep JB Security Guard as the sole owner of runtime security policy. Evolve the existing Rate Limit subsystem in place:

- Preserve existing public exports and behavior for backward compatibility.
- Define a runtime-neutral decision and policy contract: application/tenant, policy, identity type, scope, window, maximum, mode, and failure behavior.
- Keep adapters thin: Node middleware, Cloudflare Worker/Pages, and future PHP/Python clients should translate their request context to the same contract.
- Keep the atomic shared-store interface as the enforcement authority for strict shared quotas. Add a provider adapter only after its atomicity and TTL semantics are tested.
- Keep Cloudflare's native binding as an optional low-latency approximate adapter, clearly labelled as such.
- Do not make authentication/recovery share anonymous request buckets. They may consume the common policy engine but must preserve separate scopes, privacy, generic responses, and account-denial-of-service protections.
- Derive opaque keys with a keyed secret where the runtime supports it; never accept an identity asserted directly by an untrusted browser field.
- Provide a documented HTTP API for non-Node deployments, authenticated with per-application credentials, request authentication/replay protection, bounded payloads, timeouts, and explicit fail-open/fail-closed behavior.
- Avoid a single global hot key. Partition counters by tenant/application, policy, scope, and identity; measure contention and latency.

## Required laboratory gates

1. Existing Security Guard, auth, recovery, Worker and Pages suites remain green.
2. Cross-instance concurrency tests prove atomic enforcement against a shared test store.
3. Identity rotation, namespace/application isolation, policy isolation, expiry boundaries, and clock edge cases are covered.
4. Store timeout, outage, malformed response, and cancellation behavior are tested for both failure modes.
5. Cross-runtime contract tests use the same test vectors and expected decisions.
6. HTTP API tests cover authentication failure, replay, oversized body, malformed JSON, tenant isolation, and rate-limit exhaustion.
7. Load tests measure throughput, p95/p99 latency, contention, memory bounds, and behavior during backend outage.
8. Package distribution smoke tests verify every public adapter/export.
9. No production bindings, DNS, WAF, Workers, paid resources, or deployment settings are changed without explicit approval.

## Scope boundary

This branch is an audit/laboratory branch. Do not merge it into `main` until implementation, regression, security, package-distribution, and load-test gates pass. Do not claim a universal global limit until the selected shared backend provides atomic coordination across all participating deployments.
