import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  A3_PROVIDER_EVIDENCE_ROLES,
  createA3ProviderEvidenceSigningPayload,
  createA3ProviderEvidenceVerifier,
  evaluateA3ProviderReadiness,
  verifyA3EvidenceReferences,
  verifyA3ProviderEvidenceBundle
} from "../src/provider-evidence-a3.js";

const NOW = 1_800_000_000_000;
const SCOPE = Object.freeze({
  assetId: "service-01",
  environment: "staging",
  incidentId: "incident-a3-01",
  policyId: "continuity-policy",
  policyRevision: 9,
  policyHash: "a".repeat(64),
  sourceId: "writer-primary-01",
  targetId: "writer-standby-02",
  leaseId: "lease-a3-01",
  fencingEpoch: 41,
  rpoMs: 30_000
});

const ROLE_FACTS = Object.freeze({
  "external-monitor": { independentExternalMonitor: true, monitorQuorum: true },
  "coordination-authority": {
    durableCoordination: true, exclusiveUnexpiredLease: true, monotonicFencing: true
  },
  "source-fencing-provider": { sourceFenced: true },
  "target-fencing-verifier": { targetEnforcesFencing: true, staleEpochRejected: true },
  "replication-verifier": { replicationHealthy: true, replicationWithinRpo: true },
  "target-readiness-verifier": { targetReady: true, dependenciesReady: true },
  "traffic-provider": { trafficCutoverPrepared: true, rollbackPrepared: true },
  "failover-verifier": { postFailoverVerification: true },
  "budget-authority": { budgetAvailable: true }
});

function createFixture({ providerOverrides = {} } = {}) {
  const keys = new Map();
  const privateKeys = new Map();
  for (const role of A3_PROVIDER_EVIDENCE_ROLES) {
    const pair = generateKeyPairSync("ed25519");
    const keyId = "key-" + role;
    const providerId = providerOverrides[role] ?? "provider-" + role;
    keys.set(keyId, {
      schema: "jb.resilience.provider-trust-key/v1",
      keyId,
      keyVersion: 1,
      algorithm: "Ed25519",
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
      providerId,
      role,
      status: "active",
      notBeforeMs: NOW - 60_000,
      expiresAtMs: NOW + 600_000,
      capabilities: ["A3-controlled-failover"]
    });
    privateKeys.set(keyId, pair.privateKey);
  }
  const verifier = createA3ProviderEvidenceVerifier({
    resolveTrustedProviderKey: (keyId) => keys.get(keyId),
    clock: () => NOW
  });

  function makeAttestation(role, overrides = {}) {
    const keyId = "key-" + role;
    const trustedKey = keys.get(keyId);
    const bytes = Buffer.from("authoritative-a3-artifact:" + role, "utf8");
    const unsigned = {
      schema: "jb.resilience.a3-provider-evidence/v1",
      attestationId: "attestation-" + role,
      providerId: trustedKey.providerId,
      role,
      capability: "A3-controlled-failover",
      ...SCOPE,
      issuedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 10_000,
      keyId,
      keyVersion: 1,
      algorithm: "Ed25519",
      facts: { ...ROLE_FACTS[role] },
      evidenceRefs: [{
        refId: "a3-artifact:" + role,
        sha256: createHash("sha256").update(bytes).digest("hex")
      }],
      ...overrides
    };
    const payload = createA3ProviderEvidenceSigningPayload(unsigned);
    const signature = sign(null, Buffer.from(payload, "utf8"), privateKeys.get(keyId))
      .toString("base64url");
    return { ...unsigned, signature };
  }

  function makeBundle(overridesByRole = {}) {
    return A3_PROVIDER_EVIDENCE_ROLES.map((role) =>
      makeAttestation(role, overridesByRole[role] ?? {})
    );
  }

  return { keys, verifier, makeAttestation, makeBundle };
}

