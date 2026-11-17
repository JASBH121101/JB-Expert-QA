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
  createA2ContainmentController,
  createA2RecoveryCoordinator
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
  auditFailsForOutcome = null,
  forensicValid = true,
  forensicEvidenceIds = null,
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
  releaseVerificationOperationIdOverride = null,
  verificationReferenceDigestOverride = null,
  preReleaseVerificationReferenceDigestOverride = null,
  releaseVerificationReferenceDigestOverride = null,
  forensicOperationIdOverride = null,
  forensicReferenceDigestOverride = null,
  clockThrowsAfterProviderStart = false,
  clockThrowsAfterPendingRecord = false,
  skipRecoveryRecordPersist = false,
  clock = () => NOW
} = {}) {
  const events = [];
  let claimNumber = 0;
  let reservationNumber = 0;
  let operationNumber = 0;
  let actionStage = "not-found";
  let budgetStage = "not-found";
  let clockFailed = false;
  const pendingRecords = new Map();
  const pendingTransitions = [];
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
        referencesSha256: input.action === "verify-before-release"
          ? preReleaseVerificationReferenceDigestOverride ??
            verificationReferenceDigestOverride ??
            createHash("sha256").update(JSON.stringify(input.evidenceRefs)).digest("hex")
          : verificationReferenceDigestOverride ??
            createHash("sha256").update(JSON.stringify(input.evidenceRefs)).digest("hex")
      });
    },
    async verifyRelease(input) {
      events.push("verify-release");
      return makeVerification({
        verifierId, scope: input.scope, profileId: input.profileId,
        state: releaseVerificationState,
        operationId: releaseVerificationOperationIdOverride ?? input.operationReceipt.operationId,
        referencesSha256: releaseVerificationReferenceDigestOverride ??
          createHash("sha256").update(JSON.stringify(input.evidenceRefs)).digest("hex")
      });
    }
  };
  function makeVerification({ verifierId, scope, profileId, state, operationId, referencesSha256 }) {
    return {
      schema: "jb.resilience.a2-verification/v1",
      verifierId, verified: state === "contained" || state === "released",
      state, ...scope, profileId, operationId, referencesSha256,
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
          evidenceIds: forensicEvidenceIds ?? ["forensic-record-01"],
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
      async createPendingRecord(input) {
        events.push("pending-create:" + input.record.action);
        if (pendingRecords.has(input.record.claimId)) return { created: false };
        pendingRecords.set(input.record.claimId, { ...input.record });
        pendingTransitions.push({ claimId: input.record.claimId, state: "claimed", record: { ...input.record } });
        if (clockThrowsAfterPendingRecord) clockFailed = true;
        return { created: true };
      },
      async listPending(input) {
        events.push("pending-list");
        const claimIds = [...pendingRecords.values()]
          .filter((record) => ["claimed", "provider-started", "held-for-reconciliation"].includes(record.state))
          .map((record) => record.claimId);
        const offset = input.cursor === null ? 0 : Number(input.cursor);
        const page = claimIds.slice(offset, offset + input.limit);
        const nextOffset = offset + page.length;
        return { claimIds: page, nextCursor: nextOffset < claimIds.length ? String(nextOffset) : null };
      },
      async getPendingByClaimId(input) {
        events.push("pending-get:" + input.claimId);
        const record = pendingRecords.get(input.claimId);
        return record
          ? { found: true, record: { ...record } }
          : { found: false, record: null };
      },
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
          if (!skipRecoveryRecordPersist && input.recoveryRecord) {
            pendingRecords.set(input.claimId, { ...input.recoveryRecord });
            pendingTransitions.push({
              claimId: input.claimId, state: "provider-started",
              record: { ...input.recoveryRecord }
            });
          }
          return new Promise(() => {});
        }
        if (mode === "deny") return { started: false };
        actionStage = "provider-started";
        if (!skipRecoveryRecordPersist && input.recoveryRecord) {
          pendingRecords.set(input.claimId, { ...input.recoveryRecord });
          pendingTransitions.push({
            claimId: input.claimId, state: "provider-started",
            record: { ...input.recoveryRecord }
          });
        }
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
        actionStage = "completed";
        const pending = pendingRecords.get(input.claimId);
        if (pending) {
          if (input.outcome === "held-for-reconciliation") {
            const heldRecord = {
              ...pending,
              state: "held-for-reconciliation",
              updatedAtMs: input.completedAtMs
            };
            pendingRecords.set(input.claimId, heldRecord);
            pendingTransitions.push({
              claimId: input.claimId, state: "held-for-reconciliation",
              record: { ...heldRecord }
            });
          } else {
            pendingRecords.delete(input.claimId);
            pendingTransitions.push({ claimId: input.claimId, state: "terminal-removed" });
          }
        }
        return { completed: true };
      }
    },
    auditStore: {
      durable: true,
      async append(input) {
        events.push("audit:" + input.outcome);
        return !auditFails && input.outcome !== auditFailsForOutcome;
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
  const recoveryJournal = {
    durable: true,
    async listPending(input) {
      const claimIds = [...pendingRecords.values()]
        .filter((record) => ["claimed", "provider-started", "held-for-reconciliation"].includes(record.state))
        .map((record) => record.claimId);
      const offset = input.cursor === null ? 0 : Number(input.cursor);
      const page = claimIds.slice(offset, offset + input.limit);
      const nextOffset = offset + page.length;
      return { claimIds: page, nextCursor: nextOffset < claimIds.length ? String(nextOffset) : null };
    },
    async getPendingByClaimId(input) {
      const record = pendingRecords.get(input.claimId);
      return record ? { found: true, record: { ...record } } : { found: false, record: null };
    }
  };
  return { controller, events, profileId, actionLedger: recoveryJournal, pendingRecords, pendingTransitions };
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
  const deps = createDependencies();
  const { controller, events, profileId } = deps;
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
  const releaseClaim = deps.pendingTransitions.find((entry) =>
    entry.state === "claimed" && entry.record.action === "release-containment"
  );
  assert.equal(releaseClaim.record.originalOperationId, contained.operationReceipt.operationId);
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

test("A2 persists exact pending recovery data before provider start and verifies the atomic transition", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies();
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "contained");
  assert.ok(deps.events.indexOf("pending-create:apply-containment-profile") <
    deps.events.indexOf("action-mark-provider-started:apply-containment-profile"));
  assert.ok(deps.events.indexOf("action-mark-provider-started:apply-containment-profile") <
    deps.events.indexOf("apply"));
  assert.deepEqual(
    deps.pendingTransitions.slice(0, 2).map((entry) => entry.state),
    ["claimed", "provider-started"]
  );
  const created = deps.pendingTransitions[0].record;
  assert.equal(created.schema, "jb.resilience.a2-recovery-record/v1");
  assert.equal(created.claimId, "claim-1");
  assert.equal(created.action, "apply-containment-profile");
  assert.deepEqual({ ...created.scope }, SCOPE);
  assert.equal(created.profileId, deps.profileId);
  assert.equal(created.providerId, "containment-provider-01");
  assert.equal(created.verifierId, "independent-control-plane-02");
  assert.equal(created.recorderId, "forensic-vault-01");
  assert.equal(created.state, "claimed");
  assert.equal(created.evidenceRefs.length, evidenceRefs.length);
  assert.equal(created.leaseExpiresAtMs, NOW + 4_000);
});

