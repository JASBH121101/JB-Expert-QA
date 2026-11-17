import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign
} from "node:crypto";
import {
  A2_PROVIDER_EVIDENCE_ROLES,
  createProviderEvidenceSigningPayload,
  createProviderEvidenceVerifier,
  evaluateA2ProviderReadiness,
  verifyA2EvidenceReferences,
  verifyA2ProviderEvidenceBundle
} from "../src/provider-evidence.js";
import {
  createMemoryTrustedSignalStore,
  createTrustedSignalGateway,
  signTrustedSignalEnvelope
} from "../src/trusted-signal-gateway.js";

const NOW = 1_800_000_000_000;
const ASSET = "host-a2-01";
const ENVIRONMENT = "test";
const INCIDENT = "incident-a2-01";
const POLICY = Object.freeze({
  assetId: ASSET,
  environment: ENVIRONMENT,
  incidentId: INCIDENT,
  policyId: "containment-policy",
  policyRevision: 3,
  policyHash: "a".repeat(64)
});
const GUARD_KEY = "unit-test-security-guard-secret-at-least-32-bytes";
const MALWARE_KEY = "unit-test-malware-engine-secret-at-least-32-bytes";

function createGateway({ durable = true, clock = () => NOW } = {}) {
  const memory = createMemoryTrustedSignalStore();
  // This wrapper exercises the durable-store trust boundary. The actual file
  // and PostgreSQL durability contracts are certified by their own test suites.
  const replayStore = durable ? Object.freeze({
    durable: true,
    recordSignal: memory.recordSignal.bind(memory),
    listSignals: memory.listSignals.bind(memory)
  }) : memory;
  const gateway = createTrustedSignalGateway({
    sources: [
      {
        sourceId: "guard-provider",
        engine: "security-guard",
        environment: ENVIRONMENT,
        assetIds: [ASSET],
        key: GUARD_KEY
      },
      {
        sourceId: "malware-provider",
        engine: "malware-engine",
        environment: ENVIRONMENT,
        assetIds: [ASSET],
        key: MALWARE_KEY
      }
    ],
    replayStore,
    requireDurableStore: false,
    allowInMemoryStore: true,
    clock
  });
  return { gateway, replayStore };
}

async function getConfirmedSignalState(gateway) {
  const signals = [
    {
      sourceId: "guard-provider",
      sourceEngine: "security-guard",
      signingKey: GUARD_KEY
    },
    {
      sourceId: "malware-provider",
      sourceEngine: "malware-engine",
      signingKey: MALWARE_KEY
    }
  ];
  for (const [index, source] of signals.entries()) {
    const signal = signTrustedSignalEnvelope({
      schema: "jb.resilience.trusted-signal/v1",
      eventId: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
      sourceId: source.sourceId,
      sourceEngine: source.sourceEngine,
      environment: ENVIRONMENT,
      assetId: ASSET,
      issuedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 20_000,
      state: "confirmed",
      severity: "critical",
      reasonCode: "THREAT_CONFIRMED",
      evidenceRefs: [{
        refId: "signal-evidence:" + source.sourceId,
        sha256: "b".repeat(64)
      }]
    }, source.signingKey);
    assert.equal((await gateway.ingest(signal)).accepted, true);
  }
  return gateway.getSecurityState({ assetId: ASSET, environment: ENVIRONMENT });
}

