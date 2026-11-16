# JB Engines Integration Standard v1

**Status:** laboratory implementation  
**Applies to:** JB Expert QA, JB Security Guard, JB Malware Engine, JB Resilience Engine, JB Advisor Engine  
**Enforcement package:** `@jb/engine-contracts`

## 1. Architecture boundary

Each engine remains an independently versioned package with its own source, tests, release notes and certification. A shared contract package defines only the metadata and message rules needed to connect engines. It must not become a shared runtime that makes one engine's lifecycle dependent on another engine's internal code.

No engine may import another engine's private `src/**` implementation. Integrations must use a declared public API, a typed adapter or a versioned message contract. Optional integrations must remain optional at startup.

## 2. Engine manifest

Every integrated engine publishes a manifest using `jb.engine.manifest/v1` with:

- `engineId`: stable identifier, such as `jb.security-guard`.
- `version`: stable `MAJOR.MINOR.PATCH` engine version.
- `contractsProvided`: versioned contracts the engine can emit or serve.
- `contractsConsumed`: minimum contract version and maximum supported major version.
- `dependencies`: explicit engine dependencies, bounded by minimum and maximum major versions and marked optional or required.
- `capabilities`: descriptive identifiers only; these are not grants or execution permissions.

Wildcard dependencies and self-dependencies are prohibited. Required dependencies must be present and compatible before an integration is enabled.

## 3. Message envelope

Messages use `jb.engine.message/v1` and include a unique message ID, correlation ID, producer identity and version, contract identity and version, event kind, timestamp, data classification, advisory semantics and a bounded JSON payload.

Payloads are limited to 64 KiB, depth 12 and 256 entries per collection. Non-finite numbers, cyclic objects, non-JSON values, unsafe object keys and unknown envelope fields are rejected.

All messages remain advisory evidence. In particular, a Security Guard alert, Malware Engine finding or Advisor recommendation cannot authorize a Resilience action. Resilience must independently validate trusted evidence and owner-signed policy through its existing policy boundary.

## 4. Versioning and compatibility

Engine and contract versions use stable `MAJOR.MINOR.PATCH` versions for this first standard.

- **MAJOR:** incompatible API or contract change; consumers must explicitly adopt it.
- **MINOR:** backward-compatible additive capability or optional field, with consumer validation updated only when needed.
- **PATCH:** backward-compatible correction without changing the contract shape.

A consumer declares `minVersion` and `maxMajor`. Compatibility is checked before connecting providers. A missing required provider, unsupported major version, contract mismatch, duplicate engine identity or dependency cycle blocks integration. A missing optional provider is reported as a warning.

## 5. Fault isolation and upgrade procedure

- No shared mutable state between engines.
- No engine update silently upgrades a sibling engine.
- Consumers depend on contract versions, not another package's current internal version.
- Unknown messages, malformed inputs, provider timeouts and failed validation are contained at the adapter boundary.
- The caller chooses whether a failed optional integration degrades gracefully or remains disabled. Resilience execution paths remain fail-closed.
- Every engine upgrade runs its own tests plus the affected contract and cross-engine regression suites.
- A breaking contract change is introduced side-by-side; dependent engines migrate in isolated branches before the old major is retired.
- Each release is reversible without reverting unrelated engine packages.

## 6. Security and authority boundary

This standard does not confer trust. Transport authentication, signature validation, producer registration, revocation, durable replay protection and authorization belong to the host-owned Identity & Policy Bridge and Security Telemetry integration. A valid message envelope proves structural conformance only; it does not prove the sender's identity, truthfulness or authority.

No messages may carry executable shell text, dynamic module paths, credentials, private keys or unreviewed filesystem/network instructions. Capability labels are descriptive and never cause execution.

## 7. Certification gates

Before the standard is merged, automated validation must verify strict manifests, message shape, payload bounds, compatibility ranges, duplicate IDs, dependency cycles, optional-provider behavior, invalid input rejection and backwards-compatible package boundaries.

The standard does not mark an integration production-ready. Storage durability, host permissions, cryptographic identity, distributed coordination and operational controls remain separate modules and release gates.
