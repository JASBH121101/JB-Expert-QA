import test from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign
} from "node:crypto";
import {
  A2_PROVIDER_EVIDENCE_ROLES,
  createProviderEvidenceSigningPayload,
  createProviderEvidenceVerifier,
  verifyA2ProviderEvidenceBundle
} from "../src/provider-evidence.js";

const NOW = 1_800_000_000_000;
const SCOPE = Object.freeze({
  assetId: "host-01",
  environment: "test",
  incidentId: "incident-01",
  policyId: "policy-01",
  policyRevision: 7,
  policyHash: "a".repeat(64)
});
const ROLE_FACTS = Object.freeze({
  "policy-authority": { ownerApprovedProfile: true },
  "containment-provider": { reversibleAdapter: true, rollbackPlan: true },
  "containment-verifier": { independentContainmentVerification: true },
  "forensic-recorder": { forensicEvidencePreserved: true },
  "budget-authority": { budgetAvailable: true }
});

function createFixture({ providerOverrides = {} } = {}) {
  const keys = new Map();
  const privateKeys = new Map();

  for (const [index, role] of A2_PROVIDER_EVIDENCE_ROLES.entries()) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyId = "key-" + role;
    const providerId = providerOverrides[role] ?? "provider-" + role;
    keys.set(keyId, {
      schema: "jb.resilience.provider-trust-key/v1",
      keyId,
      keyVersion: overrides.keyVersion ?? 1,
      algorithm: "Ed25519",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      providerId,
      role,
      status: "active",
      notBeforeMs: NOW - 60_000,
      expiresAtMs: NOW + 600_000,
      capabilities: ["A2-bounded-containment"]
    });
    privateKeys.set(keyId, privateKey);
  }

  const verifier = createProviderEvidenceVerifier({
    resolveTrustedProviderKey: (keyId) => keys.get(keyId),
    clock: () => NOW
  });

  function makeAttestation(role, overrides = {}) {
    const keyId = "key-" + role;
    const trustedKey = keys.get(keyId);
    const unsigned = {
      schema: "jb.resilience.provider-evidence/v1",
      attestationId: "attestation-" + role,
      providerId: trustedKey.providerId,
      role,
      capability: "A2-bounded-containment",
      assetId: SCOPE.assetId,
      environment: SCOPE.environment,
      incidentId: SCOPE.incidentId,
      policyId: SCOPE.policyId,
      policyRevision: SCOPE.policyRevision,
      policyHash: SCOPE.policyHash,
      issuedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 10_000,
      keyId,
      keyVersion: 1,
      algorithm: "Ed25519",
      facts: { ...ROLE_FACTS[role] },
      evidenceRefs: [{
        refId: "artifact:" + role,
        sha256: "b".repeat(64)
      }],
      ...overrides
    };
    const signingPayload = createProviderEvidenceSigningPayload(unsigned);
    const signature = sign(
      null,
      Buffer.from(signingPayload, "utf8"),
      privateKeys.get(keyId)
    ).toString("base64url");
    return { ...unsigned, signature };
  }

  function makeBundle(overridesByRole = {}) {
    return A2_PROVIDER_EVIDENCE_ROLES.map((role) =>
      makeAttestation(role, overridesByRole[role] ?? {})
    );
  }

  return { keys, verifier, makeAttestation, makeBundle };
}

test("verifies five independently scoped provider attestations for one exact A2 incident", () => {
  const fixture = createFixture();
  const result = verifyA2ProviderEvidenceBundle({
    attestations: fixture.makeBundle(),
    expected: SCOPE,
    verifier: fixture.verifier
  });

  assert.equal(result.verified, true);
  assert.equal(result.executable, false);
  assert.equal(result.schema, "jb.resilience.a2-provider-evidence/v1");
  assert.equal(result.scope.assetId, SCOPE.assetId);
  assert.equal(result.providers.length, 5);
  assert.equal(result.facts.ownerApprovedProfile, true);
  assert.equal(result.facts.reversibleAdapter, true);
  assert.equal(result.facts.rollbackPlan, true);
  assert.equal(result.facts.independentContainmentVerification, true);
  assert.equal(result.facts.forensicEvidencePreserved, true);
  assert.equal(result.facts.budgetAvailable, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.facts), true);
});

