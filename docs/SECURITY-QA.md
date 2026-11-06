# JB Expert QA — Security QA

## Purpose

Security QA is a dedicated, reusable static-security profile inside JB Expert QA. It runs the existing project security rules together with additional defensive checks, using the same scanner, rule registry, scoring engine, and JSON/Markdown/HTML reporters as the general project auditor.

It is intended for repositories the operator owns or is authorized to assess.

## Run locally

~~~bash
npm run audit:security -- .
~~~

Choose a report format or output path:

~~~bash
npm run audit:security -- . --format=markdown --output=reports/security-report.md
npm run audit:security -- . --format=json --output=reports/security-report.json
~~~

Use a custom profile:

~~~bash
npm run audit:security -- . --config=config/security-audit.config.json
~~~

The default command remains offline. To explicitly query OSV.dev for known vulnerabilities in resolved npm packages:

~~~bash
npm run audit:security -- . --online-advisories
~~~

Only package names and exact versions are sent to OSV.dev. It prefers supported npm lockfiles and falls back to exact pinned direct-dependency versions in package.json when no supported lockfile exists; that direct-only coverage is reported as incomplete and blocks approval. The report records coverage and network request counts. Advisory lookup is not run unless the flag or a custom config explicitly enables it.

The default security profile has a 90/100 minimum score. Critical findings block approval, and incomplete scans cannot pass. High-severity findings reduce the score and may block approval depending on the configured threshold.

## Checks included

The existing security specialist continues to check for credential-like literals (without reporting the value), dynamic code execution, unsafe TLS configuration, risky dynamic HTML sinks, and local environment or credential files without opening their contents.

The dedicated rules add checks for:

- External endpoints configured with plain HTTP.
- Wildcard CORS origins combined with credentialed requests.
- Authentication cookies missing visible HttpOnly, Secure, or SameSite attributes.
- MD5 or SHA-1 usage in password-related source files.
- Math.random() used near security-sensitive values.
- JWT decoding near authorization logic without a visible verification call in the same file.
- Redirects that appear to use request-controlled destinations.
- Outbound HTTP requests that appear to use request-controlled input.

Every heuristic finding includes a file/line location, severity, detector identifier, and remediation guidance. The analyzer does not copy source lines or detected secret values into findings.

## Execution and data boundaries

The source-code profile is local and static:

- It does not execute the target application's code.
- It does not send attack payloads or issue HTTP requests.
- It does not connect to a live database, Cloudflare account, storage bucket, or production service.
- It does not install target-project dependencies.
- It does not open environment or credential files; it records their paths only.
- It makes no network requests unless the explicit `--online-advisories` option or a custom enabled advisory profile is used. The OSV check sends package names and exact versions only.

## Runtime site mode\n\nThe separate `audit:security:url` command loads one public page with Chromium to observe the document response. It uses the URL safety guard to block internal and reserved destinations. It does not authenticate or exploit the target.\n\n## Important limitations

Static analysis is not a penetration test. Pattern matching cannot fully trace tainted values, framework middleware, multi-line cookie options, authentication context, network boundaries, or controls implemented in an external dashboard. A finding requires human review, and no findings do not prove that an application is secure.

For a full security review, combine this profile with dependency advisory checks, runtime security-header validation, authenticated role/access tests in a disposable staging environment, backup/restore exercises, and a controlled penetration test. Never run destructive or exploit-style tests against production data.

## CI

The Security QA GitHub Actions workflow runs deterministic security-profile tests for changes to JB Expert QA. The regular Core validation workflow remains enabled as the broader regression suite. Security QA results are designed to be consumed by other repositories through a pinned JB Expert QA release or commit; consuming repositories should not need a new personal token for each engine update when access is configured with a stable, least-privilege GitHub App or read-only package/repository credential.


## Passive live-site security headers

For a public website you own or are authorized to assess, run the passive browser check:

~~~bash
npm run audit:security:url -- https://example.com
~~~

