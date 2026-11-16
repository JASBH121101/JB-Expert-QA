# JB Security Guard — Universal Rate Limiting

## Purpose

The universal HTTP API exposes the existing Security Guard distributed rate-limit decision engine to server-side applications hosted on any platform. It is a module of @jb/security-guard, not a separate engine.

An application sends a server-to-server HTTPS request containing its registered client ID, policy, scope, and a stable identity resolved by that application. The service authenticates the application, validates the policy and scope, then calls the existing createDistributedRateLimit().check() decision path.

## Request flow

~~~text
Application server (Cloudflare, VPS, Laravel, Node.js, Python, etc.)
  |
  | HTTPS + per-application bearer credential
  v
JB Security Guard Universal Rate Limit API
  |
  | existing distributed decision engine
  v
Shared atomic store
  |
  v
200 allowed / 429 limit exceeded / 503 store unavailable
~~~

The endpoint is server-to-server only. Never put an API credential in browser JavaScript, mobile app bundles, public HTML, or source control.

## Service deployment contract

The service is a Node.js 22+ HTTP Fetch handler. Deploy it behind HTTPS and an access-controlled reverse proxy. Supply a production store implementing:

~~~js
async function consumeLimit({ key, now, windowMs, maxRequests }) {
  // Atomically increment one fixed-window counter, set its TTL,
  // and return the decision from the same atomic operation.
  return { allowed: true, count: 1, retryAfterMs: windowMs };
}
~~~

The operation must be atomic across every application instance and service replica. Do not implement it as a separate read followed by write. Use a Redis/Valkey atomic script or a database operation with proven concurrency semantics. The repository intentionally does not bundle a Redis, PostgreSQL, or Neon client. The included in-memory store exists only in tests and is not a production backend.

Configure a different credential for each application, and register only the policies and scopes that application is allowed to consume:

~~~js
import { createServer } from "node:http";
import { createUniversalRateLimitService } from "@jb/security-guard/universal-rate-limit-service";
import { sharedAtomicStore } from "./approved-store-adapter.js";

const service = createUniversalRateLimitService({
  store: sharedAtomicStore,
  clients: {
    "jb-perfumeria": {
      secret: process.env.JB_PERFUMERIA_RATE_LIMIT_SECRET,
      policies: {
        publicCatalog: {
          windowMs: 60_000,
          maxRequests: 120,
          scopes: ["catalog-read", "search"]
        },
        account: {
          windowMs: 60_000,
          maxRequests: 10,
          scopes: ["login", "password-reset"]
        }
      }
    }
  },
  storeTimeoutMs: 1500
});

// Bridge your HTTP framework's request/response to the Fetch API handler.
// Enforce proxy, TLS, body-size, and connection-timeout controls at the host.
~~~

The factory returns fetch(request), accepts only POST to /__jb/security-guard/v1/check, and defaults to a 4 KiB bounded JSON body. The host adapter must bridge its HTTP framework to the Fetch Request/Response API and write the returned status, headers, and body to the network response.

## Client request

Send:
- POST /__jb/security-guard/v1/check
- Content-Type: application/json
- X-JB-Client-Id: registered client ID
- Authorization: Bearer per-application secret

~~~json
{
  "identity": "stable-server-resolved-user-or-client-id",
  "scope": "catalog-read",
  "policy": "publicCatalog"
}
~~~

The identity must be resolved by trusted server-side application logic. Never forward an account ID supplied directly by a browser without verifying it against the authenticated session. Use distinct scopes for routes and operations with different resource costs.

Example using PHP/Laravel's HTTP client:

~~~php
$response = Http::withToken(config('services.jb_guard.secret'))
    ->withHeaders(['X-JB-Client-Id' => 'jb-perfumeria'])
    ->post(config('services.jb_guard.url') . '/__jb/security-guard/v1/check', [
        'identity' => (string) $request->user()->getAuthIdentifier(),
        'scope' => 'catalog-read',
        'policy' => 'publicCatalog',
    ]);

if ($response->status() === 429 || $response->status() === 503) {
    abort($response->status(), 'Request temporarily unavailable.');
}
if (!$response->successful()) {
    abort(503, 'Security control unavailable.');
}
~~~

The same HTTP contract works from Node.js, Python, PHP, Java, Go, Cloudflare Workers, Pages Functions, or any server runtime with HTTPS support. A platform-specific client helper can be added later without changing the counter engine or API contract.

## Responses

- 200: allowed.
- 429: limit exceeded; Retry-After contains the remaining wait.
- 503: shared atomic store unavailable or invalid; the endpoint fails closed.
- 400, 401, 404, 405, 413, 415: invalid input, authentication, route, method, size, or media type.

Responses include Cache-Control: no-store and generic error messages. Raw identities, bearer credentials, counter keys, and backend error messages are not returned.

## Operational and security requirements

1. TLS is mandatory. Terminate HTTPS only at a trusted proxy and prevent direct access to the service process.
2. Keep each client secret server-side, unique per application, at least 32 bytes, and rotate it through a controlled deployment.
3. The service authenticates applications, not end users. End-user identity and authorization remain the responsibility of the calling application.
4. Add network-level protection for the API itself (edge/WAF, connection limits, request timeouts, and operational monitoring). The rate-limit API cannot protect its own listener before it receives a request.
5. Use a shared atomic store with TTL, connection limits, command timeouts, capacity alerts, backup/restore policy, and concurrency tests against the real backend.
6. Namespace counters by application and policy. Separate applications do not share quotas unless explicitly designed to do so.
7. Bound client and policy registries. This implementation allows at most 1000 registered clients, 32 policies per client, 32 scopes per policy, and 16 KiB maximum request-body configuration.
8. Never trust X-Forwarded-For or other forwarded identity headers unless the calling application has an explicitly configured trusted-proxy chain.

## Consistency boundaries

This API coordinates counters across unrelated hosting providers only when all applications use the same central service and shared atomic store. Cloudflare Workers Rate Limiting bindings remain a separate, approximate, colo-local implementation. To share one cross-platform quota, Cloudflare applications must call this HTTPS API with server-side credentials rather than rely solely on their local Workers binding.

A central service is a dependency: if it is unreachable, the default is HTTP 503 and the calling application should fail closed on protected routes. High-availability replicas must use the same atomic store and credential/policy configuration. Do not claim globally strict enforcement until concurrency, failover, clock behavior, and real-store atomicity have been verified.

## Verification status

Automated tests use a deterministic in-memory store fixture to verify the API contract and cross-instance behavior. They do not certify a production Redis/Valkey/PostgreSQL adapter, deployment, network perimeter, or global availability. Those remain separate release gates.


## Release boundary

This endpoint is a Node.js server-to-server adapter. It does not deploy itself, provide a Redis/PostgreSQL/Neon driver, or make an in-memory store globally atomic. Supply a production-grade atomic `consumeLimit()` implementation shared by every replica. Keep credentials server-side, expose the endpoint only over HTTPS and restrict network access. Use the service's bounded request size and exact route, and apply upstream network-level controls against credential guessing. Query strings are rejected. The current test store is a deterministic fixture only; no production backend has been certified.
