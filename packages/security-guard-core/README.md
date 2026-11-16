# @jb/security-guard-core

Language-neutral contract package for the JB Security Guard engine family.

This package is deliberately **contract-only**. It contains versioned JSON Schemas and shared conformance vectors; it does not contain executable JavaScript, PHP, or Python security logic, and it is not an HTTP service.

## Runtime architecture

JB Security Guard Core (versioned contracts, policy semantics, event vocabulary)
feeds three independently implemented native adapters:

- JavaScript: Node.js, Cloudflare Workers, and Cloudflare Pages.
- PHP: Laravel first, then Symfony and generic PHP middleware.
- Python: FastAPI first, then Django and Flask.

Each adapter implements its own middleware, storage, cryptography, cancellation, and framework integration. Adapters conform to the same wire contracts and fixtures; they do not execute JavaScript from another runtime.

## Contract families

- contracts/rate-limit/v1: opaque-identity check requests and normalized decisions.
- contracts/authentication/v1: authentication attempt records and protection decisions.
- contracts/security-events/v1: privacy-bounded, sanitized security events.
- contracts/policies/v1: tenant/application-scoped rate-limit policy.
- contracts/threat-detection/v1: normalized signals and risk assessments.

All schemas use JSON Schema Draft 2020-12. Contract identifiers are immutable: incompatible changes require a new major schema version or a new versioned directory, not silent edits to v1 semantics.

## Security invariants

1. Tenant and application scope are required where a request can affect shared state.
2. Cross-runtime wire contracts carry opaque HMAC-derived identity keys, never raw account identifiers, IP addresses, cookies, passwords, tokens, or request bodies.
3. Identity keys include a key identifier so rotation can be managed deliberately. Rotation policy and dual-key migration must be specified before runtime enforcement.
4. Policies are server-owned configuration. A caller cannot choose its own request limit or failure mode.
5. Monitor and enforce are explicit. Store failures follow the policy's explicit open or closed mode; sensitive authentication paths must not silently fail open.
6. A threat signal is evidence, not a block decision. A policy assessment combines signals and thresholds; one weak signal must not automatically block an actor.
7. Events and evidence are allow-listed. Do not extend schemas with free-form request headers, query strings, bodies, cookies, credentials, or raw identities.
8. An accepted rate-limit decision does not establish authentication, authorization, CSRF validity, or malware-free upload status.

## Compatibility boundary

The existing @jb/security-guard JavaScript API remains authoritative for current Node/Workers/Pages consumers during migration. The new contracts are additive. The next implementation stage must build a JavaScript conformance adapter and bridge to the existing API before PHP or Python adapters begin.

The package is private and unpublished in this lab stage. No npm, Composer, or PyPI release is implied.
