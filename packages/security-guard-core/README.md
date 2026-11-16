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

All schemas use JSON Schema Draft 2020-12. Contract identifiers are immutable: incompatible changes require a new major schema version or a new versioned directory, not silent edits to v1 semantics.

## Current implementation status

The Node.js `@jb/security-guard` package has opt-in Core v1 bridges for:

- Local and distributed request rate-limit checks/decisions.
- Node authentication and account-recovery attempts, decisions and sanitized events.
- CSRF, origin and upload security events.
- Request-inspection threat signals.

Cloudflare Worker and Pages integrations cover the rate-limit adapter path; they are not full ports of Node authentication, CSRF or upload middleware. PHP/Laravel and Python/FastAPI adapters have not been implemented.

The Node conformance suite validates the shared fixtures against all eight Core v1 runtime validators. This is module-level implementation and test coverage, not a declaration that the full JavaScript runtime is certified or that the system has production-grade global storage.

The threat signal and assessment schemas have validators, and the Node.js adapter now includes an opt-in deterministic aggregator driven by a server-owned threat-assessment policy. It creates a bounded Core v1 risk score and one of the `observe/challenge/block/review` assessment labels. The assessment is advisory: it does not enforce a block or issue a challenge. The risk score is a policy index, not a probability; request-pattern confidence values remain heuristic and have not been statistically calibrated.

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

The current Node.js adapter remains the compatibility baseline and preserves existing public `@jb/security-guard` exports. Complete its assessment/policy semantics and full runtime audit before beginning PHP/Python implementation.

The package is private and unpublished in this lab stage. No npm, Composer or PyPI release is implied.