test("a valid signed false predicate remains false and cannot satisfy the readiness gate", () => {
  const fixture = createFixture();
  const bundle = fixture.makeBundle({
    "containment-provider": {
      facts: { reversibleAdapter: true, rollbackPlan: false }
    }
  });
  const result = verifyA2ProviderEvidenceBundle({
    attestations: bundle,
    expected: SCOPE,
    verifier: fixture.verifier
  });

  assert.equal(result.verified, true);
  assert.equal(result.facts.rollbackPlan, false);
  assert.equal(result.executable, false);
});

test("rejects signature tampering after a provider signs the attestation", () => {
  const fixture = createFixture();
  const bundle = fixture.makeBundle();
  bundle[0].facts.ownerApprovedProfile = false;
  const result = verifyA2ProviderEvidenceBundle({
    attestations: bundle,
    expected: SCOPE,
    verifier: fixture.verifier
  });

  assert.equal(result.verified, false);
  assert.equal(result.reason, "provider-attestation-rejected");
  assert.equal(result.detail, "signature-invalid");
});

test("rejects evidence bound to a different asset, incident, policy revision or policy hash", () => {
  const fixture = createFixture();
  for (const expected of [
    { ...SCOPE, assetId: "host-02" },
    { ...SCOPE, incidentId: "incident-02" },
    { ...SCOPE, policyRevision: 8 },
    { ...SCOPE, policyHash: "c".repeat(64) }
  ]) {
    const result = verifyA2ProviderEvidenceBundle({
      attestations: fixture.makeBundle(),
      expected,
      verifier: fixture.verifier
    });
    assert.equal(result.verified, false);
    assert.equal(result.detail, "scope-mismatch");
  }
});

test("rejects stale, expired, future-dated and overlong attestations", () => {
  const fixture = createFixture();
  const stale = fixture.makeBundle({
    "policy-authority": {
      issuedAtMs: NOW - 60_000,
      expiresAtMs: NOW + 10_000
    }
  });
  assert.equal(verifyA2ProviderEvidenceBundle({
    attestations: stale, expected: SCOPE, verifier: fixture.verifier
  }).verified, false);

  const expired = fixture.makeBundle({
    "policy-authority": {
      issuedAtMs: NOW - 10_000,
      expiresAtMs: NOW
    }
  });
  assert.equal(verifyA2ProviderEvidenceBundle({
    attestations: expired, expected: SCOPE, verifier: fixture.verifier
  }).verified, false);

  const future = fixture.makeBundle({
    "policy-authority": {
      issuedAtMs: NOW + 10_000,
      expiresAtMs: NOW + 20_000
    }
  });
  assert.equal(verifyA2ProviderEvidenceBundle({
    attestations: future, expected: SCOPE, verifier: fixture.verifier
  }).verified, false);

  const longLifetime = fixture.makeBundle({
    "policy-authority": {
      issuedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 120_000
    }
  });
  assert.equal(verifyA2ProviderEvidenceBundle({
    attestations: longLifetime, expected: SCOPE, verifier: fixture.verifier
  }).verified, false);
});

