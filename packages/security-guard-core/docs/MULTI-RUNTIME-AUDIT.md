# JB Security Guard multi-runtime audit

- Audit date: 2026-11-16
- Audited baseline: `main` at `9d5b37182b52a8e676c49be71023f0823a45e72e`
- Documentation branch: `docs/security-guard-core-current-coverage-audit`
- Scope: repository source, tests, contract schemas and module documentation. No production systems, Cloudflare resources, databases, DNS, WAF, customer projects, secrets or paid services were modified.

## Executive result

Reuse the existing Security Guard implementation. Do not create parallel security engines or replace the public JavaScript API. The language-neutral Core remains contract-only: versioned JSON Schemas, semantics and shared fixtures. It is not a central server and contains no executable runtime logic.

The JavaScript/Node adapter has opt-in Core v1 integrations across request rate limiting, authentication, account recovery, CSRF, origin checks, uploads and request-inspection threat signals. It now also includes a deterministic, server-policy-owned threat-assessment aggregator that creates Core v1 assessments. This completes the initial Node aggregation stage, but does not constitute statistical calibration, full-runtime certification or autonomous enforcement.

PHP/Laravel and Python/FastAPI adapters remain unimplemented. Cloudflare Workers and Pages have rate-limit-specific adapters, not complete parity with the Node middleware surface.

## Current Node.js Core v1 coverage

The existing Node package keeps its legacy exports and adds opt-in Core v1 outputs:

| Area | Core v1 integration | Important boundary |
| --- | --- | --- |
| Local request rate limiting | Emits validated rate-limit checks and decisions, plus a sanitized rate-limit event on a new exceeded incident. | Process-local memory only; not a globally consistent counter. |
| Distributed rate limiting | Emits Core v1 checks, decisions and sanitized events. | Requires the host to inject an atomic shared store. |
| Authentication | Local and distributed protectors emit authentication attempts, decisions and sanitized events. | An `allow` decision means the throttle did not block the request; it does not establish that credentials are valid. |
| Account recovery | Emits sanitized recovery events and verification attempts/decisions after outcomes are known. | The generic `requestRecovery()` acceptance response is not represented as successful authentication. |
| CSRF and origin | Emits sanitized Core security events for rejected unsafe requests. | CSRF may correlate a session using HMAC; raw session/token and Origin/Referer values are excluded. |
| Upload inspection | Emits events for promotion, rejection, quarantine and cleanup failure. | Promotion is reported only after the storage adapter confirms it; events exclude file names, hashes, content and scanner details. |
| Request inspection | Emits normalized threat signals for existing request findings, plus local rate-limit decisions. | Signals are evidence only; they do not create a threat assessment or change existing enforcement. |

The Node conformance suite runs all eight shared Core v1 fixtures through both JSON Schema validation and the native JavaScript runtime validators: rate-limit check/decision, authentication attempt/decision, security event, rate-limit policy, threat signal and threat assessment. The latest module integration work was exercised in Node 22/24 and on Ubuntu/Windows CI. These checks establish tested implementation behavior for the covered paths; they are not a security certification or a statistical precision/recall study.

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
| General distributed rate limiting | `createDistributedRateLimit()` | Node middleware; store is injected and must provide atomic `consumeLimit()`. |
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
| Threat scoring | `createThreatAssessmentEngine()` plus Core policy/signal/assessment validators | Node deterministic aggregation is implemented; statistical calibration, operational policy management, PHP/Python parity and any enforcement integration remain out of scope. |

## Multi-runtime implementation status

| Runtime | Repository evidence | Status |
| --- | --- | --- |
| JavaScript / Node.js | `packages/security-guard`, native validators, Core bridge tests and package CI | Existing implementation with partial Core v1 integration; primary compatibility baseline. |
| JavaScript / Cloudflare Workers | Worker-native rate-limit adapter and tests | Partial runtime adapter for rate limiting; not the full Node middleware/auth/upload surface. |
| JavaScript / Cloudflare Pages | Pages Service Binding client and tests | Partial rate-limit adapter; requires the private Worker service. |
| PHP / Laravel / Symfony | No Security Guard Composer package or PHP runtime adapter | Not implemented. |
| Python / FastAPI / Django / Flask | No Security Guard PyPI package or Python runtime adapter | Not implemented. |

