import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createA2RecoveryCoordinator } from "../src/index.js";

const NOW = 1_800_000_000_000;
const SCOPE = Object.freeze({
  assetId: "endpoint-01",
  environment: "lab",
  incidentId: "incident-01",
  policyId: "containment-policy",
  policyRevision: 7,
  policyHash: "a".repeat(64)
});
const PROFILE_ID = "allowlisted-containment-profile";
const CONTENT = "evidence fixture: inert lab artifact";
const EVIDENCE_REFS = Object.freeze([Object.freeze({
  refId: "evidence-01",
  sha256: createHash("sha256").update(CONTENT, "utf8").digest("hex")
})]);

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonical(value[key])
  ).join(",") + "}";
}

function operationKey(action) {
  return createHash("sha256").update(canonical({
    schema: "jb.resilience.a2-operation-key/v1",
    action,
    scope: SCOPE,
    profileId: PROFILE_ID
  }), "utf8").digest("hex");
}

function makeRecord(action = "apply-containment-profile") {
  return {
    schema: "jb.resilience.a2-recovery-record/v1",
    claimId: "claim-01",
    action,
    scope: SCOPE,
    profileId: PROFILE_ID,
    providerId: "provider-lab-01",
    verifierId: "verifier-lab-01",
    recorderId: "recorder-lab-01",
    idempotencyKey: operationKey(action),
    state: "provider-started",
    originalOperationId: action === "release-containment" ? "contain-op-01" : null,
    evidenceRefs: EVIDENCE_REFS,
    createdAtMs: NOW - 10_000,
    updatedAtMs: NOW - 5_000,
    leaseExpiresAtMs: NOW - 1_000
  };
}

function makeOperationReceipt(record, state, operationId = "operation-01") {
  return {
    schema: "jb.resilience.a2-operation-receipt/v1",
    providerId: record.providerId,
    operationId,
    action: record.action,
    idempotencyKey: record.idempotencyKey,
    profileId: record.profileId,
    ...record.scope,
    state,
    occurredAtMs: NOW - 2_000
  };
}

function makeVerification(record, receipt, state) {
  return {
    schema: "jb.resilience.a2-verification/v1",
    verifierId: record.verifierId,
    verified: true,
    state,
    profileId: record.profileId,
    operationId: receipt.operationId,
    referencesSha256: createHash("sha256").update(canonical(EVIDENCE_REFS), "utf8").digest("hex"),
    ...record.scope,
    observedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000
  };
}

function makeForensicReceipt(record, receipt) {
  return {
    schema: "jb.resilience.a2-forensic-receipt/v1",
    recorderId: record.recorderId,
    retained: true,
    ...record.scope,
    evidenceIds: ["retained-evidence-01"],
    retentionPolicyId: "owner-retention-30d",
    preservedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 86_400_000,
    referencesSha256: createHash("sha256").update(canonical(EVIDENCE_REFS), "utf8").digest("hex"),
    operationId: receipt.operationId
  };
}

