# JB Security Guard multi-runtime audit

- Audit date: 2026-11-16
- Audited baseline: main at 821a2e88000b403b1fa24a446a5335587efd0d3c
- Laboratory branch: feature/security-guard-multiruntime-core-lab
- Scope: repository source and documentation review; no production systems, Cloudflare resources, databases, DNS, WAF, or customer projects were modified.

## Executive result

Reuse the existing Security Guard implementation. Do not create parallel security engines or replace the public JavaScript API. The repository already contains a substantial Node.js/Cloudflare security surface, but it does not yet provide a complete language-neutral runtime contract, PHP or Python SDKs, a shared production store implementation, or a public cross-runtime service API.

The Core introduced in this branch is contract-only: JSON Schemas and fixtures. It is not a central server and contains no executable runtime logic.

## Existing module inventory

| Area | Existing implementation | Current status / boundary |
| --- | --- | --- |
| General request controls | createSecurityGuard() in packages/security-guard/src/index.js | Node.js / Express-compatible; includes request-target checks and process-local rate limiting. |
| Request threat signatures | detectRequestThreats() inside the Node entry module | Pattern-based request-target/header checks; not a full WAF, parser-aware SQLi detector, bot classifier, or risk-scoring engine. |
| General distributed rate limiting | createDistributedRateLimit() | Node middleware; store is injected and must provide atomic consumeLimit(). |
| Authentication throttling | createAuthProtection() | Process-local account, account+client, and client scopes with bounded state and progressive lockout. Account-only blocking needs DoS-aware policy review. |
| Distributed authentication | createDistributedAuthProtection() | Async adapter over injected shared atomic store. Backend consistency, transactions, TTL and outage semantics remain the host adapter's responsibility. |
| Account recovery | createAccountRecovery(), createMemoryRecoveryStore() | Recovery challenges and scoped throttles exist; default memory storage is process-local. External delivery providers and production persistence are injected. |
| Security headers | createSecurityHeaders() | Existing Node middleware. |
| Origin validation | createOriginProtection() | Existing Node middleware for browser routes using ambient credentials. |
| CSRF | createCsrfProtection() | HMAC/session-bound synchronizer-token helper; session storage and lifecycle remain host-owned. |
| HTTP server hardening | configureNodeHttpServer() | Node HTTP/HTTPS server controls; does not apply to Workers or HTTP/2, and framework multipart/parser limits remain necessary. |
| Upload inspection | createUploadInspector() | Streaming hash/size verification, quarantine-store and scanner contracts, timeout and atomic-promotion requirements. Requires a real scanner and production storage adapter. Signature/type identification is not antivirus or full format validation. |
| Cloudflare Worker rate limit | createCloudflareWorkerRateLimit() | Runtime-native Cloudflare binding adapter; counters are approximate and location-scoped, not globally exact. |
| Worker-to-Pages bridge | createCloudflareWorkerRateLimitService(), createCloudflarePagesRateLimit() | Private Service Binding pattern; current endpoint is not a public authenticated API. |
| Security events | Module-specific onEvent callbacks | Sanitization exists in multiple modules, but there is no unified versioned event registry or central telemetry pipeline. |
| Policy management | Per-module options and mode settings | No central tenant/application policy manager or policy precedence engine was found. |
| Threat scoring | No complete cross-module scorer identified | Signals and rule findings exist; normalized signal aggregation, calibrated risk scoring, and policy-driven challenge/block decisions remain future work. |

## Multi-runtime implementation status

| Runtime | Repository evidence | Status |
| --- | --- | --- |
| JavaScript / Node.js | packages/security-guard, exported middleware and tests | Existing implementation; primary compatibility baseline. |
| JavaScript / Cloudflare Workers | Worker-native rate-limit adapter and tests | Partial runtime adapter; not the full Node middleware surface. |
| JavaScript / Cloudflare Pages | Pages Service Binding client and tests | Partial request-rate adapter; Pages requires the private Worker service. |
| PHP / Laravel / Symfony | No Security Guard Composer package or PHP runtime adapter found in the audited tree/search | Not implemented. |
| Python / FastAPI / Django / Flask | No Security Guard PyPI package or Python runtime adapter found in the audited tree/search | Not implemented. |

The existing SECURITY-INTEROPERABILITY.md defines cross-engine finding and malware-scanner boundaries. It is not a PHP/Python runtime contract or a universal middleware implementation.

## Gaps and risks

1. The current rate-limit helper is a JavaScript API; the new schemas must be consumed by native PHP/Python validators rather than imported as executable JS.
2. Existing Node distributed limiters depend on host-supplied atomic stores. The current Node HMAC namespace and Worker HMAC key composition differ; the new JS bridge must normalize tenant/application/identity-type context without changing the legacy API. Test fixtures do not establish production-grade distributed consistency.
3. Worker rate-limit bindings are suitable as a low-latency approximate option, not as a strict globally exact counter.
4. Authentication/account-recovery semantics must remain distinct from anonymous API quotas. Progressive account lockout can be abused to deny a victim access unless IP/account risk, generic responses, recovery paths, and thresholds are considered together.
5. Threat patterns are heuristic signals. Blocking must be confidence- and policy-driven, with false-positive and evasion tests.
6. Upload signature checks identify file types; they do not replace a maintained malware scanner, sandbox, CDR, safe image re-encoding, or atomic private-storage promotion.
7. Module event payloads differ. Cross-runtime telemetry needs a strict allow-list, event schema version, stable IDs, clock semantics, and redaction tests.
8. Tenant/application isolation, signing-key rotation, clock skew, request replay, bounded parsing, cancellation and failure modes require cross-runtime conformance tests.
9. The current package targets Node.js 22+. Workers/Pages have separate entry points; importing Node entry points into edge runtimes is unsupported.

## Target architecture

- Core: language-neutral JSON Schemas, versioned policy semantics, event vocabulary, and conformance vectors. No Node-only imports and no central singleton service.
- JavaScript adapter: keep @jb/security-guard and preserve existing exports; bridge the current helpers and Worker/Pages modules to the versioned contracts.
- PHP adapter: native Composer package; Laravel first, then Symfony and generic middleware after independent tests.
- Python adapter: native PyPI package; FastAPI first, then Django and Flask after independent tests.
- Infrastructure adapters: per-runtime atomic store, framework identity resolver, scanner, quarantine storage, telemetry sink, clock and key provider are injected interfaces. Never assume one provider or database is available.

## Implementation sequence and merge gates

1. Complete the source audit and freeze v1 contract semantics.
2. Build the JavaScript conformance bridge without breaking existing exports; run current Security Guard and package-distribution suites.
3. Add PHP core contracts/adapter natively and test with disposable local stores and framework harnesses.
4. Add Python core contracts/adapter natively and test with disposable local stores and framework harnesses.
5. Run identical JSON contract vectors across Node, PHP and Python; test tenant isolation, HMAC key rotation, replay/idempotency, atomic concurrency, time boundaries, malformed payloads, timeouts, cancellation, and outage behavior.
6. Run bounded performance and memory tests; publish runtime packages independently only after release gates pass.

No runtime is certified by the presence of a package directory alone. Compatibility labels must distinguish planned, implemented, tested, and certified.
