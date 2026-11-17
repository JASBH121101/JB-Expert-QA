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
  verifyA2ProviderEvidenceBundle,
  createA2ContainmentController
} from "../src/index.js";
import {
  createMemoryTrustedSignalStore,
  createTrustedSignalGateway,
  signTrustedSignalEnvelope
} from "../src/trusted-signal-gateway.js";

const NOW = 1_800_000_000_000;
const SCOPE = Object.freeze({
  assetId: "endpoint-01",
  environment: "lab",
  incidentId: "incident-01",
  policyId: "containment-policy",
  policyRevision: 7,
  policyHash: "a".repeat(64)
});
const GUARD_KEY = "unit-test-security-guard-key-at-least-32-bytes";
const MALWARE_KEY = "unit-test-malware-engine-key-at-least-32-bytes";

async function createVerifiedReadiness() {
  const memoryStore = createMemoryTrustedSignalStore();
  const replayStore = Object.freeze({
    durable: true,
    recordSignal: memoryStore.recordSignal.bind(memoryStore),
    listSignals: memoryStore.listSignals.bind(memoryStore)
  });
  const gateway = createTrustedSignalGateway({
    sources: [
      {
        sourceId: "guard-source",
        engine: "security-guard",
        environment: SCOPE.environment,
        assetIds: [SCOPE.assetId],
        key: GUARD_KEY
      },
      {
        sourceId: "malware-source",
        engine: "malware-engine",
        environment: SCOPE.environment,
        assetIds: [SCOPE.assetId],
        key: MALWARE_KEY
      }
    ],
    replayStore,
    allowInMemoryStore: true,
    clock: () => NOW
  });

  for (const [index, source] of [
    { sourceId: "guard-source", sourceEngine: "security-guard", key: GUARD_KEY },
    { sourceId: "malware-source", sourceEngine: "malware-engine", key: MALWARE_KEY }
  ].entries()) {
    const signal = signTrustedSignalEnvelope({
      schema: "jb.resilience.trusted-signal/v1",
      eventId: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
      sourceId: source.sourceId,
      sourceEngine: source.sourceEngine,
      environment: SCOPE.environment,
      assetId: SCOPE.assetId,
      issuedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 60_000,
      state: "confirmed",
      severity: "critical",
      reasonCode: "THREAT_CONFIRMED",
      evidenceRefs: [{
        refId: "signal-" + source.sourceId,
        sha256: "b".repeat(64)
      }]
    }, source.key);
    assert.equal((await gateway.ingest(signal)).accepted, true);
  }
  const securityState = await gateway.getSecurityState({
    assetId: SCOPE.assetId,
    environment: SCOPE.environment
  });

  const roleFacts = {
    "policy-authority": { ownerApprovedProfile: true },
    "containment-provider": { reversibleAdapter: true, rollbackPlan: true },
    "containment-verifier": { independentContainmentVerification: true },
    "forensic-recorder": { forensicEvidencePreserved: true },
    "budget-authority": { budgetAvailable: true }
  };
  const trustedKeys = new Map();
  const privateKeys = new Map();
  for (const role of A2_PROVIDER_EVIDENCE_ROLES) {
    const pair = generateKeyPairSync("ed25519");
    const keyId = "key-" + role;
    trustedKeys.set(keyId, {
      schema: "jb.resilience.provider-trust-key/v1",
      keyId,
      keyVersion: 1,
      algorithm: "Ed25519",
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
      providerId: "evidence-" + role,
      role,
      status: "active",
      notBeforeMs: NOW - 60_000,
      expiresAtMs: NOW + 300_000,
      capabilities: ["A2-bounded-containment"]
    });
    privateKeys.set(keyId, pair.privateKey);
  }
  const verifier = createProviderEvidenceVerifier({
    resolveTrustedProviderKey: (keyId) => trustedKeys.get(keyId),
    clock: () => NOW
  });
  const artifacts = new Map();
  const attestations = A2_PROVIDER_EVIDENCE_ROLES.map((role) => {
    const trusted = trustedKeys.get("key-" + role);
    const bytes = Buffer.from("a2-artifact:" + role, "utf8");
    const evidenceRef = {
      refId: "evidence-" + role,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
    artifacts.set(evidenceRef.refId, bytes);
    const unsigned = {
      schema: "jb.resilience.provider-evidence/v1",
      attestationId: "attestation-" + role,
      providerId: trusted.providerId,
      role,
      capability: "A2-bounded-containment",
      ...SCOPE,
      issuedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 45_000,
      keyId: trusted.keyId,
      keyVersion: trusted.keyVersion,
      algorithm: "Ed25519",
      facts: roleFacts[role],
      evidenceRefs: [evidenceRef]
    };
    return {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(createProviderEvidenceSigningPayload(unsigned), "utf8"),
        privateKeys.get(trusted.keyId)
      ).toString("base64url")
    };
  });
  const bundle = verifyA2ProviderEvidenceBundle({
    attestations, expected: SCOPE, verifier
  });
  const references = await verifyA2EvidenceReferences({
    bundle,
    resolveEvidenceReference: async (input) => ({
      providerId: input.providerId,
      role: input.role,
      ...SCOPE,
      bytes: artifacts.get(input.refId)
    }),
    clock: () => NOW
  });
  const readiness = evaluateA2ProviderReadiness({
    bundle, references, securityState, clock: () => NOW
  });
  assert.equal(readiness.eligible, true);
  assert.equal(readiness.executable, false);
  return {
    readiness,
    evidenceRefs: references.references.map(({ refId, sha256 }) => ({ refId, sha256 }))
  };
}

