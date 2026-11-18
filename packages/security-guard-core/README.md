# @jb/security-guard-core

Language-neutral contract package for the JB Security Guard engine family.

This package is deliberately **contract-only**. It contains versioned JSON Schemas, shared conformance vectors and contract documentation; it does not contain executable JavaScript, PHP or Python security logic, and it is not an HTTP service.

## Target runtime architecture

JB Security Guard Core (versioned contracts, policy semantics, event vocabulary) is designed to feed three independently implemented native adapters:

- JavaScript: Node.js, Cloudflare Workers and Cloudflare Pages.
- PHP: Laravel first, then Symfony and generic PHP middleware.
- Python: FastAPI first, then Django and Flask.

Each adapter must implement its own middleware, storage, cryptography, cancellation and framework integration. Adapters conform to the same wire contracts and fixtures; they do not execute JavaScript from another runtime.

## Contract families

- `contracts/rate-limit/v1`: opaque-identity check requests and normalized decisions.
- `contracts/authentication/v1`: authentication attempt records and protection decisions.
- `contracts/security-events/v1`: privacy-bounded, sanitized security events.
- `contracts/policies/v1`: tenant/application-scoped rate-limit policy.
- `contracts/threat-detection/v1`: normalized threat signals and risk assessments.
- `contracts/upload-inspection/v1`: scanner request/result envelopes and a normalized upload-inspection attestation bound to an opaque upload ID, exact byte count, SHA-256, detected MIME, scanner identity/version and scan timestamp.

All schemas use JSON Schema Draft 2020-12. Contract identifiers are immutable: incompatible changes require a new major schema version or a new versioned directory, not silent edits to v1 semantics.

## Current implementation status

The engine family has multiple runtime adapters, but feature parity is deliberately **partial**. A successful contract test does not imply that every runtime implements every protection.

| Runtime | Implemented coverage | Important exclusions |
|---|---|---|
| Node.js | Request inspection, request/rate-limit middleware, authentication protection, account recovery, CSRF, origin checks, response headers, upload-inspection orchestration, threat assessment and security-event bridges. | Production behavior still depends on host-configured policies, shared stores, scanner/storage adapters and secure serving. Heuristic request signatures are not a WAF. |
| Cloudflare Workers / Pages | Runtime-native rate-limit adapters. | Not full ports of Node authentication, CSRF, origin, upload or request-inspection middleware. |
| PHP 8.2 / Laravel | Core v1 HMAC/normalizers, authenticated HTTPS client for the central rate-limit service, Laravel rate-limit middleware, and a portable upload-quarantine orchestrator with injected storage/scanner interfaces. | Not a full Node parity port: native request inspection, CSRF/origin, authentication/recovery and response-header middleware are not yet implemented as equivalent PHP protections. No production scanner/storage adapter is bundled. |
| Python 3.11 / FastAPI | Core v1 HMAC/normalizers, asynchronous authenticated client and ASGI rate-limit middleware. | Not a full Node parity port: request inspection, CSRF/origin, authentication/recovery and response-header middleware are not implemented as equivalent Python protections. Python upload quarantine orchestration now exists, but requires host-provided private storage and scanner adapters; it is not a bundled antivirus or production upload deployment. |

The Node conformance suite validates the shared Core v1 fixtures against the available runtime validators. The PHP and Python suites exercise their own HMAC/client/middleware contracts. These are module-level tests, not a declaration that all runtime implementations are feature-equivalent, that production deployments have safe storage, or that rate limits are globally enforced unless a shared atomic store is explicitly configured.

The Node.js adapter also includes an opt-in deterministic threat aggregator driven by a server-owned policy. It produces a bounded Core v1 risk score and one of the `observe/challenge/block/review` assessment labels. The assessment remains advisory: it does not enforce a block or issue a challenge. The risk score is a policy index, not a probability; request-pattern confidence values remain heuristic and have not been statistically calibrated.

The upload-inspection family now defines language-neutral v1 scan-request, scan-result and attestation schemas plus shared synthetic conformance vectors for Node, PHP and Python. Node independently verifies the scanned stream's byte count and SHA-256; PHP requires sequential non-seekable stream consumption through the exact upload size; Python passes a read-only digest-tracking stream and independently verifies complete consumption and content digest. After a complete clean scan only, each runtime emits `jb.security.upload-inspection.attestation/v1`, binding the server-generated upload ID, exact SHA-256, byte count, detected MIME, scanner identity/version and millisecond timestamp. Node passes it in promotion metadata; PHP and Python require it as an argument to their storage promotion contracts. The host storage adapter must atomically persist the attestation with the exact promoted bytes. Tests assert these bindings and exercise the shared clean/malicious/unknown vectors. The attestation is normalized evidence, not a cryptographic scanner signature. Valid malicious/unknown results may carry attestation on the inspection error for audit linkage, but never authorize promotion. Incomplete streams, malformed scanner results and digest/size mismatches do not produce trusted attestation. A clean verdict never independently authorizes publication. This is contract conformance for the tested upload path, not full security-feature parity across runtimes. Production readiness still requires authenticated/versioned scanners, real private storage adapters that implement atomic object+attestation persistence, image decode/re-encode, authorization-aware serving, operational retention/cleanup and deployment fault tests.

The separate local double-filter protocol `jb.security.assessment/v1` is not interchangeable with `jb.security.threat-assessment/v1`; it does not provide the required Core risk score or signal references.

## Security invariants

1. Tenant and application scope are required where a request can affect shared state.
2. Cross-runtime wire contracts carry opaque HMAC-derived identity keys, never raw account identifiers, IP addresses, cookies, passwords, tokens or request bodies.
3. Identity keys include a key identifier so rotation can be managed deliberately. Rotation policy and dual-key migration must be specified before runtime enforcement.
4. Policies are server-owned configuration. A caller cannot choose its own request limit or failure mode.
5. Monitor and enforce are explicit. Store failures follow the policy's explicit open or closed mode; sensitive authentication paths must not silently fail open.
6. A threat signal is evidence, not a block decision. A policy assessment combines signals and thresholds; one weak signal must not automatically block an actor.
7. Events and evidence are allow-listed. Do not extend schemas with free-form request headers, query strings, bodies, cookies, credentials or raw identities.
8. An accepted rate-limit decision does not establish authentication, authorization, CSRF validity or malware-free upload status.

## Compatibility and release boundary

The Node.js adapter remains the behavioral compatibility baseline and preserves existing public `@jb/security-guard` exports. PHP and Python have partial rate-limit adapters and runtime-native upload quarantine orchestration. Do not describe any runtime as fully universal until each protection has a versioned cross-runtime contract, matching conformance fixtures, equivalent enforcement semantics, real host-adapter integration and runtime-specific integration tests.

The package is private and unpublished in this lab stage. No npm, Composer or PyPI release is implied.
