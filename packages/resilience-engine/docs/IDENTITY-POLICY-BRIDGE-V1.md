# JB Resilience Identity & Policy Bridge v1

**Status:** laboratory implementation; no production trust registry or signing keys are bundled  
**Package entry:** `@jb/resilience-engine/adapters/identity-policy-bridge`  
**Policy schema:** `jb.resilience.policy/v2`  
**Signature algorithm:** Ed25519

## Purpose and reuse boundary

This adapter binds an owner-managed policy signing identity to the existing Resilience Policy Engine. It does not implement a second policy engine, authorization ledger, PostgreSQL adapter, identity provider or key-management service.

- `createEd25519PolicySignatureVerifier()` validates the host-resolved trust record and verifies the canonical policy signing payload.
- `createResilienceIdentityPolicyBridge()` injects that verifier into the existing `createResiliencePolicyEngine()` and exposes the existing `evaluate`, `authorize`, `assertAuthorization` and `completeAuthorization` operations.
- The existing policy revision store and capability ledger remain separate host-provided dependencies. Reuse the existing PostgreSQL storage only where its contract fits; do not duplicate its tables or transactions for key management.

## Trusted-key record

The resolver must return an exact plain-data record with these fields:

- `schema`: `jb.resilience.policy-trust-key/v1`
- `keyId`: exact registry key identifier
- `keyVersion`: positive, monotonically increasing version for this key identifier
- `algorithm`: `Ed25519`
- `publicKeyPem`: PEM-encoded SubjectPublicKeyInfo public key
- `principalId`: immutable owner/principal identifier
- `role`: `policy-owner`
- `status`: `active`, `revoked` or `suspended`
- `notBefore` and `expiresAt`: non-negative Unix-millisecond timestamps, with expiry later than activation
- `policyIds`: a dense, unique list of exact policy identifiers authorized for this key

The resolver is synchronous and is invoked for every signature check. Promise-returning resolvers are rejected. The adapter never accepts private keys, signing secrets or client-supplied key records.

## Signature verification and anti-substitution rules

The policy signature must use canonical base64url Ed25519 encoding of exactly 64 bytes. Its key ID and algorithm must match the signed policy. The policy hash must be a lowercase SHA-256 digest and must match the policy's `policyHash`.

A SHA-256 material fingerprint binds all authority-bearing key metadata: key ID, key version, public-key DER, algorithm, principal, role, status, activation and expiry times, and the sorted policy-ID scope. Changing any of these fields without advancing `keyVersion` is rejected. A newer revoked or suspended version is remembered before the verifier denies it; an older active snapshot cannot roll that observed version back within the same verifier instance.

The PEM armor and imported key type are validated. Only an Ed25519 public key, the exact `policy-owner` role, an active key inside its validity window, and a key explicitly scoped to the target policy can verify a policy.

## Critical host-owned trust-registry requirement

The verifier's `observedKeys` map is an additional **in-process** rollback detector. It is not durable and resets when the verifier process restarts. It must not be advertised as cross-process or restart-safe revocation protection.

For operational use, `resolveTrustedKey(keyId)` must read from the host's authoritative, durable trust registry and return the current status and version on every call. That registry must atomically enforce monotonically increasing key versions, reject equal-version metadata substitution, and persist revocation/suspension before reporting the change as complete. The resolver must not serve a stale process-local cache as the source of truth. This package does not implement or provision that host registry.

If the host cannot confirm the current key record, return no key (or throw); verification fails closed. A static key snapshot or process-local map alone is not sufficient for production revocation guarantees.

## Example

```js
import {
  createResilienceIdentityPolicyBridge
} from "@jb/resilience-engine/adapters/identity-policy-bridge";

// Resolve synchronously from a host-owned authoritative trust registry.
// Never read the principal or key ID from an untrusted browser/request field.
const bridge = createResilienceIdentityPolicyBridge({
  policy,
  resolveTrustedKey: (keyId) => trustedKeyRegistry.getCurrent(keyId),
  policyRevisionStore,
  capabilityLedger
});

const decision = bridge.evaluate(request);
const authorized = await bridge.authorize(request);

if (authorized.authorized) {
  const current = await bridge.assertAuthorization({
    authorization: authorized.authorization,
    request: await readFreshHealthAndSecurityContext()
  });

  if (current.valid) {
    // The host's separately certified typed executor performs the permitted action.
    await bridge.completeAuthorization({
      authorization: authorized.authorization,
      outcome: "succeeded"
    });
  }
}
```

The example does not install a key registry, create a database connection, execute a host command or grant an operating-system permission. The host must supply real durable policy revision and capability stores; in-memory fixtures are test-only.

## Certification coverage

The laboratory suite uses generated Ed25519 key pairs and covers:

- valid PEM imports and real signature verification;
- signature tampering and context mismatch;
- malformed PEM, wrong key algorithm and asynchronous resolver rejection;
- role, status, policy-scope and validity-window restrictions;
- same-version changes to each authority-bearing metadata field;
- newer revocation followed by an older active snapshot;
- delegation through the existing policy engine, one-time authorization assertion and completion.

The suite runs through the Resilience Engine workspace test workflow on Linux and Windows with Node.js 22 and 24, plus the standalone npm package distribution smoke test.

## Deliberate limitations

This v1 does not provision a key vault, owner identity provider, trust-root ceremony, key signing service, remote registry, durable key-version registry, key rotation workflow, emergency recovery process or production credentials. The host remains responsible for durable key state, identity proofing, activation approval, audit retention and least-privilege access.

The bridge does not expand the existing policy capability matrix. A1 remains limited to already-certified actions. A2 containment and A3 failover remain denied pending their separate controls and certification.
