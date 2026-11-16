import test from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as signBytes
} from "node:crypto";
import {
  computeAdvancedPolicyHash,
  createAdvancedPolicySigningPayload,
  createMemoryCapabilityLedger,
  createMemoryPolicyRevisionStore
} from "../src/policy-engine.js";
import {
  createEd25519PolicySignatureVerifier,
  createResilienceIdentityPolicyBridge
} from "../src/adapters/identity-policy-bridge.js";

const NOW = Date.parse("2026-11-16T22:00:00.000Z");
const POLICY_ID = "jb-resilience-identity-test";
const KEY_ID = "jb-policy-owner-test-01";
const REQUEST = Object.freeze({
  assetId: "catalog-api-01",
  environment: "production",
  incidentId: "incident-identity-001",
  action: "restart-service",
  securityState: "clear",
  health: { consecutiveFailures: 3, lastRestartAt: null }
});

function makePolicy(keyPair) {
  const policy = {
    schema: "jb.resilience.policy/v2",
    policyId: POLICY_ID,
    revision: 1,
    mode: "autonomous-advanced",
    validity: {
      notBefore: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z"
    },
    signature: {
      keyId: KEY_ID,
      algorithm: "Ed25519",
      value: "pending-signature"
    },
    policyHash: "0".repeat(64),
    defaults: {
      decision: "deny",
      unknownSignal: "hold-and-escalate",
      staleSignal: "hold-and-escalate",
      ledgerUnavailable: "block-mutations",
      policyInvalid: "block-mutations",
      preserveEvidence: true,
      requireDurableAudit: true
    },
    budgets: {
      maxConcurrentActionsPerIncident: 1,
      maxActionsPerIncident: 3,
      maxActionsPerAssetPerHour: 2,
      maxAutomaticContainmentsPerIncident: 1
    },
    services: [{
      id: REQUEST.assetId,
      environment: REQUEST.environment,
      tier: "stateless",
      criticality: "standard",
      allowedActions: ["restart-service"],
      recovery: {
        failureThreshold: 3,
        maxRestartsPerHour: 2,
        cooldownMs: 300_000,
        requireApplicationHealth: true
      },
      containmentProfile: null,
      failoverProfile: null
    }]
  };

  const signingPayload = createAdvancedPolicySigningPayload(policy);
  policy.signature.value = signBytes(
    null, Buffer.from(signingPayload, "utf8"), keyPair.privateKey
  ).toString("base64url");
  policy.policyHash = computeAdvancedPolicyHash(policy);
  return { policy, signingPayload };
}

function makeFixture(options = {}) {
  const keyPair = generateKeyPairSync("ed25519");
  const { policy, signingPayload } = makePolicy(keyPair);
  const trustedKey = {
    schema: "jb.resilience.policy-trust-key/v1",
    keyId: KEY_ID,
    keyVersion: 1,
    algorithm: "Ed25519",
    publicKeyPem: keyPair.publicKey.export({
      type: "spki", format: "pem"
    }).toString(),
    principalId: "owner-resilience",
    role: "policy-owner",
    status: "active",
    notBefore: NOW - 60_000,
    expiresAt: NOW + 60 * 60 * 1000,
    policyIds: [POLICY_ID],
    ...options
  };
  const context = {
    policy,
    signature: { ...policy.signature },
    policyHash: policy.policyHash,
    signingPayload
  };
  return { keyPair, policy, trustedKey, context };
}

function verifierFor(resolveTrustedKey) {
  return createEd25519PolicySignatureVerifier({
    resolveTrustedKey,
    clock: () => NOW
  });
}

test("verifies a real Ed25519 policy signature against a well-formed PEM key", () => {
  const fixture = makeFixture();
  const verifier = verifierFor(() => fixture.trustedKey);
  assert.equal(verifier.verifyPolicySignature(fixture.context), true);
  assert.equal(verifier.getObservedKeyVersion(KEY_ID), 1);
});

test("rejects a tampered policy signature and mismatched signature context", () => {
  const fixture = makeFixture();
  const verifier = verifierFor(() => fixture.trustedKey);
  const tamperedPayload = {
    ...fixture.context,
    signingPayload: fixture.context.signingPayload + " "
  };
  assert.equal(verifier.verifyPolicySignature(tamperedPayload), false);

  const mismatchedSignature = {
    ...fixture.context,
    signature: { ...fixture.context.signature, value: "A".repeat(86) }
  };
  assert.equal(verifier.verifyPolicySignature(mismatchedSignature), false);
});

