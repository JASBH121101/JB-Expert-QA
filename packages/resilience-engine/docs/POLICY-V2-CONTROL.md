# JB Resilience Engine v0.3 — Policy v2 and Capability Control

## Status and compatibility

This document describes the v0.3 policy-control API. It does not change the existing v1 runtime policy, which remains `jb.resilience.policy/v1` with `mode: "semi-autonomous"`. The target schema is `jb.resilience.policy/v2` with `mode: "autonomous-advanced"`.

v2 is accepted only by the separate policy engine. It is not silently interpreted by the legacy `createResilienceEngine()` executor. The controller issues a short-lived in-process authorization object; it does not run a service command or install a daemon.

## Trust model

The package does not include a production signing key, trust root or default verifier. The host must inject `verifyPolicySignature({ policy, signature, policyHash, signingPayload })`. The callback must verify the signature against an owner-controlled trust store and return the literal boolean `true`. Promise results, truthy objects and exceptions fail closed.

The canonical signing payload is JSON with recursively sorted object keys and original array order, excluding only `signature.value` and `policyHash`; the signing key ID and algorithm remain covered. `policyHash` is SHA-256 of that payload. The signature covers that same payload; the hash is provided to the verifier as a convenient independently checked digest. The signature metadata contains `keyId`, `algorithm` and `value`; the host is responsible for enforcing approved algorithms, key status, rotation and revocation.

Validity timestamps must be canonical UTC ISO-8601 values. The policy is invalid before `notBefore`, at or after `expiresAt`, or when the clock is invalid.

## v2 schema

The strict top-level fields are:

- `schema`: `jb.resilience.policy/v2`
- `policyId`: stable exact policy identifier
- `revision`: positive monotonically increasing integer
- `mode`: `autonomous-advanced`
- `validity`: `notBefore`, `expiresAt`
- `signature`: `keyId`, `algorithm`, `value`
- `policyHash`: lowercase SHA-256 hex digest
- `defaults`: fixed fail-closed values
- `budgets`: concurrency, incident, hourly asset and containment limits
- `services`: exact asset grants

Each service binds a unique exact `id` to one `environment`, `tier`, `criticality`, a non-empty set of exact `allowedActions`, and action-specific profiles. Wildcards, duplicate grants and unknown properties are rejected. An autonomous A1 restart grant is valid only for a `stateless`, `standard` criticality service and requires application-level health verification.

Example service policy entry:

```json
{
  "id": "catalog-api-01",
  "environment": "production",
  "tier": "stateless",
  "criticality": "standard",
  "allowedActions": ["restart-service"],
  "recovery": {
    "failureThreshold": 3,
    "maxRestartsPerHour": 2,
    "cooldownMs": 300000,
    "requireApplicationHealth": true
  },
  "containmentProfile": null,
  "failoverProfile": null
}
```

## Injected durable stores

Production controller construction requires:

1. `policyRevisionStore` with `durable: true` and atomic async `acceptRevision({ policyId, revision, policyHash })`. It must persist the greatest accepted revision and corresponding hash, reject lower revisions and reject a different hash for the same revision. It must remain correct across processes and restarts.
2. `capabilityLedger` with `durable: true` and atomic async `reserveAction(...)`, `assertReservation(...)`, and `completeAction(...)`. Reservations must serialize competing requests and enforce `maxConcurrentActionsPerIncident`, `maxActionsPerIncident`, `maxActionsPerAssetPerHour`, and `maxAutomaticContainmentsPerIncident`. The ledger must retain completed actions for budget accounting and release only reservations explicitly cancelled before execution.

The package includes memory implementations for deterministic tests and local development. They are non-durable, single-process fixtures and require explicit `allowInMemoryStores: true`; never use them for production authorization.

## API sketch

```js
import {
  createResiliencePolicyEngine,
  computeAdvancedPolicyHash
} from "@jb/resilience-engine/policy-engine";

// verifyPolicySignature must use the host's real key-management/trust policy.
// policyRevisionStore and capabilityLedger must be durable transactional adapters.
const controller = createResiliencePolicyEngine({
  policy,
  verifyPolicySignature,
  policyRevisionStore,
  capabilityLedger
});

const request = {
  assetId: "catalog-api-01",
  environment: "production",
  incidentId: "incident-2026-001",
  action: "restart-service",
  securityState: "clear"
};

const decision = controller.evaluate(request);
const result = await controller.authorize(request);
if (result.authorized) {
  const stillValid = await controller.assertAuthorization({
    authorization: result.authorization
  });
  // The host executor must require stillValid.valid immediately before its typed adapter.
  // v0.3 does not include that executor or perform the OS operation.
  if (stillValid.valid) {
    await controller.completeAuthorization({
      authorization: result.authorization,
      outcome: "unverified"
    });
  }
}
```

The authorization object is an opaque in-process capability. Do not serialize it, accept a client-supplied replacement, or treat its presence as evidence that an operating-system action succeeded. The host executor must supply a fresh host health/security context to `assertAuthorization()` immediately before a typed adapter invocation and record the outcome exactly once. The service/environment/incident/action binding cannot change between authorization and execution.

## Current capability matrix

| Class | v0.3 policy gate |
|---|---|
| A0 — Observe | Read-only policy decision only; no mutation reservation |
| A1 — Routine recovery | Only exact `restart-service` on stateless/standard assets, with clear security state and application-health verification |
| A2 — Bounded containment | Denied until a trusted, authenticated, replay-protected signal gateway and containment verifier are certified |
| A3 — Controlled failover | Denied until external monitoring, durable coordination, quorum, leases, fencing and consistency verification are certified |
| Other A1 actions | Denied until their typed adapters, budgets and outcome verifiers are certified |
| A4 — High-impact | Not in the action catalogue; unknown/high-impact capabilities are rejected |

No signature verifier, real key, external action adapter, host permission or production setting is provisioned by this release.
