# JB Security Guard multi-runtime audit

- Audit date: 2026-11-16
- Audited baseline: `main` at `6f8c7fa8ff8a9b7fbf09a9ca67e97a748b201f6c` (post-merge state; includes the subsequent Resilience Engine merge)
- Security Guard closeout: PR [#81](https://github.com/JASBH121101/JB-Expert-QA/pull/81), merged 2026-11-16 at `4c86007ef61a786fdea94f48bcd154f7d8b1e527`
- Scope: repository source, tests, contract schemas and module documentation. No production systems, Cloudflare resources, databases, DNS, WAF, customer projects, secrets or paid services were modified.

## Executive result

Reuse the existing Security Guard implementation. Do not create parallel security engines or replace the public JavaScript API. The language-neutral Core remains contract-only: versioned JSON Schemas, semantics and shared fixtures. It is not a central server and contains no executable runtime logic.

The JavaScript/Node adapter has opt-in Core v1 integrations across request rate limiting, authentication, account recovery, CSRF, origin checks, uploads and request-inspection threat signals. PR #81 merged the language-neutral HMAC identity derivation helper, strict Core v1 normalizers, the explicit `check()` entry point on the distributed limiter, and the authenticated server-to-server universal rate-limit endpoint. It also includes the deterministic, server-policy-owned threat-assessment aggregator that creates Core v1 assessments. The initial Node aggregation stage is implemented; statistical calibration, broader runtime parity and autonomous enforcement remain out of scope.

PHP 8.2+ and Python 3.11+ Core v1 clients now exist as independent packages, with optional Laravel middleware and FastAPI-compatible ASGI middleware. Both use the central Node universal rate-limit endpoint; neither duplicates the shared counter implementation. Cloudflare Workers and Pages have rate-limit-specific adapters, not complete parity with the Node middleware surface.

## Current Node.js Core v1 coverage

The existing Node package keeps its legacy exports and adds opt-in Core v1 outputs:

| Area | Core v1 integration | Important boundary |
| --- | --- | --- |
| Local request rate limiting | Emits validated rate-limit checks and decisions, plus a sanitized rate-limit event on a new exceeded incident. | Process-local memory only; not a globally consistent counter. |
| Distributed rate limiting | Emits Core v1 checks, decisions and sanitized events. | Requires an injected atomic shared store; an optional PostgreSQL adapter is available in the Node package. |
| Authentication | Local and distributed protectors emit authentication attempts, decisions and sanitized events. | An `allow` decision means the throttle did not block the request; it does not establish that credentials are valid. |
| Account recovery | Emits sanitized recovery events and verification attempts/decisions after outcomes are known. | The generic `requestRecovery()` acceptance response is not represented as successful authentication. |
| CSRF and origin | Emits sanitized Core security events for rejected unsafe requests. | CSRF may correlate a session using HMAC; raw session/token and Origin/Referer values are excluded. |
| Upload inspection | Emits events for promotion, rejection, quarantine and cleanup failure. | Promotion is reported only after the storage adapter confirms it; events exclude file names, hashes, content and scanner details. |
| Request inspection | Emits normalized threat signals for existing request findings, plus local rate-limit decisions. | Signals are evidence only; they do not create a threat assessment or change existing enforcement. |

The Node conformance suite runs all eight shared Core v1 fixtures through both JSON Schema validation and the native JavaScript runtime validators: rate-limit check/decision, authentication attempt/decision, security event, rate-limit policy, threat signal and threat assessment. The PR #81 closeout head passed the Node 22/24, PHP 8.2, Python 3.11, PostgreSQL 16 and engine-certification gates. Follow-on checks on the current `main` commit also pass; the exact current-main matrix is recorded below. These checks establish tested implementation behavior for covered paths, not a security certification or statistical precision/recall study.

### Threat assessment: implemented aggregator, calibration remains open

- `validateThreatSignalV1()`, `validateThreatAssessmentV1()` and `validateThreatAssessmentPolicyV1()` validate the wire contracts.
- The Node-only `createThreatAssessmentEngine()` consumes validated signals under an immutable server-owned policy, enforces tenant/application and pseudonymous-subject isolation, applies a bounded time window, removes below-floor/stale/future samples, deduplicates contribution by rule, and emits the existing `threat-assessment/v1` output.
- The score is a deterministic policy index, not a probability. Request-inspector confidence values remain heuristic weights; no statistical calibration or independent precision/recall study is claimed.
- `block` is an assessment label only. It requires multiple strong signals across distinct rules and threat types, but the engine never blocks requests or issues challenges. Consumers must keep enforcement separate and explicitly reviewed.
- The older double-filter protocol `jb.security.assessment/v1` remains separate. It combines Expert QA and Security Guard verdicts for the same resource; it does not provide Core threat-assessment risk scores or Core signal IDs and must not be translated by inventing scores or references.

## Existing module inventory

| Area | Existing implementation | Current status / boundary |
| --- | --- | --- |
| General request controls | `createSecurityGuard()` in `packages/security-guard/src/index.js` | Node.js / Express-compatible request inspection and process-local rate limiting; Core signals/decisions are opt-in. |
| Request threat signatures | `detectRequestThreats()` | Pattern-based request-target/header checks; not a full WAF, parser-aware SQLi detector, bot classifier or calibrated risk-scoring engine. |
| General distributed rate limiting | `createDistributedRateLimit()`, `createPostgresRateLimitStore()` | Node middleware with an injected atomic `consumeLimit()` store; PostgreSQL UPSERT adapter is covered by an isolated PostgreSQL 16 concurrency/rollover CI test. |
| Authentication throttling | `createAuthProtection()` | Process-local account, account+client and client scopes with bounded state and progressive lockout; Core attempt/decision/event bridge is opt-in. |
| Distributed authentication | `createDistributedAuthProtection()` | Async adapter over injected shared atomic store; Core attempt/decision/event bridge is opt-in. Backend consistency, transactions, TTL and outage semantics remain the host adapter's responsibility. |
| Account recovery | `createAccountRecovery()`, `createMemoryRecoveryStore()` | Recovery challenges and scoped throttles; Core events/verification bridge is opt-in. Default memory storage is process-local. |
| Security headers | `createSecurityHeaders()` | Existing Node middleware; static header configuration, not a separate threat-assessment producer. |
| Origin validation | `createOriginProtection()` | Existing Node middleware with opt-in sanitized Core event on rejection. |
| CSRF | `createCsrfProtection()` | HMAC/session-bound synchronizer-token helper with opt-in sanitized Core event on rejection; session storage/lifecycle remain host-owned. |
| HTTP server hardening | `configureNodeHttpServer()` | Node HTTP/HTTPS server controls; does not apply to Workers or HTTP/2. Framework multipart/parser limits remain necessary. |
| Upload inspection | `createUploadInspector()` | Streaming hash/size verification, quarantine-store and scanner contracts, timeout and atomic-promotion requirements; Core terminal-outcome events are opt-in. A file signature/type check is not antivirus or full format validation. |
| Cloudflare Worker rate limit | `createCloudflareWorkerRateLimit()` | Runtime-native binding adapter with Core rate-limit contract support; counters are approximate/location-scoped, not globally exact. |
| Worker-to-Pages bridge | `createCloudflareWorkerRateLimitService()`, `createCloudflarePagesRateLimit()` | Private Service Binding pattern with Core rate-limit support; not a public authenticated API or a full Node middleware port. |
| Security Bridge | `src/security-bridge/`, `packages/security-guard/src/security-bridge.js` | Separate local loopback double-filter protocol. Its verdicts and decisions are not Core threat signals or risk assessments. |
| Security events | Module callbacks plus Core v1 schemas | Producers can emit versioned sanitized objects, but there is no central durable telemetry/event sink. |
| Policy management | Per-module options and mode settings | No central tenant/application policy manager or policy-precedence engine was found. |
| Threat scoring | `createThreatAssessmentEngine()` plus Core policy/signal/assessment validators | Node deterministic aggregation is implemented; statistical calibration and operational policy management remain out of scope. PHP/Python rate-limit clients do not implement threat scoring or enforcement. |

## Multi-runtime implementation status

| Runtime | Repository evidence | Status |
| --- | --- | --- |
| JavaScript / Node.js | `packages/security-guard`, native validators, Core bridge tests and package CI | Existing implementation with partial Core v1 integration; primary compatibility baseline. |
| JavaScript / Cloudflare Workers | Worker-native rate-limit adapter and tests | Partial runtime adapter for rate limiting; not the full Node middleware/auth/upload surface. |
| JavaScript / Cloudflare Pages | Pages Service Binding client and tests | Partial rate-limit adapter; requires the private Worker service. |
| PHP 8.2+ / Laravel | `packages/security-guard-php` with Core v1 HMAC/normalizers, HTTPS universal client and optional Laravel middleware | Implemented and CI-tested for Core v1 and Laravel-compatible middleware. Symfony and independently published Composer package remain open. |
| Python 3.11+ / FastAPI / Starlette | `packages/security-guard-python` with Core v1 HMAC/normalizers, async HTTPS client and ASGI middleware | Implemented and CI-tested for Core v1 and ASGI/FastAPI-compatible middleware. Django/Flask adapters and independently published PyPI package remain open. |

The existing `SECURITY-INTEROPERABILITY.md` defines cross-engine finding and malware-scanner boundaries. It is separate from the PHP/Python Core v1 clients and the authenticated universal rate-limit API.

## Gaps and risks

1. **Threat assessment calibration:** validate weights and thresholds against labeled benign/adversarial corpora; measure false-positive/false-negative rates, evasion resistance and stability before treating policy scores as calibrated or enabling any downstream enforcement. Confidence weights from request signatures remain heuristics.
2. **Cross-runtime boundaries:** Node, PHP 8.2+ and Python 3.11+ implement the same Core v1 HMAC identity-key formula and strict rate-limit normalizers and pass a shared known-answer vector in CI. PHP/Python clients call the central authenticated Node endpoint; independent local quota stores are intentionally not implemented, avoiding policy/counter divergence.
3. **Storage consistency:** distributed Node adapters depend on host-supplied atomic stores. No shared production store implementation is included in Core.
4. **Cloudflare scope:** Worker binding counters are approximate and location-scoped; Pages/Worker support is rate-limit-specific, not full Node feature parity.
5. **Telemetry:** versioned callbacks exist, but durable delivery, retry policy, retention, access control and operational monitoring belong to a separately reviewed sink.
6. **Identity and key rotation:** cross-runtime canonical HMAC derivation and identity bounds have shared Node/PHP/Python conformance tests. Managed active/retiring key registries, dual-key overlap, counter migration and automated key rotation are not implemented and require a separate versioned lifecycle.
7. **Authentication semantics:** authentication/recovery attempts and quota decisions must remain distinct. Progressive account lockout can be abused for denial of service unless identity scopes, recovery paths and thresholds are jointly reviewed.
8. **Upload safety:** signature identification does not replace a maintained malware scanner, sandbox, CDR, safe re-encoding or atomic private-storage promotion.
9. **Threat accuracy:** pattern matches can produce false positives and be evaded. Maintain benign corpora, adversarial cases and independent precision/recall measurements before treating scores as calibrated.
10. **Runtime boundaries:** the package targets Node.js 22+. Workers/Pages have separate entry points; importing Node entry points into edge runtimes is unsupported.

## Target architecture

- **Core:** language-neutral JSON Schemas, immutable contract semantics, policy schemas and conformance vectors. No Node-only imports and no central singleton service.
- **JavaScript adapter:** keep `@jb/security-guard` and preserve existing exports; the Node threat-assessment aggregator and universal rate-limit service exist, while statistical calibration and a tenant-scoped policy control plane remain separate work.
- **PHP adapter:** the native PHP 8.2+ package and optional Laravel middleware exist and are covered by CI; Symfony integration and independent Composer publication remain future work.
- **Python adapter:** the native Python 3.11+ package and Starlette/FastAPI-compatible ASGI middleware exist and are covered by CI; Django/Flask integration and independent PyPI publication remain future work.
- **Infrastructure adapters:** per-runtime atomic store, framework identity resolver, scanner, quarantine storage, telemetry sink, clock and key provider are injected interfaces. Never assume one provider or database is available.

## Implementation sequence and merge gates

1. Freeze the remaining Core threat-assessment policy semantics; do not derive risk scores from legacy double-filter verdicts.
2. Maintain the Node threat-assessment aggregator and its bounded, tenant-isolated evidence rules. Statistical calibration against labeled benign/adversarial corpora, independent precision/recall measurements and any downstream enforcement require separate review; do not treat the deterministic policy index as a probability.
3. Maintain and extend the existing PHP Core validators and Laravel middleware; complete Symfony integration only if needed, then prepare independent Composer publication.
4. Maintain and extend the existing Python Core validators and FastAPI/Starlette ASGI middleware; add Django/Flask adapters only if needed, then prepare independent PyPI publication.
5. Continue running identical contract vectors across Node, PHP and Python; add a managed key-rotation lifecycle and test tenant isolation, replay/idempotency, atomic concurrency, time boundaries, malformed payloads, timeouts, cancellation and outage behavior.
6. Run bounded performance and memory tests; publish runtime packages independently only after release gates pass.

No runtime is certified by the presence of a package directory alone. Compatibility labels must distinguish planned, implemented, tested and certified.


### Post-merge verification on current `main` (2026-11-16)

- Current audited commit: `6f8c7fa8ff8a9b7fbf09a9ca67e97a748b201f6c`. PR #81 is an ancestor of this state; the later Resilience merge does not replace or supersede the Security Guard closeout.
- The current-main Core validation, Security QA, Security Guard multi-runtime validation, Language QA validation, PostgreSQL integration and JB Engines Certification workflows all completed successfully.
- The checks cover Node.js 22/24, PHP 8.2, Python 3.11, PostgreSQL 16, the Security Guard suite, the Linux/Windows engine matrix, Expert QA regression and the five-package distribution boundary.
- The optional Neon development E2E job is read-only. These checks do not represent a production database migration, production deployment or live perimeter certification.
- No failed or pending required job was reported for this current-main run set at audit time.

## Security Guard Core v1 closeout (PR #81, merged 2026-11-16)

The following additions were merged from `feature/security-guard-closeout-lab` through PR #81. PRs #65 and #69 were superseded and were not merged independently; their changes were consolidated and reviewed in the closeout.

- `deriveCoreIdentityKey()` implements the documented domain-separated HMAC-SHA-256 Core v1 message via Web Crypto. It requires a trusted server-side canonical identity, a 32-byte minimum secret, safe tenant/application/type/key identifiers, and rejects empty, NUL-containing, ill-formed or oversized identities.
- `normalizeCoreRateLimitCheckRequest()`, `normalizeCoreRateLimitDecision()`, `normalizeCoreRateLimitPolicy()` and `createCoreRateLimitCounterKey()` provide strict immutable boundary handling. Shared known-answer identity fixture and package-distribution smoke coverage are included.
- The decision contract explicitly preserves fail-open semantics: `allowed=true, enforced=false, unavailable=true, exceeded=false` is valid when the store outage policy is fail-open. Fail-closed outages remain enforced HTTP 503. A permitted decision cannot be marked as enforced.
- The distributed limiter now exposes `check(request)` and shares the same evaluation path with its middleware, preserving the existing Core decision/event callbacks and statistics.
- `createUniversalRateLimitService()` is a Node.js server-to-server HTTP adapter. It requires authenticated app credentials, an exact path and method, bounded JSON, registered server-owned policies/scopes, and an injected atomic store. It rejects query strings and fails closed on store outage.
- Unit tests use a deterministic test store. The Node package also includes a parameterized PostgreSQL UPSERT store; PR #81 ran an isolated PostgreSQL 16 concurrency/rollover integration test. No Redis/Valkey driver is included, and no customer Neon/production database was changed or certified. A host using the PostgreSQL adapter must supply its own Pool/query connection, migration rollout, backups and cleanup operations.
- The universal HTTP endpoint must be deployed behind HTTPS and protected from credential guessing by appropriate upstream network controls. Credentials must never be exposed to browser clients.

## Explicit open items — do not label as certified

1. PHP 8.2+ and Python 3.11+ Core v1 packages and Laravel/ASGI adapters are present and CI-tested. Symfony, Django/Flask integration and separate Packagist/PyPI publication are not included in this closeout.
2. The PostgreSQL shared-store adapter is validated against an ephemeral PostgreSQL 16 service in CI; Redis/Valkey adapters and live customer Neon/production verification remain out of scope.
3. Core v1 HMAC derivation and shared known-answer conformance are implemented and tested across Node, PHP and Python; managed key rotation/dual-key overlap is not yet implemented as a cross-runtime lifecycle.
4. There is no central durable telemetry sink or tenant-scoped policy control plane.
5. The threat score remains a deterministic policy index, not a calibrated probability. Precision/recall and adversarial evasion measurements are not yet available.
6. Cloudflare Workers/Pages parity remains rate-limit-specific, not full parity with Node middleware.

The closeout is merged and its tested package interfaces passed CI, but that does not certify production deployment, globally available infrastructure, threat-score accuracy or managed key rotation. The still-open items above remain explicit release gates for any broader parity or production-readiness claim.


## PHP and Python runtime packages (source workspaces included in PR #81)

- `packages/security-guard-php`: PHP 8.2+ HMAC-SHA-256 Core v1 helper, strict rate-limit request/decision/policy normalizers, length-prefixed counter-key helper, authenticated HTTPS client and optional Laravel service provider/middleware.
- `packages/security-guard-python`: Python 3.11+ matching HMAC and Core v1 helpers, asynchronous authenticated HTTPS client and FastAPI/Starlette-compatible ASGI middleware.
- Both packages consume the shared Node universal endpoint, so a policy and quota are evaluated centrally. The PHP and Python packages do not maintain disconnected local counters.
- Both language adapters use the exact same known-answer vector as Node. CI runs PHP lint + HMAC/client tests and Python compile + HMAC/client/ASGI tests.
- PHP/Python packages are currently source workspaces inside this monorepo. Their own release tags/registries and independently pinned dependency/security-update workflows must be set up before publication to Composer Packagist or PyPI.
- Framework middleware is an adapter only: identity resolution must use trusted server-side authenticated state; credentials remain secret; HTTPS verification is mandatory; 401/configuration errors never trigger fail-open.