function createReferenceFixture({ factsByRole = {} } = {}) {
  const fixture = createFixture();
  const artifacts = new Map();
  const overrides = {};
  for (const role of A3_PROVIDER_EVIDENCE_ROLES) {
    const refId = "a3-artifact:" + role;
    const bytes = Buffer.from("verified-a3-evidence:" + role, "utf8");
    artifacts.set(refId, bytes);
    overrides[role] = {
      ...(factsByRole[role] ? { facts: factsByRole[role] } : {}),
      evidenceRefs: [{
        refId,
        sha256: createHash("sha256").update(bytes).digest("hex")
      }]
    };
  }
  const bundle = verifyA3ProviderEvidenceBundle({
    attestations: fixture.makeBundle(overrides),
    expected: SCOPE,
    verifier: fixture.verifier
  });
  return { bundle, artifacts };
}

function resolverFor(artifacts, transform = (input, bytes) => bytes) {
  return async (input) => ({
    providerId: input.providerId,
    role: input.role,
    ...SCOPE,
    bytes: transform(input, artifacts.get(input.refId))
  });
}

test("verifies nine role-scoped A3 attestations tied to one exact source, target, lease and fencing epoch", () => {
  const fixture = createFixture();
  const result = verifyA3ProviderEvidenceBundle({
    attestations: fixture.makeBundle(),
    expected: SCOPE,
    verifier: fixture.verifier
  });
  assert.equal(result.verified, true);
  assert.equal(result.executable, false);
  assert.equal(result.providers.length, 9);
  assert.equal(result.scope.sourceId, SCOPE.sourceId);
  assert.equal(result.scope.targetId, SCOPE.targetId);
  assert.equal(result.scope.leaseId, SCOPE.leaseId);
  assert.equal(result.scope.fencingEpoch, SCOPE.fencingEpoch);
  assert.equal(result.facts.targetEnforcesFencing, true);
  assert.equal(result.facts.replicationWithinRpo, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.facts), true);
});

test("a signed false A3 predicate remains false and cannot be upgraded by the bundle verifier", () => {
  const fixture = createFixture();
  const result = verifyA3ProviderEvidenceBundle({
    attestations: fixture.makeBundle({
      "target-fencing-verifier": {
        facts: { targetEnforcesFencing: true, staleEpochRejected: false }
      }
    }),
    expected: SCOPE,
    verifier: fixture.verifier
  });
  assert.equal(result.verified, true);
  assert.equal(result.facts.staleEpochRejected, false);
  assert.equal(result.executable, false);
});

test("rejects mismatched source, target, lease, fencing epoch, policy and stale attestations", () => {
  for (const [field, value] of [
    ["sourceId", "other-source"],
    ["targetId", "other-target"],
    ["leaseId", "other-lease"],
    ["fencingEpoch", SCOPE.fencingEpoch + 1],
    ["policyRevision", SCOPE.policyRevision + 1],
    ["policyHash", "b".repeat(64)]
  ]) {
    const fixture = createFixture();
    const bundle = fixture.makeBundle();
    bundle[0] = fixture.makeAttestation("external-monitor", { [field]: value });
    const result = verifyA3ProviderEvidenceBundle({
      attestations: bundle, expected: SCOPE, verifier: fixture.verifier
    });
    assert.equal(result.verified, false, field);
  }

  const stale = createFixture();
  const expired = stale.makeBundle();
  expired[0] = stale.makeAttestation("external-monitor", {
    issuedAtMs: NOW - 60_000, expiresAtMs: NOW + 1_000
  });
  const staleResult = verifyA3ProviderEvidenceBundle({
    attestations: expired, expected: SCOPE, verifier: stale.verifier
  });
  assert.equal(staleResult.verified, false);
});

test("rejects invalid signature, revoked key, missing roles and key substitution", () => {
  const fixture = createFixture();
  const tampered = fixture.makeBundle();
  tampered[0].facts.monitorQuorum = false;
  assert.equal(verifyA3ProviderEvidenceBundle({
    attestations: tampered, expected: SCOPE, verifier: fixture.verifier
  }).verified, false);

  const missing = createFixture();
  assert.equal(verifyA3ProviderEvidenceBundle({
    attestations: missing.makeBundle().slice(0, 8),
    expected: SCOPE, verifier: missing.verifier
  }).reason, "invalid-provider-evidence-bundle");

  const revoked = createFixture();
  revoked.keys.set("key-external-monitor", {
    ...revoked.keys.get("key-external-monitor"),
    status: "revoked",
    keyVersion: 2
  });
  const revokedBundle = revoked.makeBundle({
    "external-monitor": { keyVersion: 2 }
  });
  assert.equal(verifyA3ProviderEvidenceBundle({
    attestations: revokedBundle, expected: SCOPE, verifier: revoked.verifier
  }).verified, false);
});

