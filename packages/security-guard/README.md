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


## Account recovery: verified email and SMS

~~~js
import { createSecurityGuard } from "@jb/security-guard";

const guard = createSecurityGuard({ mode: process.env.JB_GUARD_MODE ?? "monitor" });
const recovery = guard.createAccountRecovery({
  // Keep this stable across restarts and instances; load it from a secret manager.
  secret: process.env.JB_RECOVERY_SECRET,
  emailProvider: {
    async send({ to, requestId, token, expiresAt }) {
      const url = new URL("/reset-password", process.env.PUBLIC_APP_URL);
      // Keep the credential in the fragment; browsers do not send fragments
      // in the initial HTTP request or the Referer header.
      url.hash = new URLSearchParams({ rid: requestId, token }).toString();
      await mailer.send({ to, subject: "Reset your password", text: url.toString() });
    }
  },
  smsProvider: {
    async send({ to, requestId, code, expiresAt }) {
      const message = "Your recovery code is " + code + ". It expires at " +
        new Date(expiresAt).toISOString() + ".";
      await sms.send({ to, text: message });
    }
  }
});

// Resolve the account server-side. Pass only verified contact details.
// A missing account or unverified contact still receives the same generic response.
app.post("/account/recovery", async (req, res) => {
  const user = await findUserForRecovery(req.body.identifier);
  const channel = req.body.channel === "sms" ? "sms" : "email";
  const destination = channel === "sms" ? user?.verifiedPhone : user?.verifiedEmail;
  const result = await recovery.requestRecovery({
    accountId: user?.id ?? null,
    channel,
    destination: destination ?? null,
    contactVerified: Boolean(destination),
    request: req
  });

  res.setHeader("Cache-Control", "no-store");
  return res.status(202).json({
    accepted: result.accepted,
    requestId: result.requestId,
    message: "If the account and contact are eligible, recovery instructions will be sent."
  });
});

app.post("/account/recovery/verify", async (req, res) => {
  const result = await recovery.verifyRecovery({
    requestId: req.body.requestId,
    credential: req.body.token ?? req.body.code,
    request: req
  });
  if (!result.valid) {
    return res.status(400).set("Cache-Control", "no-store").json({
      error: "recovery_invalid_or_expired"
    });
  }

  // Hash with Argon2id (or an approved password-hashing implementation),
  // update the password, then revoke every existing session for this account.
  await updatePassword(result.accountId, req.body.newPassword);
  await revokeAllSessions(result.accountId);
  return res.status(204).end();
});
~~~

Security properties:

- Email recovery uses a cryptographically random 256-bit token; SMS recovery uses a six-digit one-time code.
- Challenge records store a keyed digest, never the raw token or OTP. A new challenge replaces the previous challenge for the same account and channel.
- Default expiry is 15 minutes for email and 5 minutes for SMS; both are single-use and allow at most 5 verification attempts.
- Request throttles default to 10 per IP / 15 minutes, 3 per account / 15 minutes, and 3 per destination / hour. Verification has a separate 20 attempts per IP / 15 minutes limit.
- Unknown accounts, unverified contacts, unavailable channels, and rate-limited requests receive the same generic accepted response. Events contain no account ID, email, phone, token, OTP, or provider error.
- Only pass an internal opaque account ID and a contact already verified by the application. This module does not verify ownership of an email address or phone number.
- The application must hash the new password with Argon2id or another approved password-hashing algorithm and revoke existing sessions after a successful reset.

The emailProvider.send() and smsProvider.send() adapters are required for actual delivery. Credentials and vendor configuration belong in the host application's secret manager, not in this package. Use an HTTPS public application URL for email reset links. The reset page should read the fragment, immediately clear it with history.replaceState, and POST the values over HTTPS. Avoid third-party analytics or embedded external content on that page.

The default createMemoryRecoveryStore() is bounded and process-local. It is suitable for development and a single application process; restarts clear active challenges and counters. For clustered or multi-region production, supply a shared store whose putChallenge, consumeChallenge, consumeLimit, and deleteChallenge operations are atomic across all instances. consumeChallenge must compare the digest, increment failed attempts, expire challenges, and consume a valid challenge atomically. consumeLimit must implement an atomic fixed-window counter. Do not use a non-atomic read-then-write Redis adapter.



## Safe offline testing without real contacts or provider credentials

The repository includes a test-only helper at `packages/security-guard/testing/recovery-adapters.js`. It provides mock email and SMS providers that capture messages in bounded process memory. They do not send network requests, write message files, or log tokens/OTPs. The helper is intentionally excluded from the package's published files and runtime exports.

Example:

~~~js
import { randomBytes } from "node:crypto";
import { createAccountRecovery, createMemoryRecoveryStore } from "@jb/security-guard";
import { createMockRecoveryProviders } from "../packages/security-guard/testing/recovery-adapters.js";

const mocks = createMockRecoveryProviders();
const recovery = createAccountRecovery({
  secret: randomBytes(32), // ephemeral test-only secret; never use this pattern in production
  store: createMemoryRecoveryStore(),
  emailProvider: mocks.emailProvider,
  smsProvider: mocks.smsProvider
});

// Supply an internal test account and a verified synthetic destination.
// Read the token/code from mocks.getMessages(...) inside the test process only.
~~~

Run the focused suite with:

~~~bash
npm run test:security-guard
~~~

No real email, phone number, account record, provider credential, Redis service, or production secret is required. Do not print captured messages to CI logs. Production integration must inject real providers and a stable secret from a secret manager, use verified contacts resolved server-side, and use a shared atomic store for multi-instance deployments.


## Response security headers

The Guard factory exposes a separate response middleware:

~~~js
const guard = createSecurityGuard({
  mode: "balanced",
  securityHeaders: {
    // Add only after inventorying the app's scripts, APIs, images and embeds.
    contentSecurityPolicy: "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
  }
});

app.use(guard.securityHeaders);
app.use(guard.middleware);
~~~

It adds X-Content-Type-Options: nosniff, a conservative Referrer-Policy, Permissions-Policy disabling camera/microphone/geolocation, and X-Frame-Options: SAMEORIGIN by default. It removes the X-Powered-By response header when the framework exposes removeHeader().

HSTS is emitted only when the request is demonstrably secure (request.socket.encrypted or request.secure). Forwarded headers are not trusted by default. Behind a reverse proxy, supply isSecureRequest only when the application has a narrowly defined trusted-proxy boundary. Never use a client-controlled X-Forwarded-Proto value as proof of TLS.

A generic CSP is deliberately not forced because an incorrect policy can break a real application. Define and test an application-specific enforced CSP (or report-only policy) after inventorying required origins, scripts, fonts, APIs and embeds. Do not allow later route middleware to overwrite security headers unintentionally.

## Capacity exhaustion is fail-closed

The per-process rate limiter and authentication-failure tracker no longer evict live client/account buckets to make room for new identities. When their bounded tables are full, untracked identities share a bounded overflow bucket or are rejected by the rate limiter. In balanced/strict modes this can temporarily deny new clients while active windows expire; this trades availability for avoiding lockout-reset bypass through identity rotation. Monitor capacity and size limits for expected traffic before production rollout.

This remains process-local. A horizontally scaled deployment still needs shared atomic rate-limit and authentication-failure storage; independent in-memory instances are not one global control.
