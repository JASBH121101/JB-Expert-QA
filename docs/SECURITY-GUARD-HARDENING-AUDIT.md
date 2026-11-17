# JB Security Guard hardening audit

**Audit base:** `main` at `5e3f78420e7afb904ada528ba0ce59bcf3f1eb26`  
**Work branch:** `feature/security-guard-hardening-v2`  
**Scope:** Security Guard runtime, upload inspection boundary, and certification readiness.

## Current implementation confirmed

- Node.js package `@jb/security-guard` targets Node.js 22+ and exposes request middleware, response headers, CSRF, origin protection, authentication protection, account recovery, distributed rate limiting, distributed authentication protection, upload inspection, and Node HTTP server hardening.
- Request inspection is heuristic and primarily evaluates request targets and headers. It is not a WAF replacement and does not inspect arbitrary application request bodies.
- Default mode is `monitor`; blocking is opt-in through `balanced`, `strict`, or explicit custom severity policy.
- The default rate limiter is process-local. The repository includes a PostgreSQL adapter and distributed service, but production deployments must explicitly configure a shared atomic store to obtain cross-instance enforcement.
- Upload inspection streams into a quarantine adapter, calculates SHA-256, checks a narrow file-signature allowlist, passes the complete stream through a scanner adapter, verifies the scanner stream digest and size, optionally requires a completed Security Bridge allow decision, and only then calls the storage adapter's promotion method.
- The upload inspector does not ship a production malware scanner or production storage adapter. Test in-memory adapters are not production services.
- Signature checks are bounded type identification, not full file validation or content disarm/reconstruction. Image decode/re-encode and safe serving remain host-application responsibilities.
- Security headers intentionally do not force a generic CSP. Each host application must define and test its own policy.
- The existing Security QA workflow runs deterministic tests on Node.js 22 and 24, audits high/critical dependency vulnerabilities, and generates a CycloneDX SBOM.

## Confirmed integration risks / hardening work

1. **Static-path rate-limit exclusion:** the previous suffix-only exclusion could exempt dynamic GET/HEAD routes such as `/api/catalog.js`. The hardening branch now requires both an approved static directory prefix and an allowed extension, with regression coverage. Host applications must still configure their actual static directories deliberately.
2. **Production upload path:** require private quarantine and private approved storage adapters, real scanner integration, bounded multipart parsing, atomic digest-and-size verification during promotion, and cleanup/retention monitoring.
3. **Image publication:** image uploads must be decoded and re-encoded by a maintained image library before publication. Never expose untrusted originals directly from a public web root.
4. **Application serving boundary:** approved files still require authorization, explicit content type, `nosniff`, safe content disposition, and a separate untrusted origin for previews where appropriate.
5. **Distributed enforcement:** verify every production multi-instance deployment uses a shared atomic store; process-local counters must not be represented as global protection.
6. **PHP/Laravel parity:** the current Node package cannot be assumed to protect Laravel automatically. The PHP adapter must be audited separately for middleware ordering, CSRF/session semantics, request limits, upload lifecycle, and fail-closed behavior.
7. **Policy rollout:** preserve monitor-first rollout, then enable blocking by route and severity only after observing false positives and validating application compatibility.
8. **Telemetry:** verify sanitized events, bounded cardinality, alerting on scanner/storage/cleanup failures, and no secrets, raw credentials, file bytes, or untrusted filenames in logs.

## Required certification gates

- Existing Security Guard test suite passes on supported Node versions.
- Negative tests prove unsupported signatures, MIME/extension mismatches, oversize streams, scanner timeout/outage/unknown verdict, digest mismatch, bridge denial/unavailability, promotion failure/timeout, and cleanup failure never produce a public approval.
- Adapter contract tests prove quarantine is private, promotion is atomic and cancellable, and deletion is idempotent.
- HTTP tests cover chunked bodies, ambiguous framing, duplicate/invalid Content-Length, slow uploads, header limits, spoofed proxy headers, and safe shutdown.
- Deployment tests prove shared-store rate limiting across at least two independent app instances.
- Host integration tests prove no upload is served before approval and that image re-encoding occurs before publication.
- PHP/Laravel tests independently prove the actual middleware and upload protections; a remote Node rate-limit call alone is not full Security Guard parity.

## Non-goals

- Do not claim complete attack detection or that heuristic signatures replace a WAF, parameterized queries, output encoding, authorization, or an independent security assessment.
- Do not add a built-in antivirus claim without a real scanner and versioned engine.
- Do not change production defaults from monitor to blocking globally.
- Do not modify Nexora application source from this Security Guard branch.
- Do not merge until the implementation and certification gates above pass.