function createDependencies({
  applyOutcome = "applied",
  reconcileOutcome = "unknown",
  verificationState = "contained",
  releaseOutcome = "released",
  releaseVerificationState = "released",
  blockMutationAt = null,
  denyAuthorization = false,
  auditFails = false,
  forensicValid = true,
  mutationTimeout = false,
  actionClaimMode = "normal",
  releaseClaimMode = "normal",
  actionReconcileState = "from-ledger",
  budgetReserveMode = "normal",
  budgetReconcileState = "from-ledger",
  providerStartMode = "normal",
  releaseStartMode = "normal",
  authorizationIssuedAtMs = NOW,
  verificationOperationIdOverride = null,
  forensicOperationIdOverride = null,
  forensicReferenceDigestOverride = null,
  clockThrowsAfterProviderStart = false,
  clock = () => NOW
} = {}) {
  const events = [];
  let claimNumber = 0;
  let reservationNumber = 0;
  let operationNumber = 0;
  let actionStage = "not-found";
  let budgetStage = "not-found";
  let clockFailed = false;
  const effectiveClock = () => {
    if (clockFailed) throw new Error("clock unavailable after provider-start marker");
    return clock();
  };
  const providerId = "containment-provider-01";
  const verifierId = "independent-control-plane-02";
  const profileId = "isolate-endpoint";
  const provider = {
    providerId,
    async preflight(input) {
      events.push("preflight");
      return {
        schema: "jb.resilience.a2-preflight/v1",
        providerId,
        ready: true,
        ...input.scope,
        profileId: input.profileId,
        managementPathAvailable: true,
        forensicPathAvailable: true
      };
    },
    async apply(input) {
      events.push("apply");
      if (applyOutcome === "throw") throw new Error("provider failed");
      if (applyOutcome === "hang") return new Promise(() => {});
      if (applyOutcome === "unknown") return { outcome: "unknown" };
      if (applyOutcome === "not-applied") return { outcome: "not-applied" };
      operationNumber += 1;
      return {
        outcome: "applied",
        receipt: makeReceipt({
          providerId, scope: input.scope, profileId: input.profileId,
          action: "apply-containment-profile", idempotencyKey: input.idempotencyKey,
          operationId: "contain-op-" + operationNumber, state: "contained"
        })
      };
    },
    async reconcile(input) {
      events.push("reconcile");
      if (reconcileOutcome !== "applied") return { outcome: reconcileOutcome };
      operationNumber += 1;
      return {
        outcome: "applied",
        receipt: makeReceipt({
          providerId, scope: input.scope, profileId: input.profileId,
          action: "apply-containment-profile", idempotencyKey: input.idempotencyKey,
          operationId: "reconciled-contain-" + operationNumber, state: "contained"
        })
      };
    },
    async release(input) {
      events.push("release");
      operationNumber += 1;
      return {
        outcome: releaseOutcome,
        receipt: makeReceipt({
          providerId, scope: input.scope, profileId: input.profileId,
          action: "release-containment", idempotencyKey: input.idempotencyKey,
          operationId: "release-op-" + operationNumber, state: "released"
        })
      };
    },
    async reconcileRelease(input) {
      events.push("reconcile-release");
      if (releaseOutcome !== "released") return { outcome: "unknown" };
      operationNumber += 1;
      return {
        outcome: "released",
        receipt: makeReceipt({
          providerId, scope: input.scope, profileId: input.profileId,
          action: "release-containment", idempotencyKey: input.idempotencyKey,
          operationId: "reconciled-release-" + operationNumber, state: "released"
        })
      };
    }
  };
  function makeReceipt({ providerId, scope, profileId, action, idempotencyKey, operationId, state }) {
    return {
      schema: "jb.resilience.a2-operation-receipt/v1",
      providerId, operationId, action, idempotencyKey, profileId,
      ...scope, state, occurredAtMs: NOW
    };
  }
  const verifier = {
    verifierId,
    async verifyContainment(input) {
      events.push("verify-containment");
      return makeVerification({
        verifierId, scope: input.scope, profileId: input.profileId,
        state: verificationState,
        operationId: verificationOperationIdOverride ?? input.operationReceipt.operationId,
        referencesSha256: createHash("sha256").update(JSON.stringify(input.evidenceRefs)).digest("hex")
      });
    },
    async verifyRelease(input) {
      events.push("verify-release");
      return makeVerification({
        verifierId, scope: input.scope, profileId: input.profileId,
        state: releaseVerificationState,
        operationId: verificationOperationIdOverride ?? input.operationReceipt.operationId,
        referencesSha256: createHash("sha256").update(JSON.stringify(input.evidenceRefs)).digest("hex")
      });
    }
  };
  function makeVerification({ verifierId, scope, profileId, state, operationId }) {
    return {
      schema: "jb.resilience.a2-verification/v1",
      verifierId, verified: state === "contained" || state === "released",
      state, ...scope, profileId, operationId,
      observedAtMs: NOW, expiresAtMs: NOW + 10_000
    };
  }
  const policyAuthority = {
    async authorize(input) {
      events.push("authorize:" + input.action);
      if (denyAuthorization) return { authorized: false };
      return {
        authorized: true,
        authorization: {
          schema: "jb.resilience.a2-authorization/v1",
          authorizationId: "a2-auth-" + input.action,
          action: input.action,
          ...input.scope,
          profileId: input.profileId,
          issuedAtMs: authorizationIssuedAtMs,
          expiresAtMs: NOW + 20_000
        }
      };
    },
    async assertAuthorization() {
      events.push("assert-authorization");
      return { valid: true };
    },
    async completeAuthorization(input) {
      events.push("complete-authorization:" + input.outcome);
      return { recorded: true };
    }
  };
  const controller = createA2ContainmentController({
    enableExecution: true,
    policyAuthority,
    containmentProvider: provider,
    independentVerifier: verifier,
    forensicRecorder: {
      recorderId: "forensic-vault-01",
      async preserveEvidence(input) {
        events.push("preserve-evidence");
        return {
          schema: "jb.resilience.a2-forensic-receipt/v1",
          recorderId: "forensic-vault-01",
          retained: forensicValid,
          ...input.scope,
          evidenceIds: ["forensic-record-01"],
          retentionPolicyId: input.retentionPolicyId,
          operationId: forensicOperationIdOverride ?? input.operationId,
          referencesSha256: forensicReferenceDigestOverride ??
            createHash("sha256").update(JSON.stringify(input.evidenceRefs)).digest("hex"),
          preservedAtMs: NOW,
          expiresAtMs: NOW + 100_000
        };
      }
    },
    budgetLedger: {
      durable: true,
      async reserve() {
        events.push("budget-reserve");
        if (budgetReserveMode === "hang") {
          budgetStage = "reserved";
          reservationNumber += 1;
          return new Promise(() => {});
        }
        if (budgetReserveMode === "deny") return { reserved: false, reservationId: null };
        reservationNumber += 1;
        budgetStage = "reserved";
        return { reserved: true, reservationId: "budget-" + reservationNumber };
      },
      async reconcile() {
        events.push("budget-reconcile");
        const state = budgetReconcileState === "from-ledger" ? budgetStage : budgetReconcileState;
        return {
          state,
          reservationId: state === "reserved" || state === "settled" ? "budget-" + reservationNumber : null
        };
      },
      async settle(input) {
        events.push("budget-settle:" + input.outcome);
        budgetStage = "settled";
        return { settled: true };
      }
    },
    actionLedger: {
      durable: true,
      async claim(input) {
        events.push("action-claim:" + input.action);
        const mode = input.action === "release-containment" ? releaseClaimMode : actionClaimMode;
        if (mode === "hang") {
          actionStage = "claimed";
          claimNumber += 1;
          return new Promise(() => {});
        }
        if (mode === "deny") return { claimed: false, claimId: null };
        claimNumber += 1;
        actionStage = "claimed";
        return { claimed: true, claimId: "claim-" + claimNumber };
      },
      async markProviderStarted(input) {
        events.push("action-mark-provider-started:" + input.action);
        const mode = input.action === "release-containment" ? releaseStartMode : providerStartMode;
        if (mode === "hang") {
          actionStage = "provider-started";
          return new Promise(() => {});
        }
        if (mode === "deny") return { started: false };
        actionStage = "provider-started";
        if (clockThrowsAfterProviderStart && input.action === "apply-containment-profile") {
          clockFailed = true;
        }
        return { started: true };
      },
      async reconcile() {
        events.push("action-reconcile");
        const state = actionReconcileState === "from-ledger" ? actionStage : actionReconcileState;
        return {
          state,
          claimId: ["claimed", "provider-started", "completed"].includes(state) ? "claim-" + claimNumber : null
        };
      },
      async complete(input) {
        events.push("action-complete:" + input.outcome);
        actionStage = input.outcome === "held-for-reconciliation" ? "completed" : "completed";
        return { completed: true };
      }
    },
    auditStore: {
      durable: true,
      async append(input) {
        events.push("audit:" + input.outcome);
        return !auditFails;
      }
    },
    mutationControl: {
      async assertAllowed(input) {
        events.push("mutation-check:" + input.phase);
        if (mutationTimeout) return new Promise(() => {});
        return input.phase !== blockMutationAt;
      }
    },
    clock: effectiveClock,
    operationTimeoutMs: 500
  });
  return { controller, events, profileId };
}