function createFixture({
  action = "apply-containment-profile",
  providerOutcome = null,
  resolvedContent = CONTENT,
  malformedRecord = false,
  recorderIdOverride = "recorder-lab-01",
  listPending = null,
  operationTimeoutMs = 1_000,
  maxEvidenceBytes = 16 * 1024 * 1024
} = {}) {
  const record = makeRecord(action);
  record.recorderId = recorderIdOverride;
  const events = [];
  const receipt = makeOperationReceipt(
    record,
    action === "apply-containment-profile" ? "contained" : "released",
    action === "apply-containment-profile" ? "contain-op-02" : "release-op-02"
  );
  const outcome = providerOutcome === "abort-resolves"
    ? (action === "apply-containment-profile" ? "applied" : "released")
    : providerOutcome ?? (action === "apply-containment-profile" ? "applied" : "released");
  const journal = {
    durable: true,
    async listPending(input) {
      events.push("list");
      return listPending ? listPending(input) : { claimIds: [record.claimId], nextCursor: null };
    },
    async getPendingByClaimId({ claimId }) {
      events.push("lookup");
      if (claimId !== record.claimId) return { found: false, record: null };
      return {
        found: true,
        record: malformedRecord === "apply-original-operation"
          ? { ...record, originalOperationId: "stale-operation-01" }
          : malformedRecord
            ? { ...record, providerId: "unexpected-provider" }
            : record
      };
    }
  };
  const provider = {
    providerId: record.providerId,
    reconciliationReadOnly: true,
    async reconcile(input) {
      events.push("reconcile-apply");
      if (providerOutcome === "abort-resolves") {
        assert.ok(input.signal instanceof AbortSignal);
        assert.ok(Number.isSafeInteger(input.deadlineMs));
        return new Promise((resolve) => {
          input.signal.addEventListener("abort", () => {
            events.push("provider-aborted");
            resolve({ outcome, receipt });
          }, { once: true });
        });
      }
      return providerOutcome === "unknown"
        ? { outcome: "unknown" }
        : { outcome, receipt };
    },
    async reconcileRelease(input) {
      events.push("reconcile-release");
      if (providerOutcome === "abort-resolves") {
        assert.ok(input.signal instanceof AbortSignal);
        assert.ok(Number.isSafeInteger(input.deadlineMs));
        return new Promise((resolve) => {
          input.signal.addEventListener("abort", () => {
            events.push("provider-aborted");
            resolve({ outcome, receipt });
          }, { once: true });
        });
      }
      return providerOutcome === "unknown"
        ? { outcome: "unknown" }
        : { outcome, receipt };
    }
  };
  const verifier = {
    verifierId: record.verifierId,
    async verifyContainment() {
      events.push("verify-containment");
      return makeVerification(record, receipt, "contained");
    },
    async verifyRelease() {
      events.push("verify-release");
      return makeVerification(record, receipt, "released");
    }
  };
  const recorder = {
    recorderId: record.recorderId,
    async lookupRetention() {
      events.push("lookup-retention");
      return makeForensicReceipt(record, receipt);
    }
  };
  const resolver = {
    async resolve({ refId }) {
      events.push("resolve-evidence");
      return { refId, content: resolvedContent };
    }
  };
  const coordinator = createA2RecoveryCoordinator({
    journal,
    containmentProvider: provider,
    independentVerifier: verifier,
    forensicRecorder: recorder,
    evidenceResolver: resolver,
    clock: () => NOW,
    operationTimeoutMs,
    maxEvidenceBytes
  });
  return { coordinator, events, record };
}

test("read-only startup reconciliation verifies contained state without exposing execution", async () => {
  const { coordinator, events } = createFixture();
  const report = await coordinator.reconcilePending();
  assert.equal(report.complete, true);
  assert.equal(report.recordsRead, 1);
  assert.equal(report.findings[0].state, "contained-observed-and-verified");
  assert.equal(report.findings[0].safeToRetry, false);
  assert.equal(report.findings[0].executable, false);
  assert.equal(report.findings[0].releaseAllowed, false);
  assert.deepEqual(events, [
    "list", "lookup", "reconcile-apply", "resolve-evidence",
    "verify-containment", "lookup-retention"
  ]);
  assert.equal("executeContainment" in coordinator, false);
  assert.equal("releaseContainment" in coordinator, false);
});

test("concurrent startup scans remain observational and never expose mutation methods", async () => {
  const { coordinator, events } = createFixture();
  const [left, right] = await Promise.all([
    coordinator.reconcilePending(),
    coordinator.reconcilePending()
  ]);
  assert.equal(left.findings[0].state, "contained-observed-and-verified");
  assert.equal(right.findings[0].state, "contained-observed-and-verified");
  assert.equal(events.filter((event) => event === "reconcile-apply").length, 2);
  assert.equal(events.some((event) =>
    ["apply", "release", "complete", "journal-write"].includes(event)
  ), false);
  assert.equal("executeContainment" in coordinator, false);
  assert.equal("releaseContainment" in coordinator, false);
});

test("expired claim lease does not become permission to retry", async () => {
  const { coordinator } = createFixture();
  const report = await coordinator.reconcilePending();
  assert.equal(report.findings[0].leaseExpired, true);
  assert.equal(report.findings[0].safeToRetry, false);
  assert.equal(report.findings[0].releaseAllowed, false);
});

test("unknown provider state remains held and is not independently promoted", async () => {
  const { coordinator, events } = createFixture({ providerOutcome: "unknown" });
  const report = await coordinator.reconcilePending();
  assert.equal(report.complete, false);
  assert.equal(report.findings[0].state, "held-for-reconciliation");
  assert.equal(report.findings[0].reason, "provider-outcome-unknown-or-malformed");
  assert.equal(events.includes("verify-containment"), false);
  assert.equal(events.includes("lookup-retention"), false);
});

test("evidence digest mismatch blocks verifier and recovery success", async () => {
  const { coordinator, events } = createFixture({ resolvedContent: "tampered content" });
  const report = await coordinator.reconcilePending();
  assert.equal(report.complete, false);
  assert.equal(report.findings[0].state, "held-for-reconciliation");
  assert.equal(report.findings[0].reason, "evidence-reference-digest-mismatch");
  assert.equal(events.includes("verify-containment"), false);
});

