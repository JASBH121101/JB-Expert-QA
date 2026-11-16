# Security Guard Core v1 runtime integration

The Core v1 runtime bridge is opt-in. Existing Node, Workers, and Pages calls keep their legacy behavior when the new options are not supplied.

## Node.js distributed limiter

Pass a server-owned `coreContract` to `createDistributedRateLimit`. The identity type, tenant, application, policy, scope, and HMAC key ID are configuration—not request fields.

```js
import { createDistributedRateLimit } from "@jb/security-guard";

const limiter = createDistributedRateLimit({
  store,
  secret: process.env.SECURITY_GUARD_STORE_SECRET,
  keyGenerator: (request) => request.authenticatedAccountId,
  windowMs: 60_000,
  maxRequests: 20,
  coreContract: {
    tenantId: "tenant-01",
    applicationId: "catalog-api",
    policyId: "account-api-requests",
    scope: "authenticated-api",
    identityType: "account",
    identityKeyId: "identity-hmac-2026-01"
  },
  onCoreDecision({ check, decision }) {
    // Forward validated, privacy-bounded contracts to your telemetry adapter.
  },
  onCoreEvent(event) {
    // Optional normalized security event sink.
  }
});
```

Core v1 decision contracts currently cap `retryAfterSeconds` at 60, so Node Core mode requires `windowMs <= 60_000`. The existing Node limiter may still be used without Core mode for longer windows.

## Cloudflare Pages → private Worker

Pages Core mode derives an HMAC-SHA-256 identity key before constructing the Service Binding request. The private Worker receives the Core v1 check envelope; the raw account/IP identity is not transmitted to the Worker.

```js
import { createCloudflarePagesRateLimit } from "@jb/security-guard/cloudflare-pages-rate-limit";

const pagesLimiter = createCloudflarePagesRateLimit({
  serviceBinding: env.SECURITY_GUARD_SERVICE,
  failureMode: "closed",
  core: {
    tenantId: "tenant-01",
    applicationId: "catalog-site",
    identityType: "account",
    identityKeyId: "pages-identity-hmac-2026-01",
    identitySecret: env.PAGES_IDENTITY_HMAC_SECRET
  },
  onCoreEvent(event) {
    // Optional normalized security event sink.
  }
});

const decision = await pagesLimiter.check({
  identity: authenticatedAccountId, // Resolve on the server; never trust browser input.
  policy: "login",
  scope: "login-attempt"
});

if (decision.response) return decision.response;
```

Configure the private Worker service with the existing rate-limit adapter and the same policy name used by Pages:

```js
import {
  createCloudflareWorkerRateLimit,
  createCloudflareWorkerRateLimitService
} from "@jb/security-guard/cloudflare-worker-rate-limit";

const limiter = createCloudflareWorkerRateLimit({
  policies: {
    login: {
      binding: env.LOGIN_RATE_LIMIT,
      mode: "enforce",
      periodSeconds: 60,
      failureMode: "closed"
    }
  },
  identitySecret: env.WORKER_RATE_LIMIT_SECRET
});

export default createCloudflareWorkerRateLimitService({ limiter });
```

The Pages HMAC key and Worker binding-key secret serve different stages and may be rotated independently. Keep each secret in its runtime's secret store; never put secret material in a request, policy, event, source file, or callback payload. Update the corresponding key ID when rotating the Pages identity HMAC key.

The returned `decision.core` contains the validated Core check, decision, and optional event. The service validates the incoming check and returns a decision bound to the same request, tenant, application, policy, and scope. Pages rejects mismatched decisions/events and applies its configured failure mode.

## Operational boundaries

- Resolve account and client identities in trusted server-side code. A Core validator cannot make a browser-supplied identity trustworthy.
- The `identityKeyId` identifies the Pages/Node HMAC key version; never transmit the HMAC secret.
- Use distinct tenant/application identifiers to prevent cross-tenant key reuse.
- Cloudflare Rate Limiting counters remain approximate and location-scoped. Core v1 standardizes messages; it does not make Cloudflare counters globally atomic.
- Threat signals are evidence. These rate-limit bridges do not automatically block requests from a threat signal alone.
- This integration does not deploy Workers, create bindings, configure secrets, or change consumer applications.