test("A2 controller defaults to disabled and never treats readiness as execution permission", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies();
  const disabled = createA2ContainmentController({
    enableExecution: false,
    policyAuthority: {
      authorize: async () => ({ authorized: false }),
      assertAuthorization: async () => false,
      completeAuthorization: async () => false
    },
    containmentProvider: {
      providerId: "p",
      preflight() {}, apply() {}, reconcile() {}, release() {}, reconcileRelease() {}
    },
    independentVerifier: { verifierId: "v", verifyContainment() {}, verifyRelease() {} },
    forensicRecorder: { recorderId: "f", preserveEvidence() {} },
    budgetLedger: { durable: true, reserve() {}, reconcile() {}, settle() {} },
    actionLedger: { durable: true, claim() {}, markProviderStarted() {}, reconcile() {}, complete() {} },
    auditStore: { durable: true, append() {} },
    mutationControl: { assertAllowed() {} }
  });
  const result = await disabled.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "disabled");
  assert.equal(result.executed, false);
  assert.equal(deps.events.length, 0);
});

test("A2 controller rejects copied readiness, mismatched scope and invalid evidence references", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const { controller, profileId } = createDependencies();
  const copied = { ...readiness };
  const forged = await controller.executeContainment({
    readiness: copied, scope: SCOPE, profileId, evidenceRefs
  });
  assert.equal(forged.state, "denied");
  assert.match(forged.reason, /verified-a2-readiness/);

  const wrongScope = { ...SCOPE, assetId: "endpoint-02" };
  const mismatch = await controller.executeContainment({
    readiness, scope: wrongScope, profileId, evidenceRefs
  });
  assert.equal(mismatch.state, "denied");

  const invalidRefs = await controller.executeContainment({
    readiness, scope: SCOPE, profileId, evidenceRefs: [{ refId: "x", sha256: "bad" }]
  });
  assert.equal(invalidRefs.state, "denied");

  const substitutedRefs = await controller.executeContainment({
    readiness, scope: SCOPE, profileId,
    evidenceRefs: evidenceRefs.map((ref) => ({ ...ref, refId: "substituted-" + ref.refId }))
  });
  assert.equal(substitutedRefs.state, "denied");
  assert.match(substitutedRefs.reason, /not-bound-to-verified-readiness/);
});