test("rejects malformed PEM, non-Ed25519 keys and asynchronous key resolvers", () => {
  const fixture = makeFixture();
  const malformedPem = verifierFor(() => ({
    ...fixture.trustedKey,
    publicKeyPem: "not-a-PEM-public-key"
  }));
  assert.equal(malformedPem.verifyPolicySignature(fixture.context), false);

  const wrongAlgorithm = verifierFor(() => ({
    ...fixture.trustedKey,
    algorithm: "RSA"
  }));
  assert.equal(wrongAlgorithm.verifyPolicySignature(fixture.context), false);

  const asyncResolver = verifierFor(() => Promise.resolve(fixture.trustedKey));
  assert.equal(asyncResolver.verifyPolicySignature(fixture.context), false);
});

test("enforces role, status, policy scope and key validity window", () => {
  const fixture = makeFixture();
  const cases = [
    [{ ...fixture.trustedKey, role: "operator" }, "wrong role"],
    [{ ...fixture.trustedKey, status: "revoked" }, "revoked key"],
    [{ ...fixture.trustedKey, status: "suspended" }, "suspended key"],
    [{ ...fixture.trustedKey, policyIds: ["other-policy"] }, "wrong policy scope"],
    [{ ...fixture.trustedKey, notBefore: NOW + 1 }, "not-yet-valid key"],
    [{ ...fixture.trustedKey, expiresAt: NOW }, "expired key"]
  ];
  for (const [key, label] of cases) {
    assert.equal(
      verifierFor(() => key).verifyPolicySignature(fixture.context),
      false,
      label
    );
  }
});

test("same-version authority metadata substitution is rejected", () => {
  for (const mutate of [
    (key) => ({ ...key, status: "revoked" }),
    (key) => ({ ...key, expiresAt: key.expiresAt + 1 }),
    (key) => ({ ...key, notBefore: key.notBefore + 1 }),
    (key) => ({ ...key, role: "operator" }),
    (key) => ({ ...key, principalId: "different-owner" }),
    (key) => ({ ...key, policyIds: ["other-policy"] }),
    (key) => ({ ...key, algorithm: "RSA" })
  ]) {
    const fixture = makeFixture();
    let currentKey = fixture.trustedKey;
    const verifier = verifierFor(() => currentKey);
    assert.equal(verifier.verifyPolicySignature(fixture.context), true);
    currentKey = mutate(currentKey);
    assert.equal(verifier.verifyPolicySignature(fixture.context), false);
  }
});

test("a newer revocation is remembered and a stale active key version cannot roll it back", () => {
  const fixture = makeFixture();
  let currentKey = fixture.trustedKey;
  const verifier = verifierFor(() => currentKey);

  assert.equal(verifier.verifyPolicySignature(fixture.context), true);
  currentKey = { ...fixture.trustedKey, keyVersion: 2, status: "revoked" };
  assert.equal(verifier.verifyPolicySignature(fixture.context), false);
  assert.equal(verifier.getObservedKeyVersion(KEY_ID), 2);

  currentKey = fixture.trustedKey;
  assert.equal(verifier.verifyPolicySignature(fixture.context), false);
  assert.equal(verifier.getObservedKeyVersion(KEY_ID), 2);
});

test("bridge delegates policy evaluation and one-time authorization to the existing policy engine", async () => {
  const fixture = makeFixture();
  const policyRevisionStore = createMemoryPolicyRevisionStore();
  const capabilityLedger = createMemoryCapabilityLedger();
  assert.equal(policyRevisionStore.setCurrentPolicy({
    policyId: fixture.policy.policyId,
    revision: fixture.policy.revision,
    policyHash: fixture.policy.policyHash
  }), true);

  const bridge = createResilienceIdentityPolicyBridge({
    policy: fixture.policy,
    resolveTrustedKey: () => fixture.trustedKey,
    policyRevisionStore,
    capabilityLedger,
    allowInMemoryStores: true,
    clock: () => NOW
  });

  assert.equal(bridge.engine, "JB Resilience Identity & Policy Bridge");
  assert.equal(bridge.evaluate(REQUEST).permitted, true);
  const authorization = await bridge.authorize(REQUEST);
  assert.equal(authorization.authorized, true);
  assert.equal((await bridge.assertAuthorization({
    authorization: authorization.authorization,
    request: REQUEST
  })).valid, true);
  assert.deepEqual(await bridge.completeAuthorization({
    authorization: authorization.authorization,
    outcome: "succeeded"
  }), { recorded: true, reason: null });
  assert.deepEqual(await bridge.completeAuthorization({
    authorization: authorization.authorization,
    outcome: "succeeded"
  }), {
    recorded: false,
    reason: "unknown-or-consumed-authorization"
  });
});