It performs a normal page load using Chromium and inspects the main document response for HTTPS, HSTS, enforced CSP quality, MIME sniffing protection, anti-framing controls, Referrer-Policy, Permissions-Policy, CORS response consistency, authentication-cookie attributes, and mixed content. It does not submit forms, authenticate, crawl linked pages, or send exploit payloads.

The auditor reuses the URL safety guard: localhost, private, link-local, and reserved network destinations are blocked by default, including redirects and browser subrequests. The scan does not bypass certificate validation. Reports include only cookie names and security attributes, never cookie values.

The runtime result is an observation of one page load, not a complete assessment of every API route, authenticated screen, CDN response, or infrastructure setting. A clean response does not certify the entire site.

## JB Security Guard — runtime protection package

The separate `@jb/security-guard` workspace package provides server-side HTTP middleware for Node.js applications. It is independent of the audit commands: it continues to enforce its configured policy without JB Expert QA running.

```js
import { createSecurityGuard } from "@jb/security-guard";

const guard = createSecurityGuard({
  mode: process.env.JB_GUARD_MODE ?? "monitor",
  onEvent: (incident) => logger.warn(incident)
});

app.use(guard.middleware);
```

Register it before body parsers and application routes. The initial release supports:

- `monitor`: record observations and allow requests; default mode.
- `balanced`: block high- and critical-severity detections.
- `strict`: also block medium-severity detections.
- `custom`: select severities through `blockSeverities`.

The initial rules inspect request targets for common high-confidence XSS, SQL-injection, and path-traversal signatures; enforce request-target, header, and declared Content-Length limits; and apply a per-process in-memory rate limit. Block responses are generic and use `Cache-Control: no-store`.

Events intentionally omit request bodies, query strings, header values, cookies, and client IP addresses. A path is included only when `includePath: true` is explicitly configured.

### Authentication brute-force protection

Security Guard exposes `guard.createAuthProtection({ identityKeyGenerator })` for login routes. The application must call `recordFailure(request)` only after credentials actually fail and `recordSuccess(request)` after successful authentication. Mount `auth.middleware` after the request body parser and before the login handler.

The default policy throttles an account-client pair after 5 failures in 10 minutes, a client after 20 failures in 10 minutes, and an account across clients after 12 failures in 10 minutes. Cooldowns increase progressively but have per-scope caps. A successful authentication clears the account and account-client buckets, not the client-wide bucket.

Identity and client keys are HMAC-derived with an in-memory process secret; event records contain no raw account identifier or client address. The default client resolver uses the socket peer address and ignores forwarded headers. Use a custom client resolver only behind a specifically trusted proxy.

`monitor` observes but does not enforce throttles. `balanced` and `strict` enforce them. The application must return a generic authentication response, set `Retry-After` to `attempt.retryAfterSeconds` when enforcing a threshold-reaching failure, and must not reveal whether an account exists.

Important boundaries:

- This version does not inspect request bodies. Enforce actual streamed/chunked body limits in the framework or server body parser too.
- The rate limiter is local to one Node.js process. Clustered or multi-region deployments need a shared atomic store before limits are global.
- Forwarded IP headers are not trusted by default. A custom `keyGenerator` must be based only on a narrowly configured trusted-proxy chain.
- Pattern detection is heuristic. It is not a replacement for parameterized queries, output encoding, application authorization, a WAF, or security testing.
- Guard must run on the server; it is not a frontend JavaScript security library.
- The package is a workspace source package and is not yet published to a public npm registry.


### Account recovery by verified email or SMS

The runtime package also exposes guard.createAccountRecovery({ secret, emailProvider, smsProvider }). Email challenges use a random 256-bit token; SMS challenges use a six-digit OTP. Both are single-use, expire by default after 15 minutes (email) or 5 minutes (SMS), and permit at most five failed verification attempts.

The module stores a keyed HMAC digest rather than the raw token or code. A new challenge replaces the previous one for the same account and channel. The default throttles are 10 requests per IP per 15 minutes, 3 per account per 15 minutes, 3 per destination per hour, and 20 verification attempts per IP per 15 minutes. Unknown accounts, unverified contacts, missing providers, and rate-limited requests return the same generic accepted response. Audit events omit account IDs, destination values, credentials, and provider error details.