test("A2 refuses provider mutation unless the durable provider-start record is confirmed", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ skipRecoveryRecordPersist: true });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "held-for-reconciliation");
  assert.equal(result.executed, false);
  assert.equal(deps.events.includes("apply"), false);
  assert.ok(deps.events.includes("action-complete:held-for-reconciliation"));
});

test("A2 keeps a pre-marker claim held across restart and never queries or retries the provider", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ clockThrowsAfterPendingRecord: true });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "held-for-reconciliation");
  assert.equal(deps.events.includes("apply"), false);
  const [record] = [...deps.pendingRecords.values()];
  assert.equal(record.state, "claimed");

  let providerQueries = 0;
  const coordinator = createA2RecoveryCoordinator({
    journal: deps.actionLedger,
    containmentProvider: {
      providerId: "containment-provider-01",
      reconciliationReadOnly: true,
      async reconcile() { providerQueries += 1; return { outcome: "unknown" }; },
      async reconcileRelease() { providerQueries += 1; return { outcome: "unknown" }; }
    },
    independentVerifier: {
      verifierId: "independent-control-plane-02",
      async verifyContainment() { return null; },
      async verifyRelease() { return null; }
    },
    forensicRecorder: {
      recorderId: "forensic-vault-01",
      async lookupRetention() { return null; }
    },
    evidenceResolver: { async resolve() { return null; } },
    clock: () => NOW
  });
  const report = await coordinator.reconcilePending();
  assert.equal(report.findings[0].state, "held-for-reconciliation");
  assert.equal(
    report.findings[0].reason,
    "provider-start-not-marked-no-provider-call-authorized"
  );
  assert.equal(report.findings[0].providerQuerySkipped, true);
  assert.equal(providerQueries, 0);
  assert.equal(report.executable, false);
  assert.equal(report.safeToRetry, false);
  assert.equal(report.releaseAllowed, false);
});