test("A2 executes only after policy authorization, budget claim, bounded preflight, independent verification and forensics; release is separate", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const { controller, events, profileId } = createDependencies();
  const contained = await controller.executeContainment({
    readiness, scope: SCOPE, profileId, evidenceRefs
  });
  assert.equal(contained.state, "contained");
  assert.equal(contained.executed, true);
  assert.equal(contained.verified, true);
  assert.equal(contained.authorizationGranted, true);
  assert.ok(events.indexOf("preflight") < events.indexOf("apply"));
  assert.ok(events.indexOf("apply") < events.indexOf("verify-containment"));
  assert.ok(events.indexOf("verify-containment") < events.indexOf("preserve-evidence"));

  const released = await controller.releaseContainment({
    containment: contained, reasonCode: "owner-release-approved"
  });
  assert.equal(released.state, "released");
  assert.equal(released.executed, true);
  assert.equal(released.verified, true);
  assert.ok(events.includes("verify-release"));
  assert.ok(events.includes("action-mark-provider-started:release-containment"));
  assert.ok(events.includes("complete-authorization:succeeded"));

  const repeatedRelease = await controller.releaseContainment({
    containment: contained, reasonCode: "owner-release-approved"
  });
  assert.equal(repeatedRelease.state, "denied");
});

test("A2 reconciles an ambiguous apply before accepting provider success", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ applyOutcome: "throw", reconcileOutcome: "applied" });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "contained");
  assert.ok(deps.events.includes("reconcile"));
  assert.ok(deps.events.indexOf("reconcile") < deps.events.indexOf("verify-containment"));
});

