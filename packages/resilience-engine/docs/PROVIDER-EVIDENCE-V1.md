# JB Resilience — A2 Provider Evidence Verifier v1

**Status:** laboratory-only evidence-verification contract  
**Package:** \`@jb/resilience-engine/provider-evidence\`  
**Capability:** A2 bounded containment  
**Execution:** disabled; this module never performs isolation, containment, traffic changes, host commands, or authorization.

## What this increment supplies

The A2 readiness gate requires independently verified evidence for the owner-approved profile, reversible provider adapter, tested rollback, independent verification, forensic preservation and available budget. This module verifies short-lived Ed25519 attestations from five distinct provider roles:

| Role | Signed predicates |
| --- | --- |
| \`policy-authority\` | \`ownerApprovedProfile\` |
| \`containment-provider\` | \`reversibleAdapter\`, \`rollbackPlan\` |
| \`containment-verifier\` | \`independentContainmentVerification\` |
| \`forensic-recorder\` | \`forensicEvidencePreserved\` |
| \`budget-authority\` | \`budgetAvailable\` |

The containment provider and containment verifier must have different provider identities. All attestations must bind to the same exact asset, environment, incident, policy ID, policy revision and policy hash. Every attestation also carries one or more evidence-reference IDs and SHA-256 digests.

## Trust ownership

The host owns provider enrollment, the authoritative key registry, provider identity, key revocation, policy approval, incident state, evidence storage, replay policy and all real infrastructure credentials.

The host supplies a synchronous \`resolveTrustedProviderKey(keyId)\` resolver. It must return the current authoritative record, not a cached client-supplied key. The record binds the key ID/version, Ed25519 public key, provider identity, role, status, validity window and the sole allowed capability. Registry persistence must enforce monotonic key versions and durable revocation across process restarts. The verifier's in-process rollback observation is defense in depth, not a durable key registry.

The signed payload uses canonical JSON over every authority-bearing attestation field except the signature itself. Signatures are Ed25519 base64url. The verifier checks exact object shapes, key-role-provider binding, key status and validity, scope equality, evidence-reference digests, attestation freshness and maximum lifetime. It fails closed on malformed input, unknown/inactive keys, invalid signatures, stale evidence or resolver errors. The default maximum attestation age is 30 seconds and the maximum lifetime is 60 seconds; the host may configure tighter bounded values.

The module verifies the attestation's integrity and source identity. It does not fetch evidence-reference contents or establish that a provider's underlying claim is true. The host must independently retrieve and validate the referenced evidence (including its SHA-256 digest) against authoritative provider APIs and audit records before treating a predicate as satisfied.

## API

\`\`\`js
import {
  createProviderEvidenceVerifier,
  verifyA2ProviderEvidenceBundle
} from "@jb/resilience-engine/provider-evidence";

const verifier = createProviderEvidenceVerifier({
  resolveTrustedProviderKey: (keyId) => hostKeyRegistry.getCurrent(keyId)
});

const result = verifyA2ProviderEvidenceBundle({
  attestations: signedProviderAttestations,
  expected: {
    assetId: "asset-17",
    environment: "production",
    incidentId: "incident-2026-001",
    policyId: "containment-policy",
    policyRevision: 4,
    policyHash: "64-lowercase-hex-characters"
  },
  verifier
});

if (!result.verified) {
  // Hold and escalate. Do not infer missing facts.
}
\`\`\`

The bundle result is immutable and always includes \`executable: false\`. Its \`facts\` object contains only the six predicates assigned to the five provider roles. It deliberately does not assert \`confirmedSecurityVerdict\`, \`trustedSignal\`, \`replayProtectedSignal\` or \`exactAssetBinding\`; those must come from the already validated Trusted Signal Gateway and host-owned incident context. A host may combine the separately verified facts with those trusted signal facts and the freshness window to call the existing read-only A2 readiness gate. Never construct evidence from request-body booleans or other untrusted client input.

## Not implemented by this increment

This is not a concrete containment provider. No Cloudflare, AWS, Azure, endpoint, hypervisor, network, firewall or Kubernetes isolation adapter is included. It does not isolate an asset, remove traffic, modify firewall rules, revoke credentials, issue host commands, preserve forensic data itself, release containment, or perform rollback.

No provider attestation is automatically trusted merely because it has a valid signature: provider enrollment and evidence retrieval remain host responsibilities. The bundle verifier does not create one-time action authorization and does not change the policy engine's A1-only executable action set. A2 remains blocked until a real typed containment adapter, authoritative provider enrollment/revocation, evidence retrieval, independent out-of-band verification, tested rollback, budget accounting and fault-injection/end-to-end certification are implemented.

The module is laboratory-only until those external integrations and safety gates have been reviewed and certified.

## Authoritative evidence-reference verification (v2 lab increment)

The provider-bundle signature check validates who signed the reference metadata; it does not validate the referenced object. The package now also exposes `verifyA2EvidenceReferences({ bundle, resolveEvidenceReference, clock, maxReferenceBytes, maxTotalBytes })`.

The host resolver is called once for each signed reference and must fetch it from the authoritative evidence/provider system. It receives an AbortSignal and has a bounded per-reference timeout (5 seconds by default, configurable up to 30 seconds). It must return the exact attested provider ID, role, asset, environment, incident, policy revision/hash and raw bytes. The verifier copies the bytes, enforces per-object and aggregate limits, recomputes SHA-256, and rechecks the bundle's expiry after each asynchronous lookup and before returning a verified reference inventory. Forged bundle objects, stale bundles, mismatched scope, missing objects, oversized evidence and digest mismatches fail closed. Raw evidence bytes are never returned or persisted by this module.

This closes the **reference integrity and scope-check gap**, not the semantic truth gap: the host resolver/provider integration must still validate that the referenced record actually proves the claimed control (for example, that an isolation operation is active, a rollback was exercised, or forensic evidence was durably preserved). The output continues to include `executable: false`; it is not an A2 execution authorization.