function createProviderBundle({ reversibleAdapter = true } = {}) {
  const keys = new Map();
  const privateKeys = new Map();
  const roleFacts = {
    "policy-authority": { ownerApprovedProfile: true },
    "containment-provider": { reversibleAdapter, rollbackPlan: true },
    "containment-verifier": { independentContainmentVerification: true },
    "forensic-recorder": { forensicEvidencePreserved: true },
    "budget-authority": { budgetAvailable: true }
  };
  for (const role of A2_PROVIDER_EVIDENCE_ROLES) {
    const pair = generateKeyPairSync("ed25519");
    const keyId = "key-" + role;
    keys.set(keyId, {
      schema: "jb.resilience.provider-trust-key/v1",
      keyId,
      keyVersion: 1,
      algorithm: "Ed25519",
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
      providerId: "provider-" + role,
      role,
      status: "active",
      notBeforeMs: NOW - 60_000,
      expiresAtMs: NOW + 600_000,
      capabilities: ["A2-bounded-containment"]
    });
    privateKeys.set(keyId, pair.privateKey);
  }
  const verifier = createProviderEvidenceVerifier({
    resolveTrustedProviderKey: (keyId) => keys.get(keyId),
    clock: () => NOW
  });
  const artifacts = new Map();
  const attestations = A2_PROVIDER_EVIDENCE_ROLES.map((role) => {
    const trusted = keys.get("key-" + role);
    const bytes = Buffer.from("a2-evidence-artifact:" + role, "utf8");
    const evidenceRef = {
      refId: "provider-evidence:" + role,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
    artifacts.set(evidenceRef.refId, bytes);
    const unsigned = {
      schema: "jb.resilience.provider-evidence/v1",
      attestationId: "attestation-" + role,
      providerId: trusted.providerId,
      role,
      capability: "A2-bounded-containment",
      ...POLICY,
      issuedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 15_000,
      keyId: trusted.keyId,
      keyVersion: trusted.keyVersion,
      algorithm: "Ed25519",
      facts: roleFacts[role],
      evidenceRefs: [evidenceRef]
    };
    const payload = createProviderEvidenceSigningPayload(unsigned);
    return {
      ...unsigned,
      signature: sign(null, Buffer.from(payload, "utf8"), privateKeys.get(trusted.keyId))
        .toString("base64url")
    };
  });
  const bundle = verifyA2ProviderEvidenceBundle({
    attestations,
    expected: POLICY,
    verifier
  });
  return { bundle, artifacts };
}

async function verifyProviderReferences(bundle, artifacts, clock = () => NOW) {
  return verifyA2EvidenceReferences({
    bundle,
    resolveEvidenceReference: async (input) => ({
      providerId: input.providerId,
      role: input.role,
      ...POLICY,
      bytes: artifacts.get(input.refId)
    }),
    clock
  });
}

test("A2 ARC readiness requires genuine confirmed signal, durable replay and matching signed provider evidence", async () => {
  const { gateway } = createGateway({ durable: true });
  const securityState = await getConfirmedSignalState(gateway);
  const { bundle, artifacts } = createProviderBundle();
  const references = await verifyProviderReferences(bundle, artifacts);
  const result = evaluateA2ProviderReadiness({
    bundle,
    references,
    securityState,
    clock: () => NOW
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.denied, []);
  assert.equal(result.executable, false);
});

test("A2 readiness rejects a genuine Gateway result backed by an in-memory replay store", async () => {
  const { gateway } = createGateway({ durable: false });
  const securityState = await getConfirmedSignalState(gateway);
  const { bundle, artifacts } = createProviderBundle();
  const references = await verifyProviderReferences(bundle, artifacts);
  const result = evaluateA2ProviderReadiness({
    bundle,
    references,
    securityState,
    clock: () => NOW
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "durable-replay-protected-signal-required");
  assert.equal(result.executable, false);
});

test("A2 readiness rejects suspected signals, forged state objects and unverified provider references", async () => {
  const { gateway } = createGateway({ durable: true });
  const securityState = await getConfirmedSignalState(gateway);
  const { bundle, artifacts } = createProviderBundle();
  const references = await verifyProviderReferences(bundle, artifacts);
  const forged = evaluateA2ProviderReadiness({
    bundle,
    references,
    securityState: { ...securityState },
    clock: () => NOW
  });
  assert.equal(forged.eligible, false);

  const wrongReferences = evaluateA2ProviderReadiness({
    bundle,
    references: { ...references },
    securityState,
    clock: () => NOW
  });
  assert.equal(wrongReferences.eligible, false);

  const stale = evaluateA2ProviderReadiness({
    bundle,
    references,
    securityState,
    clock: () => NOW + 21_000
  });
  assert.equal(stale.eligible, false);
});

test("A2 ARC readiness preserves a signed false provider predicate as denied", async () => {
  const { gateway } = createGateway({ durable: true });
  const securityState = await getConfirmedSignalState(gateway);
  const { bundle, artifacts } = createProviderBundle({ reversibleAdapter: false });
  const references = await verifyProviderReferences(bundle, artifacts);
  const result = evaluateA2ProviderReadiness({
    bundle,
    references,
    securityState,
    clock: () => NOW
  });
  assert.equal(result.eligible, false);
  assert.ok(result.denied.includes("reversibleAdapter"));
  assert.equal(result.executable, false);
});
