# NEXORA — Security baseline hardening

**Status:** first hardening increment; not a security certification.

## Scope of this increment

This change tightens reverse-proxy trust and production session-cookie defaults in the NEXORA Laravel application. It does not merge the independently maintained JB Security Guard QA or JB Malware Engine packages into NEXORA.

## Reverse-proxy trust

NEXORA no longer trusts every proxy by default.

- Set `TRUSTED_PROXIES` to a comma-separated list of the exact IP addresses or CIDR ranges of reverse proxies that connect directly to the PHP application.
- Leave it empty when the PHP application is reached directly.
- Do not use `*`, `**`, hostnames, or public client-supplied values.
- The configuration parser rejects invalid IP addresses and CIDR prefixes during application bootstrap.
- Only `X-Forwarded-For`, `X-Forwarded-Port`, and `X-Forwarded-Proto` are trusted. Forwarded host and prefix headers are not enabled by this configuration.

Example syntax (documentation-only addresses):

```dotenv
TRUSTED_PROXIES=192.0.2.10,198.51.100.0/24,2001:db8:abcd::/48
```

The listed addresses must match the network source addresses observed by the PHP server. Do not copy the documentation-only addresses above into a live deployment.

## Session-cookie defaults

- Session encryption remains enabled by default.
- Cookies remain `HttpOnly` and `SameSite=Lax` by default.
- The `Secure` cookie flag now defaults to enabled when `APP_ENV=production`.
- Local HTTP development may explicitly set `SESSION_SECURE_COOKIE=false`; do not disable it in a public HTTPS deployment.

## Existing controls confirmed by source inspection

These controls were present in the inspected NEXORA Core source; their runtime behavior still requires automated execution and review:

- Laravel web middleware provides CSRF protection for state-changing web forms.
- Login and setup endpoints have route-level throttling.
- Successful login regenerates the session identifier; logout invalidates the session and regenerates the CSRF token.
- Administrative routes require authentication and server-side owner/employee authorization.
- Employee permissions are checked on the server.
- Initial setup checks for an existing owner/settings record before creating the first owner.
- Logo and cover uploads have server-side type, size, and dimension validation.

## Follow-up security work

The baseline is not complete. The next review must cover:

1. Account-aware login throttling and recovery-flow abuse, including distributed attempts and lockout behavior.
2. IDOR/object-scope checks for every admin resource and negative authorization tests.
3. Upload storage exposure, content validation, image processing, deletion, and cleanup behavior.
4. Database installer permissions, schema changes, backup/restore, and secret handling.
5. Production HTTPS, trusted-proxy configuration, host validation, security headers, and deployment hardening.
6. Full negative tests for CSRF, session fixation, privilege escalation, mass assignment, XSS, SQL injection, and rate-limit boundaries.
7. Mapping the separately approved three-level NEXORA security specification to implementation and acceptance tests before any final certification.

A passing test suite or a successful static audit alone must not be described as proof that NEXORA is secure or production-certified.
