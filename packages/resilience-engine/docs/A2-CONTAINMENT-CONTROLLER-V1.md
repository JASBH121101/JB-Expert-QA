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
The independent verification receipt must carry the exact provider operationId and SHA-256 digest of the exact evidence-reference set it verified. The forensic preservation receipt must carry that same operationId and evidence-reference digest, in addition to its durable retention IDs. Receipts for a different operation, asset scope or evidence set are rejected.
- **Forensic recorder:** recorderId and preserveEvidence, returning durable evidence IDs and a retention receipt.
- **Budget ledger:** durable atomic reserve, reconcile-by-idempotency-key and settle methods.
- **Action ledger:** durable atomic claim, provider-start marker, reconcile-by-idempotency-key and complete methods with uniqueness enforced for the supplied idempotency key.
- **Audit store:** durable append-only append.
- **Mutation control:** host-owned assertAllowed, rechecked before the provider side effect and before finalization.

All store durability markers are host integration assertions. The controller cannot prove that a custom adapter or database is truly durable; the host must certify its implementation and operational configuration.

### Durable action journal semantics

The action ledger is a transactional state machine, not a boolean idempotency cache. Its reconciliation result uses exactly one of these states: `claimed`, `provider-started`, `completed`, `not-found`, or `unknown`. The budget ledger uses `reserved`, `settled`, `not-found`, or `unknown`. Every lookup is keyed by the exact action, scope, profile and idempotency key.

The action ledger must atomically allow `markProviderStarted` only from an unexpired `claimed` state. It must reject a competing or stale marker after the claim has been completed, cancelled or moved to provider-started. A completion request with outcome `not-applied` must never overwrite a `provider-started` or `completed` state without an authoritative provider reconciliation. A budget reservation reported as `reserved` after an ambiguous reserve call must be settled as `not-applied` before the controller abandons the operation. Unknown or malformed ledger state remains held; it is not permission to retry.
When the claim request itself times out and the controller has no valid claim receipt, a journal state of `claimed` is treated as potentially owned by another live invocation. The controller holds and does not cancel that claim. Host recovery may finalize it only after the ledger has authoritatively established lease expiry and that no provider-start marker exists.

Every injected adapter and durable dependency call is time-bounded by the controller. The host method receives an absolute deadline and an AbortSignal; production implementations must honor cancellation and make durable reservation/settlement calls idempotent for the supplied operation key. Timed-out action claims and budget reservations are queried again by that exact key. The action ledger must distinguish a claim that has not started the provider from a provider-started or completed action. A durable provider-start marker is required before the controller can call apply. If that marker times out, the controller reconciles the action journal; it will not call the provider unless the journal proves the provider has not started and the operation is safely finalized as not applied. Any ambiguous journal state is held for reconciliation. After the marker is recorded, the controller rechecks the current authorization and mutation-stop control immediately before both apply and release. A changed authorization, stop signal or expired readiness causes a hold; no provider call is made.

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

VERIFIED_READINESS → AUDIT_REQUESTED → POLICY_AUTHORIZED → ACTION_CLAIMED → BUDGET_RESERVED → PREFLIGHT_PASSED → PROVIDER_START_MARKED → APPLY → RECONCILE_IF_AMBIGUOUS → INDEPENDENTLY_VERIFIED → FORENSICS_PRESERVED → FINALIZED

A2 readiness must be the exact eligible object created by evaluateA2ProviderReadiness. Copies, reconstructed objects, stale evidence and a different scope are rejected.

The provider must return a typed receipt bound to the scope, profile, idempotency key, provider identity, operation ID, operation time and resulting state. On timeout, malformed response or uncertain outcome, the controller calls reconcile; it does not blindly retry. Only a reconciled applied result may advance to independent verification.

The independent verifier must confirm contained state and the exact scope/profile. The forensic recorder must then confirm retained evidence under an explicit retention policy. Failure or uncertainty at either stage returns held-for-reconciliation, never a successful contained result.

## Release lifecycle

Release is not an inverse command and is never implicit. It requires:

1. The exact controller-issued successful containment result object.
2. A new policy authorization for release-containment bound to the same asset, environment, incident, policy revision and profile.
3. Independent confirmation that the asset is still contained.
4. A fresh forensic preservation receipt before release.
5. A durable action-ledger provider-start marker for the release operation.
6. A typed release result or authoritative release reconciliation.
7. Independent confirmation that the exact asset/profile is now released.
8. A final authorization and mutation-stop recheck after independent release verification and before durable success finalization.

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

## Restart and recovery boundary

The successful containment result handle is held in a process-local WeakMap and is intentionally not reconstructible from caller-supplied JSON. A process restart therefore invalidates that in-memory handle; release through this controller is denied after restart. This increment also does not include a startup recovery worker that scans the durable action journal and resumes provider reconciliation. A host integration must provide a durable recovery workflow, bind it to the exact action/scope/authorization, reconcile provider state and forensics, and obtain a separate owner-approved release authorization before resuming. Until that capability exists and passes crash/restart fault injection, A2 remains laboratory-only and is not production-certified.