The application must resolve accounts server-side, pass only an opaque internal account ID and an already-verified email address or E.164 phone number, hash the replacement password with Argon2id (or another approved password hash), and revoke all existing sessions after a successful reset. Email reset links should carry credentials in the URL fragment rather than query parameters; the reset page should clear the fragment immediately and submit the token in an HTTPS POST. The module does not itself prove ownership of a contact or perform the database password update.

Email and SMS delivery are dispatched asynchronously through provider adapters supplied by the host application; vendor credentials must remain in the host application's secret manager. The default memory store is bounded but process-local and resets on restart. Clustered deployments require an external adapter with atomic putChallenge, consumeChallenge, consumeLimit, and deleteChallenge operations shared by every instance. This package does not claim distributed protection until such an adapter is configured.



## Guard request-boundary hardening

Guard now inspects up to eight decoding rounds of request targets, rejects malformed percent/UTF-8 sequences and encoded control characters, and checks request framing ambiguity when the host HTTP adapter exposes raw headers. Conflicting Content-Length values and Content-Length combined with Transfer-Encoding are rejected with a generic 400 response in enforcing modes. These checks complement—not replace—the Node.js HTTP parser and upstream proxy controls.

The middleware still does not consume request bodies. Every host application must enforce streamed/chunked request limits at the framework parser and upload layer. Guard also rejects unknown configuration keys for its HTTP, authentication, and recovery factories so misspelled security options cannot be silently ignored.


## Node.js server boundary controls

Guard now exports configureNodeHttpServer() for Node.js HTTP/HTTPS Server instances. It applies bounded header/request/socket timeouts, keep-alive reuse limits, header-count limits, and an early Expect: 100-continue Content-Length gate. It must run before listen(). It does not apply to HTTP/2 or external edge platforms, and chunked payloads still need framework body-parser limits.


## Browser origin validation

Guard exposes a separate origin-allowlist middleware for cookie-authenticated browser routes. Unsafe methods require an exact configured Origin by default; missing Origin, null Origin, malformed Origin, and untrusted origins are rejected. Referer fallback and missing-origin allowance are opt-in. This is defense in depth against cross-site request forgery, not a CSRF-token replacement and not a CORS policy.


## Session-bound CSRF tokens

Guard includes an optional HMAC synchronizer-token helper bound to the host application's session identifier. It rejects unsafe methods without a valid session-bound token, does not store session state, and emits sanitized events. It requires a stable secret and the host application's session manager; it does not replace secure cookies, session rotation, authorization, or XSS prevention.

## AST-based request data-flow analysis

The local security audit now parses supported JavaScript files with Acorn and performs bounded, same-file variable-alias tracking. It follows values originating from request query, body, route parameters, headers, and cookies into selected security-sensitive sinks.

Current sink coverage includes outbound HTTP clients (SSRF), redirect destinations, dynamic code execution, process execution, query-like database calls, and HTML DOM insertion (innerHTML, outerHTML, and insertAdjacentHTML). Findings include source file and line locations and are marked for manual review.

Coverage boundaries are explicit:

- Supported parser extensions are `.js`, `.mjs`, and `.cjs`; TypeScript, JSX, Vue, Svelte, and other languages are not parsed by this AST pass.
- Tracking is intra-file and alias-based. It does not yet perform interprocedural, cross-file, path-sensitive, or full control-flow analysis.
- Sanitizer semantics, framework middleware, ORM parameter binding, and trusted URL allowlists are not inferred. Query-like findings require manual confirmation that values are not already safely parameterized.
- Parser failures are surfaced as findings and mark the security assessment incomplete rather than silently treating the file as clean.
- The analyzer parses source only. It does not execute inspected project code, make outbound requests, or connect to application databases.

This is a deeper static-analysis layer, not a substitute for runtime testing or a security review.
