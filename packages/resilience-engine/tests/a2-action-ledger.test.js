import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileA2ActionLedger } from "../src/index.js";

const NOW = 1_800_000_000_000;
const SCOPE = Object.freeze({
  assetId: "endpoint-01",
  environment: "lab",
  incidentId: "incident-01",
  policyId: "containment-policy",
  policyRevision: 7,
  policyHash: "a".repeat(64)
});
const PROVIDER_ID = "provider-lab-01";
const VERIFIER_ID = "verifier-lab-01";
const RECORDER_ID = "recorder-lab-01";
const PROFILE_ID = "approved-profile-01";
const CONTENT = "A2 durable ledger test evidence";
const EVIDENCE_REFS = [{
  refId: "evidence-01",
  sha256: createHash("sha256").update(CONTENT, "utf8").digest("hex")
}];

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonical(value[key])
  ).join(",") + "}";
}

function makeIdempotencyKey(action = "apply-containment-profile", scope = SCOPE, profileId = PROFILE_ID) {
  return createHash("sha256").update(canonical({
    schema: "jb.resilience.a2-operation-key/v1",
    action, scope, profileId
  }), "utf8").digest("hex");
}

function makeRecoveryRecord(claimId, {
  action = "apply-containment-profile",
  state = "claimed",
  createdAtMs = NOW + 1,
  updatedAtMs = createdAtMs,
  originalOperationId = null
} = {}) {
  return {
    schema: "jb.resilience.a2-recovery-record/v1",
    claimId,
    action,
    scope: SCOPE,
    profileId: PROFILE_ID,
    providerId: PROVIDER_ID,
    verifierId: VERIFIER_ID,
    recorderId: RECORDER_ID,
    idempotencyKey: makeIdempotencyKey(action),
    state,
    originalOperationId,
    evidenceRefs: EVIDENCE_REFS,
    createdAtMs,
    updatedAtMs,
    leaseExpiresAtMs: NOW + 20_000
  };
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "jb-resilience-a2-ledger-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createStore(filePath, overrides = {}) {
  return createFileA2ActionLedger({
    filePath,
    providerId: PROVIDER_ID,
    verifierId: VERIFIER_ID,
    recorderId: RECORDER_ID,
    ...overrides
  });
}

async function claimAndCreateRecord(store, {
  action = "apply-containment-profile",
  scope = SCOPE,
  profileId = PROFILE_ID,
  claimAt = NOW,
  expiresAt = NOW + 10_000,
  originalOperationId = null
} = {}) {
  const idempotencyKey = makeIdempotencyKey(action, scope, profileId);
  const claim = await store.claim({
    action, scope, profileId, idempotencyKey,
    claimedAtMs: claimAt, expiresAtMs: expiresAt
  });
  assert.equal(claim.claimed, true);
  const record = makeRecoveryRecord(claim.claimId, {
    action,
    createdAtMs: claimAt + 1,
    updatedAtMs: claimAt + 1,
    originalOperationId
  });
  assert.deepEqual(await store.createPendingRecord({ record, atMs: claimAt + 1 }), { created: true });
  return { claimId: claim.claimId, idempotencyKey, record };
}

async function markStarted(store, claim) {
  const atMs = claim.record.createdAtMs + 1;
  const recoveryRecord = {
    ...claim.record,
    state: "provider-started",
    updatedAtMs: atMs
  };
  const result = await store.markProviderStarted({
    claimId: claim.claimId,
    action: claim.record.action,
    scope: claim.record.scope,
    profileId: claim.record.profileId,
    idempotencyKey: claim.idempotencyKey,
    recoveryRecord,
    atMs
  });
  return { result, recoveryRecord, atMs };
}

test("file A2 ledger persists one action claim and exact pending record across instances", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "a2-actions.json");
    const first = createStore(filePath);
    const second = createStore(filePath);
    assert.equal(first.durable, true);
    const claim = await claimAndCreateRecord(first);
    const page = await second.listPending({ cursor: null, limit: 10, atMs: NOW + 2 });
    assert.deepEqual(page.claimIds, [claim.claimId]);
    assert.equal(page.nextCursor, null);
    const exact = await second.getPendingByClaimId({ claimId: claim.claimId, atMs: NOW + 2 });
    assert.equal(exact.found, true);
    assert.deepEqual(exact.record, claim.record);
    const reconciled = await second.reconcile({
      action: claim.record.action, scope: SCOPE, profileId: PROFILE_ID,
      idempotencyKey: claim.idempotencyKey, atMs: NOW + 2
    });
    assert.deepEqual(reconciled, { state: "claimed", claimId: claim.claimId });
  });
});

