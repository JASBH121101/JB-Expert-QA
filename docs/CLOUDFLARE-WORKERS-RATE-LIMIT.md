# JB Security Guard — Cloudflare Workers transversal rate limiting

## Scope

This adapter is part of `@jb/security-guard`, but it is deliberately exported as a separate Worker-native entry point. It does not import the Node.js/Express entry point and does not change the ERP's business logic.

```js
import {
  createCloudflareWorkerRateLimit
} from "@jb/security-guard/cloudflare-worker-rate-limit";
```

The adapter only evaluates a request when the Worker route calls `check()`. The host application remains responsible for authentication, authorization, request parsing, business rules, and deciding which route uses which policy.

## Policy-based configuration

Use a separate Cloudflare Rate Limiting binding for each independently configured threshold and period. Do not invent limits before measuring representative traffic.

```js
const rateLimit = createCloudflareWorkerRateLimit({
  namespace: "jb-parfums-erp",
  policies: {
    general: {
      binding: env.JB_GUARD_GENERAL_LIMITER,
      mode: "monitor",
      periodSeconds: 60,
      failureMode: "open"
    },
    authentication: {
      binding: env.JB_GUARD_AUTH_LIMITER,
      mode: "enforce",
      periodSeconds: 60,
      failureMode: "closed"
    },
    dgi: {
      binding: env.JB_GUARD_DGI_LIMITER,
      mode: "enforce",
      periodSeconds: 60,
      failureMode: "closed"
    },
    uploads: {
      binding: env.JB_GUARD_UPLOAD_LIMITER,
      mode: "monitor",
      periodSeconds: 60,
      failureMode: "open"
    },
    inventory: {
      binding: env.JB_GUARD_INVENTORY_LIMITER,
      mode: "monitor",
      periodSeconds: 60,
      failureMode: "open"
    },
    administration: {
      binding: env.JB_GUARD_ADMIN_LIMITER,
      mode: "enforce",
      periodSeconds: 60,
      failureMode: "closed"
    }
  }
});

// Call only after resolving a trusted server-side identity.
const decision = await rateLimit.check({
  policy: "authentication",
  scope: "login",
  identity: trustedOpaqueAccountOrClientId
});
if (decision.response) return decision.response;
```

The example names are integration placeholders, not a statement that these bindings or thresholds already exist in Cloudflare. The `periodSeconds` supplied to the adapter must match the period configured on the corresponding binding. Cloudflare's configured `simple.limit` value must be established only after the traffic audit.

For a single binding, the shorter form remains available:

```js
const limiter = createCloudflareWorkerRateLimit({
  binding: env.JB_GUARD_GENERAL_LIMITER,
  mode: "monitor",
  periodSeconds: 60
});
const decision = await limiter.check({
  identity: trustedOpaqueAccountId,
  scope: "catalog-read"
});
```

## Operational policy

- Normal reads: begin in monitor mode and tune after reviewing actual traffic.
- Authentication: apply a stricter route policy; use stable, opaque identities and avoid account-enumeration signals.
- DGI and sensitive documents: use a dedicated policy; rate limiting does not grant or change DGI permissions.
- Uploads: rate limiting controls request frequency only. Keep independent byte, file-count, parser, quarantine, and malware-scanning controls.
- Inventory and purchases: rate-limit the batch operation, not every item inside a legitimate bulk request. Test realistic imports and synchronization.
- Administrative operations: use dedicated policies and preserve all existing authorization checks.

Use a server-issued internal user, tenant, or session identifier after authentication. Do not pass passwords, bearer tokens, cookies, email addresses, phone numbers, or raw request data as the identity. SHA-256 makes the binding key opaque, but it is not encryption or a guarantee of anonymization. Before authentication, use a carefully designed client/account signal; do not rely solely on IP because NAT and mobile-carrier networks can group legitimate users. Only use a client IP supplied by the trusted Cloudflare edge, never an arbitrary forwarded header.

## Failure behavior

- `mode: "monitor"` records exceeded limits without blocking and defaults to `failureMode: "open"`.
- `mode: "enforce"` returns HTTP 429 when the binding reports an exceeded limit and defaults to `failureMode: "closed"`.
- A binding outage or invalid response returns HTTP 503 in `failureMode: "closed"`; it does not masquerade as an ordinary rate-limit rejection.
- `failureMode: "open"` is an explicit availability choice. Configure it per policy only where the ERP operation can safely continue without this control.
- Events contain policy and scope labels only. They do not include the identity, key, request path, credentials, or provider error.

## Cloudflare counter semantics

Cloudflare Rate Limiting bindings are approximate and eventually consistent. Counters are separate per Cloudflare location, and requests can exceed the configured threshold while updates propagate. They are useful as an abuse brake, not as a strict global quota or a guarantee that a precise request number will be blocked. A strict limit coordinated across locations requires a different stateful design, such as Durable Objects. See the current Cloudflare documentation:
https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

Different `namespace_id` values isolate binding counters. Bindings that share a namespace can share counters for matching keys in the same account and location. Choose unique IDs and thresholds only after the ERP traffic audit; do not copy example values blindly.

## Out of scope for this branch

- No ERP route, authentication flow, permission, DGI rule, inventory calculation, purchase, payroll, or database migration is changed.
- No Neon, R2, Cloudflare account binding, secret, or production resource is created or modified.
- No strict cross-region counter is claimed.
- No numeric request threshold is certified until representative ERP traffic has been measured.