test("A2 keeps unknown provider outcomes held and never reports them as contained", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ applyOutcome: "throw", reconcileOutcome: "unknown" });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "held-for-reconciliation");
  assert.equal(result.executed, false);
  assert.equal(deps.events.includes("verify-containment"), false);
  assert.ok(deps.events.includes("action-complete:held-for-reconciliation"));
});

test("A2 never reports containment when the independent verifier or forensic recorder fails", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const verifierFailure = createDependencies({ verificationState: "unknown" });
  const first = await verifierFailure.controller.executeContainment({
    readiness, scope: SCOPE, profileId: verifierFailure.profileId, evidenceRefs
  });
  assert.equal(first.state, "held-for-reconciliation");
  assert.equal(first.executed, false);

  const forensicFailure = createDependencies({ forensicValid: false });
  const second = await forensicFailure.controller.executeContainment({
    readiness, scope: SCOPE, profileId: forensicFailure.profileId, evidenceRefs
  });
  assert.equal(second.state, "held-for-reconciliation");
  assert.equal(second.executed, false);
});

test("A2 blocks when mutation control or policy authorization denies the operation", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const blocked = createDependencies({ blockMutationAt: "before-apply" });
  const result = await blocked.controller.executeContainment({
    readiness, scope: SCOPE, profileId: blocked.profileId, evidenceRefs
  });
  assert.equal(result.state, "not-applied");
  assert.equal(blocked.events.includes("apply"), false);

  const denied = createDependencies({ denyAuthorization: true });
  const denial = await denied.controller.executeContainment({
    readiness, scope: SCOPE, profileId: denied.profileId, evidenceRefs
  });
  assert.equal(denial.state, "denied");
  assert.equal(denied.events.includes("apply"), false);
});