test("concurrent instances cannot create duplicate claims for the same idempotency key", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "a2-actions.json");
    const first = createStore(filePath);
    const second = createStore(filePath);
    const input = {
      action: "apply-containment-profile",
      scope: SCOPE,
      profileId: PROFILE_ID,
      idempotencyKey: makeIdempotencyKey(),
      claimedAtMs: NOW,
      expiresAtMs: NOW + 10_000
    };
    const results = await Promise.all([first.claim(input), second.claim(input)]);
    assert.equal(results.filter((result) => result.claimed === true).length, 1);
    assert.equal(results.filter((result) => result.claimed === false).length, 1);
    const observed = await first.reconcile({
      action: input.action, scope: input.scope, profileId: input.profileId,
      idempotencyKey: input.idempotencyKey, atMs: NOW + 1
    });
    assert.equal(observed.state, "claimed");
  });
});

test("provider start atomically transitions the action claim and its pending record", async () => {
  await withTempDirectory(async (directory) => {
    const store = createStore(join(directory, "a2-actions.json"));
    const claim = await claimAndCreateRecord(store);
    const started = await markStarted(store, claim);
    assert.deepEqual(started.result, { started: true });
    const page = await store.listPending({ cursor: null, limit: 10, atMs: started.atMs });
    const exact = await store.getPendingByClaimId({ claimId: claim.claimId, atMs: started.atMs });
    assert.deepEqual(page.claimIds, [claim.claimId]);
    assert.equal(exact.found, true);
    assert.deepEqual(exact.record, started.recoveryRecord);
    const reconciled = await store.reconcile({
      action: claim.record.action, scope: SCOPE, profileId: PROFILE_ID,
      idempotencyKey: claim.idempotencyKey, atMs: started.atMs
    });
    assert.deepEqual(reconciled, { state: "provider-started", claimId: claim.claimId });
  });
});

test("provider start rejects an expired claim without changing its durable state", async () => {
  await withTempDirectory(async (directory) => {
    const store = createStore(join(directory, "a2-actions.json"));
    const claim = await claimAndCreateRecord(store, { expiresAt: NOW + 3 });
    const recoveryRecord = {
      ...claim.record,
      state: "provider-started",
      updatedAtMs: NOW + 4
    };
    assert.deepEqual(await store.markProviderStarted({
      claimId: claim.claimId, action: claim.record.action, scope: SCOPE,
      profileId: PROFILE_ID, idempotencyKey: claim.idempotencyKey,
      recoveryRecord, atMs: NOW + 4
    }), { started: false });
    const exact = await store.getPendingByClaimId({ claimId: claim.claimId, atMs: NOW + 4 });
    assert.equal(exact.found, true);
    assert.equal(exact.record.state, "claimed");
    assert.deepEqual(await store.reconcile({
      action: claim.record.action, scope: SCOPE, profileId: PROFILE_ID,
      idempotencyKey: claim.idempotencyKey, atMs: NOW + 4
    }), { state: "claimed", claimId: claim.claimId });
  });
});

test("provider-start transition can never be repeated for an existing claim", async () => {
  await withTempDirectory(async (directory) => {
    const store = createStore(join(directory, "a2-actions.json"));
    const claim = await claimAndCreateRecord(store);
    const started = await markStarted(store, claim);
    assert.deepEqual(started.result, { started: true });
    assert.deepEqual(await store.markProviderStarted({
      claimId: claim.claimId, action: claim.record.action, scope: SCOPE,
      profileId: PROFILE_ID, idempotencyKey: claim.idempotencyKey,
      recoveryRecord: started.recoveryRecord, atMs: started.atMs + 1
    }), { started: false });
  });
});

test("held claims stay indexed; pre-provider holds remain in the claimed state", async () => {
  await withTempDirectory(async (directory) => {
    const store = createStore(join(directory, "a2-actions.json"));
    const claim = await claimAndCreateRecord(store);
    assert.deepEqual(await store.complete({
      claimId: claim.claimId,
      outcome: "held-for-reconciliation",
      reason: "clock-unavailable",
      completedAtMs: NOW + 3
    }), { completed: true });
    const exact = await store.getPendingByClaimId({ claimId: claim.claimId, atMs: NOW + 4 });
    assert.equal(exact.found, true);
    assert.equal(exact.record.state, "claimed");
    const page = await store.listPending({ cursor: null, limit: 10, atMs: NOW + 4 });
    assert.deepEqual(page.claimIds, [claim.claimId]);
  });
});

test("provider-started holds remain pending and carry held-for-reconciliation state", async () => {
  await withTempDirectory(async (directory) => {
    const store = createStore(join(directory, "a2-actions.json"));
    const claim = await claimAndCreateRecord(store);
    const started = await markStarted(store, claim);
    assert.deepEqual(await store.complete({
      claimId: claim.claimId,
      outcome: "held-for-reconciliation",
      reason: "verifier-unavailable",
      completedAtMs: started.atMs + 1
    }), { completed: true });
    const exact = await store.getPendingByClaimId({
      claimId: claim.claimId, atMs: started.atMs + 2
    });
    assert.equal(exact.found, true);
    assert.equal(exact.record.state, "held-for-reconciliation");
    assert.equal(exact.record.updatedAtMs, started.atMs + 1);
  });
});

