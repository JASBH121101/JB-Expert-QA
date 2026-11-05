# @jb/security-guard

Runtime HTTP request protection middleware for Node.js applications (Node.js 22+).

## Install

The package is part of the JB Expert QA monorepo and is exposed as an npm workspace:

~~~bash
npm install
~~~

After it is published as a standalone package, an application will be able to install the published package using its registry package name. It is not published yet.

## Use with Express-compatible middleware

~~~js
import express from "express";
import { createSecurityGuard } from "@jb/security-guard";

const app = express();
const guard = createSecurityGuard({
  mode: process.env.JB_GUARD_MODE ?? "monitor",
  onEvent(event) {
    // Send the sanitized event to your approved application logger.
    console.warn("[JB Security Guard]", event);
  }
});

// Register before body parsers and application routes.
app.use(guard.middleware);
~~~

The returned object also exposes `getStats()` and `reset()`.

## Modes

- `monitor`: detect and emit sanitized events without blocking.
- `balanced`: block high- and critical-severity detections.
- `strict`: block all configured severities, including medium.
- `custom`: use the supplied `blockSeverities` list.

The default mode is `monitor` to reduce deployment risk. Blocking is opt-in.

## Initial protections

- High-confidence request-target signatures for common XSS, SQL injection, and path-traversal patterns.
- Request-target length and malformed-target checks.
- Header count and byte limits.
- Content-Length limit before body parsing.
- Per-process, in-memory request rate limiting.
- Sanitized incident events without query strings, header values, cookies, request bodies, or client IP addresses by default.

## Brute-force protection for authentication routes

Create an authentication protector separately from the general request middleware:

```js
import express from "express";
import { createSecurityGuard } from "@jb/security-guard";

const app = express();
app.use(express.json());

const guard = createSecurityGuard({ mode: process.env.JB_GUARD_MODE ?? "monitor" });
const auth = guard.createAuthProtection({
  // Return a stable account identifier, never a password, token, or session secret.
  identityKeyGenerator: (req) => req.body?.email
});

app.post("/login", auth.middleware, async (req, res) => {
  const user = await verifyCredentials(req.body);

  if (!user) {
    const attempt = auth.recordFailure(req);
    if (attempt.enforced) res.setHeader("Retry-After", String(attempt.retryAfterSeconds));
    return res.status(attempt.enforced ? 429 : 401).json({
      error: attempt.enforced ? "authentication_temporarily_unavailable" : "invalid_credentials"
    });
  }

  auth.recordSuccess(req);
  return res.json({ ok: true });
});
```

Register the JSON/body parser before the authentication middleware so the configured identity resolver can read the parsed account identifier. Keep the response generic; do not reveal whether the account exists.

Default in-memory policies:

| Scope | Threshold | Initial cooldown | Maximum cooldown |
| --- | ---: | ---: | ---: |
| Account + client | 5 failures / 10 minutes | 1 minute | 15 minutes |
| Client address | 20 failures / 10 minutes | 5 minutes | 30 minutes |
| Account across clients | 12 failures / 10 minutes | 15 seconds | 1 minute |

Cooldowns increase progressively after repeated lockouts and are capped. A successful login clears that account's and account-client pair's counters, but deliberately does not clear the client's aggregate counter.

Events contain only a rule ID, scope names, timestamp, action, severity, and cooldown duration. Account identifiers and client addresses are HMAC-derived for internal bucket keys and are never written to event records.

- `monitor` records a would-be lockout but does not reject authentication requests.
- `balanced` and `strict` enforce high-severity authentication throttles.
- `custom` enforces the throttle only when `high` is included in `blockSeverities`.
- The resolver is application-specific and must be explicitly configured.
- This first version is process-local. Multiple app instances require a shared atomic store before treating limits as global.
- Account-level throttling is intentionally short to limit account-denial-of-service risk. Applications should also use MFA or step-up verification for high-risk accounts.

## Important deployment notes

- Register the middleware before body parsers and application routes.
- This first version does not read or inspect request bodies. Enforce streamed/chunked body limits in the framework/server body parser as well.
- The rate limiter is local to one Node.js process. Multi-instance deployments need a shared atomic store (for example Redis) before treating limits as global.
- Forwarded IP headers are not trusted by default. Supply a `keyGenerator` only when the application has a narrowly configured trusted-proxy chain.
- Signature detection is heuristic and can produce false positives or miss novel attacks. It is not a replacement for parameterized database queries, output encoding, authorization checks, a WAF, or a controlled security assessment.
- Do not expose Guard as a client-side browser script. It must run on the server.
- Monitor mode is recommended for baseline observation before enabling blocking.