The existing `SECURITY-INTEROPERABILITY.md` defines cross-engine finding and malware-scanner boundaries. It is not a PHP/Python runtime contract or a universal middleware implementation.

## Gaps and risks

1. **Threat assessment calibration:** validate weights and thresholds against labeled benign/adversarial corpora; measure false-positive/false-negative rates, evasion resistance and stability before treating policy scores as calibrated or enabling any downstream enforcement. Confidence weights from request signatures remain heuristics.
2. **Cross-runtime adapters:** PHP and Python implementations do not exist. Native validators, stores, cryptography and framework middleware must be implemented and tested independently.
3. **Storage consistency:** distributed Node adapters depend on host-supplied atomic stores. No shared production store implementation is included in Core.
4. **Cloudflare scope:** Worker binding counters are approximate and location-scoped; Pages/Worker support is rate-limit-specific, not full Node feature parity.
5. **Telemetry:** versioned callbacks exist, but durable delivery, retry policy, retention, access control and operational monitoring belong to a separately reviewed sink.
6. **Identity and key rotation:** tenant/application scoping and key IDs exist in the contracts; cross-runtime canonical HMAC derivation, rotation, dual-key migration and privacy-safe correlation still require identical conformance tests.
7. **Authentication semantics:** authentication/recovery attempts and quota decisions must remain distinct. Progressive account lockout can be abused for denial of service unless identity scopes, recovery paths and thresholds are jointly reviewed.
8. **Upload safety:** signature identification does not replace a maintained malware scanner, sandbox, CDR, safe re-encoding or atomic private-storage promotion.
9. **Threat accuracy:** pattern matches can produce false positives and be evaded. Maintain benign corpora, adversarial cases and independent precision/recall measurements before treating scores as calibrated.
10. **Runtime boundaries:** the package targets Node.js 22+. Workers/Pages have separate entry points; importing Node entry points into edge runtimes is unsupported.

## Target architecture

- **Core:** language-neutral JSON Schemas, immutable contract semantics, policy schemas and conformance vectors. No Node-only imports and no central singleton service.
- **JavaScript adapter:** keep `@jb/security-guard` and preserve existing exports; finish the remaining assessment/policy semantics and verify all runtime paths before calling the JS adapter complete.
- **PHP adapter:** native Composer package; Laravel first, then Symfony and generic middleware after independent tests.
- **Python adapter:** native PyPI package; FastAPI first, then Django and Flask after independent tests.
- **Infrastructure adapters:** per-runtime atomic store, framework identity resolver, scanner, quarantine storage, telemetry sink, clock and key provider are injected interfaces. Never assume one provider or database is available.

## Implementation sequence and merge gates

1. Freeze the remaining Core threat-assessment policy semantics; do not derive risk scores from legacy double-filter verdicts.
2. Complete Node threat-assessment aggregation with explicit server-owned policy, bounded evidence, tenant isolation, benign/adversarial fixtures and calibrated evaluation. Keep enforcement opt-in and conservative.
3. Implement PHP Core validators and Laravel adapter natively; run the shared JSON fixtures and runtime-specific security tests.
4. Implement Python Core validators and FastAPI adapter natively; run the same shared JSON fixtures and runtime-specific security tests.
5. Run identical contract vectors across Node, PHP and Python; test tenant isolation, HMAC key rotation, replay/idempotency, atomic concurrency, time boundaries, malformed payloads, timeouts, cancellation and outage behavior.
6. Run bounded performance and memory tests; publish runtime packages independently only after release gates pass.

No runtime is certified by the presence of a package directory alone. Compatibility labels must distinguish planned, implemented, tested and certified.