test("A2 refuses non-durable ledgers and executor/verifier identity collisions", () => {
  const { controller } = createDependencies();
  assert.equal(controller.enabled, true);
  assert.throws(() => createA2ContainmentController({
    enableExecution: true,
    policyAuthority: {
      authorize() {}, assertAuthorization() {}, completeAuthorization() {}
    },
    containmentProvider: {
      providerId: "p", preflight() {}, apply() {}, reconcile() {}, release() {}, reconcileRelease() {}
    },
    independentVerifier: { verifierId: "v", verifyContainment() {}, verifyRelease() {} },
    forensicRecorder: { recorderId: "f", preserveEvidence() {} },
    budgetLedger: { durable: false, reserve() {}, reconcile() {}, settle() {} },
    actionLedger: { durable: true, claim() {}, markProviderStarted() {}, reconcile() {}, complete() {} },
    auditStore: { durable: true, append() {} },
    mutationControl: { assertAllowed() {} }
  }), /must be durable/);
  assert.throws(() => createA2ContainmentController({
    enableExecution: true,
    policyAuthority: {
      authorize() {}, assertAuthorization() {}, completeAuthorization() {}
    },
    containmentProvider: {
      providerId: "same", preflight() {}, apply() {}, reconcile() {}, release() {}, reconcileRelease() {}
    },
    independentVerifier: {
      verifierId: "same", verifyContainment() {}, verifyRelease() {}
    },
    forensicRecorder: { recorderId: "f", preserveEvidence() {} },
    budgetLedger: { durable: true, reserve() {}, reconcile() {}, settle() {} },
    actionLedger: { durable: true, claim() {}, markProviderStarted() {}, reconcile() {}, complete() {} },
    auditStore: { durable: true, append() {} },
    mutationControl: { assertAllowed() {} }
  }), /distinct identities/);
});


test("A2 refuses readiness that expires before the provider mutation", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ clock: () => NOW + 50_000 });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "denied");
  assert.equal(result.reason, "a2-readiness-evidence-stale-at-execution");
  assert.equal(deps.events.includes("apply"), false);
});

test("A2 audit outage blocks the request before invoking the provider", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ auditFails: true });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "denied");
  assert.equal(result.reason, "durable-audit-unavailable");
  assert.equal(deps.events.includes("apply"), false);
});


test("A2 reconciles a provider deadline timeout before accepting a confirmed apply", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ applyOutcome: "hang", reconcileOutcome: "applied" });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "contained");
  assert.ok(deps.events.includes("reconcile"));
  assert.ok(deps.events.includes("verify-containment"));
});

test("A2 treats a mutation-control timeout as a deny and never invokes the provider", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ mutationTimeout: true });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "denied");
  assert.equal(result.reason, "mutation-control-blocked");
  assert.equal(deps.events.includes("apply"), false);
});


test("A2 holds a timed-out action claim still owned by a potentially active process", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ actionClaimMode: "hang", actionReconcileState: "claimed" });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "held-for-reconciliation");
  assert.equal(result.reason, "existing-action-claim-not-owned-by-this-invocation");
  assert.ok(deps.events.includes("action-reconcile"));
  assert.equal(deps.events.includes("action-complete:not-applied"), false);
  assert.equal(deps.events.includes("apply"), false);
});

test("A2 denies a timed-out action claim only when the durable journal confirms it was not recorded", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ actionClaimMode: "hang", actionReconcileState: "not-found" });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "denied");
  assert.equal(result.reason, "action-claim-not-recorded");
  assert.equal(deps.events.includes("apply"), false);
});

test("A2 reconciles a timed-out budget reservation and releases it without applying containment", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ budgetReserveMode: "hang", budgetReconcileState: "reserved" });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "denied");
  assert.equal(result.reason, "budget-reservation-reconciled-before-provider");
  assert.ok(deps.events.includes("budget-reconcile"));
  assert.ok(deps.events.includes("budget-settle:not-applied"));
  assert.equal(deps.events.includes("apply"), false);
});

test("A2 holds an action claim whose durable reconciliation remains unknown", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ actionClaimMode: "hang", actionReconcileState: "unknown" });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "held-for-reconciliation");
  assert.equal(result.executed, false);
  assert.equal(deps.events.includes("apply"), false);
});

test("A2 requires a durable provider-start marker before invoking the containment provider", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ providerStartMode: "hang", actionReconcileState: "provider-started" });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "held-for-reconciliation");
  assert.equal(result.executed, false);
  assert.ok(deps.events.includes("action-mark-provider-started:apply-containment-profile"));
  assert.ok(deps.events.includes("action-reconcile"));
  assert.equal(deps.events.includes("apply"), false);
});