test("requires independent traffic execution, failover verification and fencing-provider identities", () => {
  for (const overrides of [
    { "traffic-provider": "same", "failover-verifier": "same" },
    { "source-fencing-provider": "same", "target-fencing-verifier": "same" },
    { "coordination-authority": "same", "failover-verifier": "same" }
  ]) {
    const fixture = createFixture({ providerOverrides: overrides });
    const result = verifyA3ProviderEvidenceBundle({
      attestations: fixture.makeBundle(),
      expected: SCOPE,
      verifier: fixture.verifier
    });
    assert.equal(result.verified, false);
    assert.equal(result.reason, "independent-provider-identity-required");
  }
});

test("external monitor identity cannot be the failed source or failover target", () => {
  for (const endpoint of [SCOPE.sourceId, SCOPE.targetId]) {
    const fixture = createFixture({
      providerOverrides: { "external-monitor": endpoint }
    });
    const result = verifyA3ProviderEvidenceBundle({
      attestations: fixture.makeBundle(),
      expected: SCOPE,
      verifier: fixture.verifier
    });
    assert.equal(result.verified, false);
    assert.equal(result.reason, "external-monitor-must-be-outside-failover-endpoints");
  }
});

test("rejects arbitrary verifier objects, invalid scope and unsupported attestation fields", () => {
  const fixture = createFixture();
  const forged = verifyA3ProviderEvidenceBundle({
    attestations: fixture.makeBundle(),
    expected: SCOPE,
    verifier: { verify: () => ({ verified: true }) }
  });
  assert.equal(forged.verified, false);

  const wrongScope = verifyA3ProviderEvidenceBundle({
    attestations: fixture.makeBundle(),
    expected: { ...SCOPE, sourceId: SCOPE.targetId },
    verifier: fixture.verifier
  });
  assert.equal(wrongScope.verified, false);

  const extra = fixture.makeBundle();
  extra[0].unreviewed = true;
  assert.equal(fixture.verifier.verify(extra[0], SCOPE).verified, false);
});

test("verifies all A3 evidence references with exact scope and SHA-256", async () => {
  const { bundle, artifacts } = createReferenceFixture();
  const result = await verifyA3EvidenceReferences({
    bundle,
    resolveEvidenceReference: resolverFor(artifacts),
    clock: () => NOW
  });
  assert.equal(result.verified, true);
  assert.equal(result.executable, false);
  assert.equal(result.referenceCount, 9);
  assert.equal(result.totalBytes, [...artifacts.values()].reduce((sum, item) => sum + item.length, 0));
});

test("A3 evidence reference verifier rejects digest tampering, wrong scope and resolver outage", async () => {
  const { bundle, artifacts } = createReferenceFixture();
  const tampered = await verifyA3EvidenceReferences({
    bundle,
    resolveEvidenceReference: resolverFor(artifacts, (input, bytes) =>
      input.role === "target-fencing-verifier" ? Buffer.from("stale-fence-proof") : bytes
    ),
    clock: () => NOW
  });
  assert.equal(tampered.verified, false);
  assert.equal(tampered.reason, "evidence-reference-digest-mismatch");

  const wrongScope = await verifyA3EvidenceReferences({
    bundle,
    resolveEvidenceReference: async (input) => ({
      providerId: input.providerId,
      role: input.role,
      ...SCOPE,
      targetId: "other-target",
      bytes: artifacts.get(input.refId)
    }),
    clock: () => NOW
  });
  assert.equal(wrongScope.verified, false);
  assert.equal(wrongScope.reason, "evidence-reference-scope-mismatch");

  const unavailable = await verifyA3EvidenceReferences({
    bundle,
    resolveEvidenceReference: async () => { throw new Error("provider detail"); },
    clock: () => NOW
  });
  assert.equal(unavailable.verified, false);
  assert.equal(unavailable.reason, "evidence-reference-unavailable");
});