test("terminal success removes the pending record but preserves the idempotency tombstone", async () => {
  await withTempDirectory(async (directory) => {
    const store = createStore(join(directory, "a2-actions.json"));
    const claim = await claimAndCreateRecord(store);
    const started = await markStarted(store, claim);
    assert.deepEqual(await store.complete({
      claimId: claim.claimId,
      outcome: "succeeded",
      reason: null,
      completedAtMs: started.atMs + 1
    }), { completed: true });
    assert.deepEqual(await store.getPendingByClaimId({
      claimId: claim.claimId, atMs: started.atMs + 2
    }), { found: false, record: null });
    assert.deepEqual(await store.listPending({
      cursor: null, limit: 10, atMs: started.atMs + 2
    }), { claimIds: [], nextCursor: null });
    const duplicate = await store.claim({
      action: claim.record.action, scope: SCOPE, profileId: PROFILE_ID,
      idempotencyKey: claim.idempotencyKey,
      claimedAtMs: NOW + 9_000, expiresAtMs: NOW + 19_000
    });
    assert.deepEqual(duplicate, { claimed: false, claimId: null });
  });
});

test("not-applied after provider start requires exact provider reconciliation context", async () => {
  await withTempDirectory(async (directory) => {
    const store = createStore(join(directory, "a2-actions.json"));
    const claim = await claimAndCreateRecord(store);
    const started = await markStarted(store, claim);
    const base = {
      claimId: claim.claimId,
      outcome: "not-applied",
      reason: "provider-confirmed-not-applied",
      completedAtMs: started.atMs + 2
    };
    assert.deepEqual(await store.complete(base), { completed: false });
    const proof = {
      schema: "jb.resilience.a2-provider-non-application/v1",
      providerId: PROVIDER_ID,
      action: claim.record.action,
      scope: SCOPE,
      profileId: PROFILE_ID,
      idempotencyKey: claim.idempotencyKey,
      outcome: "not-applied",
      observedAtMs: started.atMs + 1
    };
    assert.deepEqual(await store.complete({
      ...base, providerReconciliation: proof
    }), { completed: true });
    assert.deepEqual(await store.getPendingByClaimId({
      claimId: claim.claimId, atMs: started.atMs + 3
    }), { found: false, record: null });
  });
});

test("pre-provider not-applied can finalize without provider reconciliation evidence", async () => {
  await withTempDirectory(async (directory) => {
    const store = createStore(join(directory, "a2-actions.json"));
    const claim = await claimAndCreateRecord(store);
    assert.deepEqual(await store.complete({
      claimId: claim.claimId,
      outcome: "not-applied",
      reason: "preflight-failed",
      completedAtMs: NOW + 3
    }), { completed: true });
    assert.deepEqual(await store.reconcile({
      action: claim.record.action, scope: SCOPE, profileId: PROFILE_ID,
      idempotencyKey: claim.idempotencyKey, atMs: NOW + 4
    }), { state: "completed", claimId: claim.claimId });
  });
});

test("pending pagination is bounded and uses stable snapshot cursors", async () => {
  await withTempDirectory(async (directory) => {
    const store = createStore(join(directory, "a2-actions.json"));
    const claims = [];
    for (let index = 0; index < 3; index += 1) {
      const scope = Object.freeze({
        ...SCOPE,
        assetId: "endpoint-" + String(index + 1).padStart(2, "0"),
        incidentId: "incident-" + String(index + 1).padStart(2, "0")
      });
      const idempotencyKey = makeIdempotencyKey("apply-containment-profile", scope, PROFILE_ID);
      const result = await store.claim({
        action: "apply-containment-profile", scope, profileId: PROFILE_ID,
        idempotencyKey, claimedAtMs: NOW + index, expiresAtMs: NOW + 10_000 + index
      });
      assert.equal(result.claimed, true);
      claims.push(result.claimId);
    }
    const first = await store.listPending({ cursor: null, limit: 2, atMs: NOW + 5 });
    assert.equal(first.claimIds.length, 2);
    assert.ok(first.nextCursor);
    const second = await store.listPending({ cursor: first.nextCursor, limit: 2, atMs: NOW + 5 });
    assert.equal(second.claimIds.length, 1);
    assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.claimIds, ...second.claimIds], claims);
  });
});

test("malformed ledger data fails closed and is never overwritten", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "a2-actions.json");
    const store = createStore(filePath);
    const claim = await claimAndCreateRecord(store);
    await store.complete({
      claimId: claim.claimId, outcome: "not-applied",
      reason: "preflight-failed", completedAtMs: NOW + 3
    });
    const original = await readFile(filePath, "utf8");
    await writeFile(filePath, original.replace('"revision":', '"tamperedRevision":'), "utf8");
    const tampered = await readFile(filePath, "utf8");
    await assert.rejects(store.listPending({ cursor: null, limit: 10, atMs: NOW + 4 }));
    await assert.rejects(store.claim({
      action: "apply-containment-profile", scope: SCOPE, profileId: PROFILE_ID,
      idempotencyKey: makeIdempotencyKey(), claimedAtMs: NOW + 5, expiresAtMs: NOW + 20_000
    }));
    assert.equal(await readFile(filePath, "utf8"), tampered);
  });
});
