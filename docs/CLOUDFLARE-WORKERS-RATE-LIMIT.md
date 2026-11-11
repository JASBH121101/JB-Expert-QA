# JB Security Guard — Cloudflare Workers rate-limit adapter

The Worker-native adapter is exported separately from the Node/Express middleware:

    import { createCloudflareWorkerRateLimit } from "@jb/security-guard/cloudflare-worker-rate-limit";

Bind a Cloudflare Rate Limiting binding in Wrangler, then call check({ identity, scope }) after the host application has resolved a trusted identity.

    [[ratelimits]]
    name = "JB_GUARD_ACCOUNT_LIMITER"
    namespace_id = "202611110101"
    [ratelimits.simple]
    limit = 600
    period = 60

- Monitor mode is the default. Exceeded counters emit sanitized telemetry but do not block.
- Enforce mode returns HTTP 429 with Retry-After and Cache-Control: no-store.
- Binding errors fail open and emit a sanitized availability event.
- Identity values are hashed with Web Crypto before being passed to Cloudflare. Raw account IDs are not sent to the binding or telemetry.
- Prefer stable account/user IDs after authentication. Avoid IP keys for employee traffic because NAT, carrier networks, and shared connections can group legitimate users.
- Cloudflare's counters are approximate, eventually consistent, and separate per Cloudflare location. This is an abuse brake, not a strict global quota. Strict cross-location limits require coordinated storage such as Durable Objects.
- External authentication services on a different origin are outside the host Worker's request path and need their own protection.
- This adapter does not use Node APIs and does not require database writes or schema changes.

See Cloudflare's current Rate Limiting binding documentation before deployment: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/.