test("durable record identity mismatch remains held", async () => {
  const { coordinator, events } = createFixture({ malformedRecord: true });
  const report = await coordinator.reconcilePending();
  assert.equal(report.complete, false);
  assert.equal(report.findings[0].reason, "durable-journal-record-missing-or-invalid");
  assert.equal(events.includes("reconcile-apply"), false);
});

test("recovery coordinator rejects a recorder sharing the provider identity", () => {
  assert.throws(() => createFixture({
    recorderIdOverride: "provider-lab-01"
  }), /identities must differ/);
});

test("containment recovery rejects an unrelated prior operation ID", async () => {
  const { coordinator, events } = createFixture({
    malformedRecord: "apply-original-operation"
  });
  const report = await coordinator.reconcilePending();
  assert.equal(report.complete, false);
  assert.equal(report.findings[0].reason, "durable-journal-record-missing-or-invalid");
  assert.equal(events.includes("reconcile-apply"), false);
});

test("release reconciliation requires exact original operation and remains non-executable", async () => {
  const { coordinator, events } = createFixture({ action: "release-containment" });
  const report = await coordinator.reconcilePending();
  assert.equal(report.complete, true);
  assert.equal(report.findings[0].state, "released-observed-and-verified");
  assert.equal(report.findings[0].releaseAllowed, false);
  assert.equal(events.includes("reconcile-release"), true);
  assert.equal(events.includes("verify-release"), true);
});

test("journal cursor cycles stop the scan and report incomplete", async () => {
  const { coordinator } = createFixture({
    listPending: () => ({ claimIds: [], nextCursor: "cursor-a" })
  });
  const report = await coordinator.reconcilePending();
  assert.equal(report.complete, false);
  assert.equal(report.findings.at(-1).reason, "journal-cursor-cycle-detected");
});

test("accessor-backed claim IDs are rejected without invoking the getter", async () => {
  let getterCalled = false;
  const claimIds = [];
  claimIds.length = 1;
  Object.defineProperty(claimIds, "0", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "claim-01";
    }
  });
  const { coordinator } = createFixture({
    listPending: () => ({ claimIds, nextCursor: null })
  });
  const report = await coordinator.reconcilePending();
  assert.equal(getterCalled, false);
  assert.equal(report.complete, false);
  assert.equal(report.findings[0].reason, "claim-id-page-contains-accessor-or-hole");
});


test("an adapter resolving while handling abort cannot override the reconciliation deadline", async () => {
  const { coordinator, events } = createFixture({
    providerOutcome: "abort-resolves",
    operationTimeoutMs: 100
  });
  const report = await coordinator.reconcilePending();

  assert.equal(report.complete, false);
  assert.equal(report.findings[0].state, "held-for-reconciliation");
  assert.equal(report.findings[0].reason, "provider-reconciliation-unavailable");
  assert.ok(events.includes("provider-aborted"));
  assert.equal(events.includes("resolve-evidence"), false);
  assert.equal(events.includes("verify-containment"), false);
  assert.equal(events.includes("lookup-retention"), false);
});


test("evidence resolver payloads are bounded before hashing or verification", async () => {
  const { coordinator, events } = createFixture({
    resolvedContent: "x".repeat(17),
    maxEvidenceBytes: 16
  });
  const report = await coordinator.reconcilePending();

  assert.equal(report.complete, false);
  assert.equal(report.findings[0].state, "held-for-reconciliation");
  assert.equal(report.findings[0].reason, "evidence-byte-budget-exceeded");
  assert.equal(report.findings[0].maxEvidenceBytes, 16);
  assert.equal(report.findings[0].resolvedEvidenceBytes, 0);
  assert.equal(report.findings[0].rejectedEvidenceBytes, 17);
  assert.equal(report.findings[0].safeToRetry, false);
  assert.equal(report.findings[0].executable, false);
  assert.equal(events.includes("verify-containment"), false);
  assert.equal(events.includes("lookup-retention"), false);
});

test("A2 recovery coordinator rejects unbounded evidence budget configuration", () => {
  assert.throws(() => createFixture({
    maxEvidenceBytes: 64 * 1024 * 1024 + 1
  }), /A2 recovery bounds are invalid/);
});

test("binary evidence hashing respects the exact typed-array view boundaries", async () => {
  const wrapped = Buffer.from("prefix" + CONTENT + "suffix", "utf8");
  const view = wrapped.subarray(
    Buffer.byteLength("prefix", "utf8"),
    Buffer.byteLength("prefix" + CONTENT, "utf8")
  );
  const { coordinator } = createFixture({ resolvedContent: view });
  const report = await coordinator.reconcilePending();

  assert.equal(report.complete, true);
  assert.equal(report.findings[0].state, "contained-observed-and-verified");
});