test("A2 requires a durable provider-start marker before releasing containment", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({
    releaseStartMode: "hang",
    actionReconcileState: "provider-started"
  });
  const contained = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(contained.state, "contained");
  const released = await deps.controller.releaseContainment({
    containment: contained, reasonCode: "owner-release-approved"
  });
  assert.equal(released.state, "held-for-reconciliation");
  assert.equal(released.executed, false);
  assert.ok(deps.events.includes("action-mark-provider-started:release-containment"));
  assert.equal(deps.events.includes("release"), false);
});


test("A2 holds a budget reservation whose durable reconciliation remains unknown", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({
    budgetReserveMode: "hang",
    budgetReconcileState: "unknown"
  });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "held-for-reconciliation");
  assert.equal(result.executed, false);
  assert.ok(deps.events.includes("budget-reconcile"));
  assert.equal(deps.events.includes("apply"), false);
});

test("A2 safely abandons a provider-start marker denied by the ledger before any provider call", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ providerStartMode: "deny" });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "not-applied");
  assert.equal(result.executed, false);
  assert.ok(deps.events.includes("action-reconcile"));
  assert.equal(deps.events.includes("apply"), false);
});

test("A2 rejects negative authorization issue timestamps", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ authorizationIssuedAtMs: -1 });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "denied");
  assert.equal(result.reason, "a2-policy-authorization-denied");
  assert.equal(deps.events.includes("apply"), false);
});


test("A2 holds rather than applying when mutation control changes after the provider-start marker", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ blockMutationAt: "after-provider-start-marker" });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "held-for-reconciliation");
  assert.equal(result.executed, false);
  assert.equal(deps.events.includes("action-mark-provider-started:apply-containment-profile"), true);
  assert.equal(deps.events.includes("apply"), false);
});

test("A2 holds rather than releasing when mutation control changes after the release-start marker", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ blockMutationAt: "after-release-start-marker" });
  const contained = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(contained.state, "contained");
  const released = await deps.controller.releaseContainment({
    containment: contained, reasonCode: "owner-release-approved"
  });
  assert.equal(released.state, "held-for-reconciliation");
  assert.equal(released.executed, false);
  assert.equal(deps.events.includes("action-mark-provider-started:release-containment"), true);
  assert.equal(deps.events.includes("release"), false);
});


test("A2 converts a clock failure after provider-start marking into a held result without applying", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ clockThrowsAfterProviderStart: true });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "held-for-reconciliation");
  assert.equal(result.reason, "a2-post-start-execution-state-unknown");
  assert.equal(result.executed, false);
  assert.equal(deps.events.includes("action-mark-provider-started:apply-containment-profile"), true);
  assert.equal(deps.events.includes("apply"), false);
});


test("A2 keeps release authorization held when the durable release claim times out", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({
    releaseClaimMode: "hang",
    actionReconcileState: "claimed"
  });
  const contained = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(contained.state, "contained");

  const released = await deps.controller.releaseContainment({
    containment: contained, reasonCode: "owner-release-approved"
  });
  assert.equal(released.state, "held-for-reconciliation");
  assert.equal(released.executed, false);
  assert.equal(deps.events.includes("release"), false);
  assert.ok(deps.events.includes("complete-authorization:unverified"));
});


test("A2 rejects an independent verification receipt bound to another provider operation", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ verificationOperationIdOverride: "different-operation" });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "held-for-reconciliation");
  assert.equal(result.executed, false);
  assert.equal(result.reason, "independent-containment-verification-failed");
});

test("A2 rejects forensic receipts bound to another provider operation or evidence set", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const wrongOperation = createDependencies({ forensicOperationIdOverride: "different-operation" });
  const first = await wrongOperation.controller.executeContainment({
    readiness, scope: SCOPE, profileId: wrongOperation.profileId, evidenceRefs
  });
  assert.equal(first.state, "held-for-reconciliation");
  assert.equal(first.executed, false);
  assert.equal(first.reason, "forensic-evidence-preservation-failed");

  const wrongEvidence = createDependencies({ forensicReferenceDigestOverride: "0".repeat(64) });
  const second = await wrongEvidence.controller.executeContainment({
    readiness, scope: SCOPE, profileId: wrongEvidence.profileId, evidenceRefs
  });
  assert.equal(second.state, "held-for-reconciliation");
  assert.equal(second.executed, false);
  assert.equal(second.reason, "forensic-evidence-preservation-failed");
});
