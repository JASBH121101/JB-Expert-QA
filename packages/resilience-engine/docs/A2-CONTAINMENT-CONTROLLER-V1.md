# JB Resilience — A2 Containment Controller v1 (laboratory)

**Status:** provider-neutral execution controller and adapter contract  
**Default:** disabled (enableExecution: false)  
**Production status:** not certified; no cloud, firewall, endpoint or hypervisor provider is bundled

This increment closes the orchestration gap between verified A2 readiness and a host-supplied containment implementation. It defines the execution lifecycle without binding the core to a vendor API. The controller does not discover provider resources, accept arbitrary resource identifiers from incidents, execute shell commands, or create containment profiles.

## Required host dependencies

The host must inject all of the following:

- **Policy authority:** authorize, assertAuthorization, and completeAuthorization. It must validate the current owner-approved policy revision and issue an opaque, short-lived authorization bound to the exact scope, action and profile. Release is a separate action and requires a separate authorization.
- **Containment provider:** a server-configured provider identity plus preflight, apply, reconcile, release, and reconcileRelease. The adapter must use server-owned credentials and a fixed allowlist of exact resources/profiles.
- **Independent verifier:** verifierId, verifyContainment, and verifyRelease. Its identity must differ from the executor. It must query authoritative state through a genuinely independent observation path; echoing the executor receipt is not verification.
- **Forensic recorder:** recorderId and preserveEvidence, returning durable evidence IDs and a retention receipt.
- **Budget ledger:** durable atomic reserve and settle methods.
- **Action ledger:** durable atomic claim and complete methods with uniqueness enforced for the supplied idempotency key.
- **Audit store:** durable append-only append.
- **Mutation control:** host-owned assertAllowed, rechecked before the provider side effect and before finalization.

All store durability markers are host integration assertions. The controller cannot prove that a custom adapter or database is truly durable; the host must certify its implementation and operational configuration.

Every injected adapter and durable dependency call is time-bounded by the controller. The host method receives an absolute deadline and an AbortSignal; production implementations must honor cancellation and must make durable reservation/settlement calls idempotent for the supplied operation key. A timed-out action-claim or budget reservation is treated as uncertain and held for reconciliation, never as permission to apply containment.

## Exact scope

Every policy decision, adapter call and receipt is bound to these six fields:

- assetId
- environment
- incidentId
- policyId
- policyRevision
- policyHash

The exact profileId is supplied separately and must be resolved through the host's owner-approved profile allowlist. Arbitrary URLs, firewall rules, shell text, cloud resource IDs and provider credentials are not accepted as execution inputs.

## Apply lifecycle

VERIFIED_READINESS → AUDIT_REQUESTED → POLICY_AUTHORIZED → ACTION_CLAIMED → BUDGET_RESERVED → PREFLIGHT_PASSED → APPLY → RECONCILE_IF_AMBIGUOUS → INDEPENDENTLY_VERIFIED → FORENSICS_PRESERVED → FINALIZED

A2 readiness must be the exact eligible object created by evaluateA2ProviderReadiness. Copies, reconstructed objects, stale evidence and a different scope are rejected.

The provider must return a typed receipt bound to the scope, profile, idempotency key, provider identity, operation ID, operation time and resulting state. On timeout, malformed response or uncertain outcome, the controller calls reconcile; it does not blindly retry. Only a reconciled applied result may advance to independent verification.

The independent verifier must confirm contained state and the exact scope/profile. The forensic recorder must then confirm retained evidence under an explicit retention policy. Failure or uncertainty at either stage returns held-for-reconciliation, never a successful contained result.

## Release lifecycle

Release is not an inverse command and is never implicit. It requires:

1. The exact controller-issued successful containment result object.
2. A new policy authorization for release-containment bound to the same asset, environment, incident, policy revision and profile.
3. Independent confirmation that the asset is still contained.
4. A fresh forensic preservation receipt before release.
5. A typed release result or authoritative release reconciliation.
6. Independent confirmation that the exact asset/profile is now released.

A failed, expired or unknown release authorization blocks the operation. An uncertain provider result is held for reconciliation. The original containment result cannot be released twice.

## Result semantics

- disabled: controller configuration has not opted into execution.
- denied: evidence, policy, mutation control, budget, audit or context did not permit the operation.
- not-applied: authoritative evidence says no mutation was applied.
- held-for-reconciliation: an operation may have occurred or finalization could not be established; never report success.
- contained / released: the provider action, independent verification, forensics, budget, action ledger, policy finalization and audit all completed.

## Current policy boundary

The existing JB Resilience Policy Engine still denies apply-containment-profile and release-containment. This module does not change that policy decision or issue authorization itself. A host-supplied A2 policy authority is required, and no production deployment should set enableExecution to true until its provider adapters, durable stores, verifier independence, release path, fault injection and risk-owner approval are certified.

This laboratory tests orchestration contracts with controlled test doubles. It does not certify a real cloud account, endpoint, network, hypervisor, firewall, storage system or production incident response process.
