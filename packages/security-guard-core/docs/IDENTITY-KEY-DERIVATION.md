# Core v1 identity-key derivation

This document defines the key boundary for new cross-runtime adapters. It does not change the legacy @jb/security-guard JavaScript API.

## Canonical identity input

The adapter must resolve identity in trusted server-side code. Never accept the canonical identity from a browser field, query string, request body, cookie, or untrusted forwarded header.

- Account identity: prefer an immutable internal account ID, not a mutable email address or username.
- Client IP: use the direct peer address unless a narrowly configured trusted-proxy chain has been validated; normalize IPv4/IPv6 consistently in every runtime.
- Session identity: use a server-resolved opaque session identifier, never the session cookie value.
- Account+IP identity: derive the two component identities first, then use a distinct account_ip scope; do not concatenate ambiguous raw values.

Canonical identity values are UTF-8 strings supplied by the host application's identity resolver. For the Core v1 HMAC helper, reject empty values, NUL bytes, invalid UTF-8, values longer than 512 Unicode code points, or values longer than 2048 UTF-8 bytes. The HTTP universal-client identity envelope has a separate interoperable limit of 512 UTF-16 code units and 2048 UTF-8 bytes; clients must enforce that envelope before transmission.

## HMAC derivation

Use HMAC-SHA-256 with a randomly generated secret of at least 32 bytes. The secret stays in a secret manager and is never sent in a request, log, fixture, or event.

The v1 identity digest is:

```text
hex(HMAC-SHA-256(
  secret[keyId],
  UTF8("jb.security-guard.identity.v1\0"
    + tenantId + "\0"
    + applicationId + "\0"
    + identityType + "\0"
    + canonicalIdentity)
))
```

Every field before canonicalIdentity is a schema-constrained value without NUL characters. canonicalIdentity must also reject NUL. This domain-separated input binds the opaque digest to the tenant, application, and identity type. The result is exactly 64 lowercase hexadecimal characters and is the value carried as identity.key. keyId identifies the secret version, not the secret itself.

Policy and scope are separate counter dimensions and must be included in the internal atomic-store key. Build that key from a length-prefixed tuple of tenantId, applicationId, policyId, scope, identityType, keyId, and digest; do not concatenate unrestricted values with an ambiguous delimiter. Never store a counter under a raw account ID, IP address, or session value.

## Rotation and compatibility

- A key rotation must not silently reset active login lockouts or public API quotas. The adapter must define a bounded overlap/migration period in which the prior key version can still be recognized or counters are migrated.
- Do not accept arbitrary keyId values. Resolve key IDs through a server-owned allowlist of active and retiring keys.
- Do not log the digest unless the host's telemetry policy explicitly permits pseudonymous identifiers; never log the canonical identity or secret.
- Legacy Node and Cloudflare adapters currently have different HMAC input composition. Keep their existing behavior for backwards compatibility; the new JavaScript conformance bridge must implement and test this v1 derivation explicitly before PHP/Python interoperability is claimed.

## Required conformance vectors

Every runtime must verify the exact same fixtures for valid/invalid identity values, digest length/case, tenant isolation, application isolation, identity-type separation, key ID selection, key rotation overlap, and cross-runtime equality. Use a fixed test-only secret for vectors; never place a production secret in the repository.


## Runtime helper conformance status

The Node package exposes `deriveCoreIdentityKey()` from `@jb/security-guard/core-contract-v1`. The PHP 8.2+ package and Python 3.11+ package expose equivalent helpers. All three implementations use the exact byte sequence above and pass the same checked-in known-answer vector in their runtime tests. The helpers accept trusted server-side canonical identity and secret material; they do not resolve identity from an HTTP request.

The helpers do not implement a key vault, active/retiring key registry, dual-key overlap window or counter migration. Those remain host-owned until a versioned rotation contract is designed and independently tested. Do not rotate a live key without a reviewed migration plan, as key IDs are part of the counter-key tuple and an unplanned rotation can split active counters.