test("A2 keeps its pending recovery record when final audit prevents successful finalization", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ auditFailsForOutcome: "contained" });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "held-for-reconciliation");
  assert.equal(result.executed, false);
  const [record] = [...deps.pendingRecords.values()];
  assert.equal(record.state, "held-for-reconciliation");
  assert.equal(deps.pendingTransitions.at(-1).state, "held-for-reconciliation");
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
  assert.equal(result.reason, "a2-ledger-or-post-start-execution-state-unknown");
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


test("A2 rejects an independent verifier receipt bound to a substituted evidence set", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ verificationReferenceDigestOverride: "f".repeat(64) });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "held-for-reconciliation");
  assert.equal(result.executed, false);
  assert.equal(result.reason, "independent-containment-verification-failed");
});


test("A2 refuses release when the independent release verifier binds a different operation", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({
    releaseVerificationState: "released",
    releaseVerificationOperationIdOverride: "different-release-operation"
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
  assert.equal(released.reason, "independent-release-verification-failed");
});

test("A2 refuses release when the pre-release verifier cannot bind the existing evidence set", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ preReleaseVerificationReferenceDigestOverride: "e".repeat(64) });
  const contained = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(contained.state, "contained");

  const released = await deps.controller.releaseContainment({
    containment: contained, reasonCode: "owner-release-approved"
  });
  assert.equal(released.state, "held-for-reconciliation");
  assert.equal(released.reason, "current-containment-state-not-independently-verified");
  assert.equal(deps.events.includes("release"), false);
});





test("A2 holds a verified release when authorization or stop control changes before durable finalization", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const deps = createDependencies({ blockMutationAt: "before-release-finalization" });
  const contained = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(contained.state, "contained");

  const released = await deps.controller.releaseContainment({
    containment: contained, reasonCode: "owner-release-approved"
  });
  assert.equal(released.state, "held-for-reconciliation");
  assert.equal(released.executed, false);
  assert.equal(released.reason, "authorization-or-mutation-control-changed-after-release");
  assert.ok(deps.events.includes("verify-release"));
  assert.ok(deps.events.includes("mutation-check:before-release-finalization"));
});


test("A2 containment result handles are bound to the issuing controller instance", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  const issuing = createDependencies();
  const unrelated = createDependencies();

  const contained = await issuing.controller.executeContainment({
    readiness, scope: SCOPE, profileId: issuing.profileId, evidenceRefs
  });
  assert.equal(contained.state, "contained");

  const attemptedRelease = await unrelated.controller.releaseContainment({
    containment: contained, reasonCode: "owner-release-approved"
  });
  assert.equal(attemptedRelease.state, "denied");
  assert.equal(attemptedRelease.reason, "verified-controller-containment-result-required");
  assert.equal(unrelated.events.includes("release"), false);
});

test("A2 evidence references reject accessor-backed arrays without invoking getters", async () => {
  const { readiness } = await createVerifiedReadiness();
  const deps = createDependencies();
  let getterCalled = false;
  const evidenceRefs = [];
  evidenceRefs.length = 1;
  Object.defineProperty(evidenceRefs, "0", {
    enumerable: true,
    configurable: false,
    get() {
      getterCalled = true;
      return { refId: "evidence-1", sha256: "a".repeat(64) };
    }
  });

  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "denied");
  assert.equal(result.reason, "invalid-a2-execution-context");
  assert.equal(getterCalled, false);
});


test("A2 forensic receipts reject accessor-backed evidence ID arrays without invoking getters", async () => {
  const { readiness, evidenceRefs } = await createVerifiedReadiness();
  let getterCalled = false;
  const evidenceIds = [];
  evidenceIds.length = 1;
  Object.defineProperty(evidenceIds, "0", {
    enumerable: true,
    configurable: false,
    get() {
      getterCalled = true;
      return "forensic-record-01";
    }
  });
  const deps = createDependencies({ forensicEvidenceIds: evidenceIds });
  const result = await deps.controller.executeContainment({
    readiness, scope: SCOPE, profileId: deps.profileId, evidenceRefs
  });
  assert.equal(result.state, "held-for-reconciliation");
  assert.equal(result.reason, "forensic-evidence-preservation-failed");
  assert.equal(getterCalled, false);
  assert.equal(deps.events.includes("apply"), true);
});