test("rejects unknown, inactive, substituted and rolled-back provider keys", () => {
  const unknown = createFixture();
  const unknownBundle = unknown.makeBundle();
  unknown.keys.delete("key-policy-authority");
  assert.equal(verifyA2ProviderEvidenceBundle({
    attestations: unknownBundle, expected: SCOPE, verifier: unknown.verifier
  }).verified, false);

  const inactive = createFixture();
  inactive.keys.set("key-policy-authority", {
    ...inactive.keys.get("key-policy-authority"),
    keyVersion: 2,
    status: "revoked"
  });
  const revokedBundle = inactive.makeBundle({
    "policy-authority": { keyVersion: 2 }
  });
  assert.equal(verifyA2ProviderEvidenceBundle({
    attestations: revokedBundle, expected: SCOPE, verifier: inactive.verifier
  }).verified, false);

  const rollback = createFixture();
  const originalKey = rollback.keys.get("key-policy-authority");
  rollback.keys.set("key-policy-authority", {
    ...originalKey,
    keyVersion: 2
  });
  assert.equal(rollback.verifier.verify(
    rollback.makeAttestation("policy-authority", { keyVersion: 2 }), SCOPE
  ).verified, true);
  rollback.keys.set("key-policy-authority", originalKey);
  assert.equal(rollback.verifier.verify(
    rollback.makeAttestation("policy-authority", { keyVersion: 1 }), SCOPE
  ).verified, false);
});

test("rejects a containment provider that also claims to independently verify its own work", () => {
  const fixture = createFixture({
    providerOverrides: {
      "containment-provider": "same-provider",
      "containment-verifier": "same-provider"
    }
  });
  const result = verifyA2ProviderEvidenceBundle({
    attestations: fixture.makeBundle(),
    expected: SCOPE,
    verifier: fixture.verifier
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, "containment-verifier-must-be-independent");
});

test("rejects missing, duplicate, sparse and accessor-based bundle entries", () => {
  const fixture = createFixture();
  const full = fixture.makeBundle();

  assert.equal(verifyA2ProviderEvidenceBundle({
    attestations: full.slice(0, 4), expected: SCOPE, verifier: fixture.verifier
  }).verified, false);

  const duplicate = [...full];
  duplicate[4] = { ...duplicate[3] };
  assert.equal(verifyA2ProviderEvidenceBundle({
    attestations: duplicate, expected: SCOPE, verifier: fixture.verifier
  }).reason, "missing-or-duplicate-provider-role");

  const sparse = new Array(5);
  sparse[0] = full[0];
  sparse[1] = full[1];
  sparse[2] = full[2];
  sparse[3] = full[3];
  assert.equal(verifyA2ProviderEvidenceBundle({
    attestations: sparse, expected: SCOPE, verifier: fixture.verifier
  }).reason, "invalid-provider-evidence-bundle");

  const accessor = [...full];
  Object.defineProperty(accessor, "4", {
    enumerable: true,
    get() { return full[4]; }
  });
  assert.equal(verifyA2ProviderEvidenceBundle({
    attestations: accessor, expected: SCOPE, verifier: fixture.verifier
  }).reason, "invalid-provider-evidence-bundle");
});

test("rejects unsigned extra fields, malformed evidence references and untrusted verifier objects", () => {
  const fixture = createFixture();
  const extra = fixture.makeBundle();
  extra[0].unreviewed = true;
  assert.equal(fixture.verifier.verify(extra[0], SCOPE).verified, false);

  const badRef = fixture.makeAttestation("policy-authority", {
    evidenceRefs: [{ refId: "artifact:bad", sha256: "not-a-hash" }]
  });
  assert.equal(fixture.verifier.verify(badRef, SCOPE).verified, false);

  const result = verifyA2ProviderEvidenceBundle({
    attestations: fixture.makeBundle(),
    expected: SCOPE,
    verifier: { verify: () => ({ verified: true }) }
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, "invalid-provider-evidence-bundle");
});

test("fails closed when provider key resolution is asynchronous or unavailable", () => {
  const fixture = createFixture();
  const asyncVerifier = createProviderEvidenceVerifier({
    resolveTrustedProviderKey: async (keyId) => fixture.keys.get(keyId),
    clock: () => NOW
  });
  assert.equal(asyncVerifier.verify(
    fixture.makeAttestation("policy-authority"), SCOPE
  ).verified, false);
  assert.equal(asyncVerifier.getObservedKeyVersion("missing-key"), null);
});