test("A3 evidence references reject forged bundles, stale evidence, size overflow and slow resolvers", async () => {
  const { bundle, artifacts } = createReferenceFixture();
  const forged = await verifyA3EvidenceReferences({
    bundle: { ...bundle },
    resolveEvidenceReference: resolverFor(artifacts),
    clock: () => NOW
  });
  assert.equal(forged.verified, false);
  assert.equal(forged.reason, "invalid-evidence-reference-verification-input");

  const stale = await verifyA3EvidenceReferences({
    bundle,
    resolveEvidenceReference: resolverFor(artifacts),
    clock: () => bundle.expiresAtMs
  });
  assert.equal(stale.verified, false);
  assert.equal(stale.reason, "provider-evidence-stale-or-expired");

  const tooSmall = await verifyA3EvidenceReferences({
    bundle,
    resolveEvidenceReference: resolverFor(artifacts),
    clock: () => NOW,
    maxReferenceBytes: 5
  });
  assert.equal(tooSmall.verified, false);
  assert.equal(tooSmall.reason, "evidence-reference-size-limit-exceeded");

  let aborted = false;
  const timeout = await verifyA3EvidenceReferences({
    bundle,
    resolveEvidenceReference: ({ signal }) => new Promise(() => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    }),
    clock: () => NOW,
    timeoutMs: 100
  });
  assert.equal(timeout.verified, false);
  assert.equal(timeout.reason, "evidence-reference-timeout");
  assert.equal(aborted, true);
});

test("A3 evidence references reject evidence that expires while provider retrieval is pending", async () => {
  const { bundle, artifacts } = createReferenceFixture();
  let calls = 0;
  const result = await verifyA3EvidenceReferences({
    bundle,
    resolveEvidenceReference: resolverFor(artifacts),
    clock: () => ++calls === 1 ? NOW : bundle.expiresAtMs
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, "provider-evidence-stale-or-expired");
});


test("A3 signed evidence and matching reference verification feed ARC readiness without authorizing failover", async () => {
  const { bundle, artifacts } = createReferenceFixture();
  const references = await verifyA3EvidenceReferences({
    bundle,
    resolveEvidenceReference: resolverFor(artifacts),
    clock: () => NOW
  });
  const readiness = evaluateA3ProviderReadiness({
    bundle,
    references,
    clock: () => NOW
  });
  assert.equal(readiness.eligible, true);
  assert.deepEqual(readiness.denied, []);
  assert.equal(readiness.executable, false);
});

test("A3 ARC readiness preserves signed false facts and rejects forged or mismatched reference results", async () => {
  const { bundle, artifacts } = createReferenceFixture({
    factsByRole: {
      "target-fencing-verifier": {
        targetEnforcesFencing: true,
        staleEpochRejected: false
      }
    }
  });
  const references = await verifyA3EvidenceReferences({
    bundle,
    resolveEvidenceReference: resolverFor(artifacts),
    clock: () => NOW
  });
  const readiness = evaluateA3ProviderReadiness({
    bundle,
    references,
    clock: () => NOW
  });
  assert.equal(readiness.eligible, false);
  assert.ok(readiness.denied.includes("targetEnforcesFencing") === false);
  // The gate maps target enforcement, while the extra stale-write probe is a separate hard certification invariant.
  assert.equal(readiness.executable, false);

  const forged = evaluateA3ProviderReadiness({
    bundle: { ...bundle },
    references,
    clock: () => NOW
  });
  assert.equal(forged.eligible, false);

  const other = createReferenceFixture();
  const otherReferences = await verifyA3EvidenceReferences({
    bundle: other.bundle,
    resolveEvidenceReference: resolverFor(other.artifacts),
    clock: () => NOW
  });
  const mismatch = evaluateA3ProviderReadiness({
    bundle,
    references: otherReferences,
    clock: () => NOW
  });
  assert.equal(mismatch.eligible, false);
  assert.equal(mismatch.reason, "verified-a3-bundle-and-matching-reference-check-required");
});
