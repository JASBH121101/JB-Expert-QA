import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
const TEST_INTEGRITY_KEY_ID = "test-a2-key-v1";
const TEST_INTEGRITY_KEY_HEX = "ab".repeat(32);
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

function runChild(source, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

function createMemoryRevisionAnchor() {
  const states = new Map();
  return Object.freeze({
    async read({ ledgerId }) {
      const value = states.get(ledgerId);
      return value ? { ...value } : null;
    },
    async compareAndSwap({ ledgerId, expected, next }) {
      const current = states.has(ledgerId) ? states.get(ledgerId) : null;
      if (canonical(current) !== canonical(expected)) return false;
      states.set(ledgerId, { ...next });
      return true;
    }
  });
}

function createStore(filePath, overrides = {}) {
  return createFileA2ActionLedger({
    filePath,
    providerId: PROVIDER_ID,
    verifierId: VERIFIER_ID,
    recorderId: RECORDER_ID,
    integrityKeys: { [TEST_INTEGRITY_KEY_ID]: TEST_INTEGRITY_KEY_HEX },
    activeIntegrityKeyId: TEST_INTEGRITY_KEY_ID,
    ...overrides
  });
}

test("file ledger reports whether its external monotonic revision anchor is configured", async () => {
  await withTempDirectory(async (directory) => {
    const localOnly = createStore(join(directory, "local-only.json"));
    const externallyAnchored = createStore(join(directory, "anchored.json"), {
      revisionAnchor: createMemoryRevisionAnchor(),
      ledgerId: "a2-anchor-capability-test"
    });

    assert.equal(localOnly.durable, true);
    assert.equal(localOnly.externalRevisionAnchorConfigured, false);
    assert.equal(externallyAnchored.durable, true);
    assert.equal(externallyAnchored.externalRevisionAnchorConfigured, true);
  });
});

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

test("separate OS processes serialize the same A2 idempotency claim", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "a2-actions.json");
    const input = {
      action: "apply-containment-profile",
      scope: SCOPE,
      profileId: PROFILE_ID,
      idempotencyKey: makeIdempotencyKey(),
      claimedAtMs: NOW,
      expiresAtMs: NOW + 10_000
    };
    const source = [
      'const { createFileA2ActionLedger } = await import(process.env.JB_A2_LEDGER_MODULE);',
      'const store = createFileA2ActionLedger(JSON.parse(process.env.JB_A2_LEDGER_CONFIG));',
      'const result = await store.claim(JSON.parse(process.env.JB_A2_CLAIM));',
      'process.exit(result.claimed ? 23 : 10);'
    ].join(" ");
    const env = {
      JB_A2_LEDGER_MODULE: new URL("../src/a2-action-ledger.js", import.meta.url).href,
      JB_A2_LEDGER_CONFIG: JSON.stringify({
        filePath, providerId: PROVIDER_ID, verifierId: VERIFIER_ID, recorderId: RECORDER_ID,
        integrityKeys: { [TEST_INTEGRITY_KEY_ID]: TEST_INTEGRITY_KEY_HEX },
        activeIntegrityKeyId: TEST_INTEGRITY_KEY_ID
      }),
      JB_A2_CLAIM: JSON.stringify(input)
    };
    const results = await Promise.all([
      runChild(source, env),
      runChild(source, env)
    ]);
    assert.deepEqual(results.map((result) => result.code).sort((a, b) => a - b), [10, 23]);
    const store = createStore(filePath);
    const reconciled = await store.reconcile({
      action: input.action, scope: input.scope, profileId: input.profileId,
      idempotencyKey: input.idempotencyKey, atMs: NOW + 1
    });
    assert.equal(reconciled.state, "claimed");
  });
});

test("A2 provider-start record survives process exit and a fresh store instance", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "a2-actions.json");
    const action = "apply-containment-profile";
    const idempotencyKey = makeIdempotencyKey(action);
    const claim = {
      action, scope: SCOPE, profileId: PROFILE_ID, idempotencyKey,
      claimedAtMs: NOW, expiresAtMs: NOW + 10_000
    };
    const record = {
      schema: "jb.resilience.a2-recovery-record/v1",
      claimId: "replaced-by-child",
      action,
      scope: SCOPE,
      profileId: PROFILE_ID,
      providerId: PROVIDER_ID,
      verifierId: VERIFIER_ID,
      recorderId: RECORDER_ID,
      idempotencyKey,
      state: "claimed",
      originalOperationId: null,
      evidenceRefs: EVIDENCE_REFS,
      createdAtMs: NOW + 1,
      updatedAtMs: NOW + 1,
      leaseExpiresAtMs: NOW + 20_000
    };
    const source = [
      'const { createFileA2ActionLedger } = await import(process.env.JB_A2_LEDGER_MODULE);',
      'const config = JSON.parse(process.env.JB_A2_LEDGER_CONFIG);',
      'const values = JSON.parse(process.env.JB_A2_RESTART_INPUT);',
      'const store = createFileA2ActionLedger(config);',
      'const claim = await store.claim(values.claim);',
      'if (!claim.claimed) process.exit(10);',
      'const record = { ...values.record, claimId: claim.claimId };',
      'const created = await store.createPendingRecord({ record, atMs: record.createdAtMs });',
      'if (!created.created) process.exit(11);',
      'const atMs = record.createdAtMs + 1;',
      'const recoveryRecord = { ...record, state: "provider-started", updatedAtMs: atMs };',
      'const started = await store.markProviderStarted({ claimId: claim.claimId, action: record.action, scope: record.scope, profileId: record.profileId, idempotencyKey: record.idempotencyKey, recoveryRecord, atMs });',
      'if (!started.started) process.exit(12);',
      'process.exit(23);'
    ].join(" ");
    const child = await runChild(source, {
      JB_A2_LEDGER_MODULE: new URL("../src/a2-action-ledger.js", import.meta.url).href,
      JB_A2_LEDGER_CONFIG: JSON.stringify({
        filePath, providerId: PROVIDER_ID, verifierId: VERIFIER_ID, recorderId: RECORDER_ID,
        integrityKeys: { [TEST_INTEGRITY_KEY_ID]: TEST_INTEGRITY_KEY_HEX },
        activeIntegrityKeyId: TEST_INTEGRITY_KEY_ID
      }),
      JB_A2_RESTART_INPUT: JSON.stringify({ claim, record })
    });
    assert.equal(child.code, 23, child.stderr);

    const restartedStore = createStore(filePath);
    const page = await restartedStore.listPending({ cursor: null, limit: 10, atMs: NOW + 3 });
    assert.equal(page.claimIds.length, 1);
    const exact = await restartedStore.getPendingByClaimId({
      claimId: page.claimIds[0], atMs: NOW + 3
    });
    assert.equal(exact.found, true);
    assert.equal(exact.record.state, "provider-started");
    assert.deepEqual(await restartedStore.reconcile({
      action, scope: SCOPE, profileId: PROFILE_ID,
      idempotencyKey, atMs: NOW + 3
    }), { state: "provider-started", claimId: page.claimIds[0] });
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

test("public action-ledger methods reject accessors and unsupported input fields without invoking getters", async () => {
  await withTempDirectory(async (directory) => {
    const store = createStore(join(directory, "a2-actions.json"));
    let getterCalled = false;
    const hostile = {
      scope: SCOPE,
      profileId: PROFILE_ID,
      idempotencyKey: makeIdempotencyKey(),
      claimedAtMs: NOW,
      expiresAtMs: NOW + 10_000
    };
    Object.defineProperty(hostile, "action", {
      enumerable: true,
      get() {
        getterCalled = true;
        return "apply-containment-profile";
      }
    });
    await assert.rejects(store.claim(hostile), /accessors/);
    assert.equal(getterCalled, false);
    await assert.rejects(store.claim({
      action: "apply-containment-profile",
      scope: SCOPE,
      profileId: PROFILE_ID,
      idempotencyKey: makeIdempotencyKey(),
      claimedAtMs: NOW,
      expiresAtMs: NOW + 10_000,
      extraPermission: true
    }), /unsupported fields/);
  });
});

test("file ledger rejects identity collisions and unsafe option bounds", async () => {
  await withTempDirectory(async (directory) => {
    assert.throws(() => createFileA2ActionLedger({
      filePath: join(directory, "invalid.json"),
      providerId: "same", verifierId: "same", recorderId: "recorder"
    }), /identities must differ/);
    assert.throws(() => createStore(join(directory, "invalid-limit.json"), {
      maxClaims: 0
    }), /maxClaims is invalid/);
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

test("file ledger refuses symbolic-link journal paths without reading their targets", async (t) => {
  await withTempDirectory(async (directory) => {
    const targetPath = join(directory, "external.json");
    const filePath = join(directory, "a2-actions.json");
    const externalContent = "EXTERNAL_TARGET_SENTINEL";
    await writeFile(targetPath, externalContent, "utf8");
    try {
      await symlink(targetPath, filePath);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip("The current operating system does not permit creating a test symbolic link");
        return;
      }
      throw error;
    }
    const store = createStore(filePath);
    await assert.rejects(
      store.listPending({ cursor: null, limit: 10, atMs: NOW }),
      /regular file|symbolic link/
    );
    assert.equal(await readFile(targetPath, "utf8"), externalContent);
  });
});


test("read-only access initializes an empty journal that accepts a later claim", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "a2-actions.json");
    const store = createStore(filePath);
    assert.deepEqual(await store.listPending({
      cursor: null, limit: 10, atMs: NOW
    }), { claimIds: [], nextCursor: null });
    assert.ok((await readFile(filePath, "utf8")).includes("jb.resilience.a2-action-ledger/v1"));
    assert.match(await readFile(filePath + ".guard", "utf8"), /ledgerSha256/);
    const claim = await store.claim({
      action: "apply-containment-profile",
      scope: SCOPE,
      profileId: PROFILE_ID,
      idempotencyKey: makeIdempotencyKey(),
      claimedAtMs: NOW + 1,
      expiresAtMs: NOW + 10_000
    });
    assert.equal(claim.claimed, true);
  });
});

test("file ledger detects loss, rollback, same-revision tampering and guard deletion", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "a2-actions.json");
    const guardPath = filePath + ".guard";
    const store = createStore(filePath);
    const claim = await claimAndCreateRecord(store);
    const earlierLedger = await readFile(filePath, "utf8");
    assert.match(await readFile(guardPath, "utf8"), /ledgerSha256/);

    await store.complete({
      claimId: claim.claimId,
      outcome: "held-for-reconciliation",
      reason: "backup-guard-test",
      completedAtMs: NOW + 4
    });
    const latestLedger = await readFile(filePath, "utf8");

    await writeFile(filePath, earlierLedger, "utf8");
    await assert.rejects(
      store.listPending({ cursor: null, limit: 10, atMs: NOW + 5 }),
      /rolled back|diverges/
    );

    await writeFile(filePath, latestLedger, "utf8");
    const restored = await store.listPending({ cursor: null, limit: 10, atMs: NOW + 5 });
    assert.deepEqual(restored.claimIds, [claim.claimId]);

    // An ahead-of-guard single-revision change is ambiguous and must not be
    // auto-promoted, even though a crash after ledger rename could cause it.
    const trustedGuard = await readFile(guardPath, "utf8");
    const oneStepAhead = JSON.parse(latestLedger);
    oneStepAhead.revision += 1;
    await writeFile(filePath, JSON.stringify(oneStepAhead) + "\n", "utf8");
    await assert.rejects(
      store.listPending({ cursor: null, limit: 10, atMs: NOW + 6 }),
      /revision diverges.*manual review/
    );
    assert.equal(await readFile(guardPath, "utf8"), trustedGuard);
    await writeFile(filePath, latestLedger, "utf8");

    await unlink(filePath);
    await assert.rejects(
      store.listPending({ cursor: null, limit: 10, atMs: NOW + 6 }),
      /missing while its cryptographic guard exists/
    );

    await writeFile(filePath, latestLedger, "utf8");
    const recovered = await store.listPending({ cursor: null, limit: 10, atMs: NOW + 7 });
    assert.deepEqual(recovered.claimIds, [claim.claimId]);

    // Same-revision tampering must fail even when the modified JSON remains valid.
    const alteredLedger = latestLedger.replace("backup-guard-test", "tampered-guard-test");
    assert.notEqual(alteredLedger, latestLedger);
    await writeFile(filePath, alteredLedger, "utf8");
    await assert.rejects(
      store.listPending({ cursor: null, limit: 10, atMs: NOW + 8 }),
      /digest does not match/
    );
    await writeFile(filePath, latestLedger, "utf8");

    // Removing only the guard must never establish a new trust baseline for
    // an already-used journal.
    await unlink(guardPath);
    await assert.rejects(
      store.listPending({ cursor: null, limit: 10, atMs: NOW + 9 }),
      /cryptographic guard is missing/
    );
  });
});



test("file A2 ledger authenticates its guard with HMAC and rejects tampering or an unavailable key", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "a2-actions.json");
    const store = createStore(filePath);
    await claimAndCreateRecord(store);
    const guardPath = filePath + ".guard";
    const guard = JSON.parse(await readFile(guardPath, "utf8"));
    assert.equal(guard.schema, "jb.resilience.a2-action-ledger-guard/v2");
    assert.equal(guard.keyId, TEST_INTEGRITY_KEY_ID);
    assert.match(guard.hmacSha256, /^[a-f0-9]{64}$/);

    guard.revision += 1;
    await writeFile(guardPath, JSON.stringify(guard) + "\n", "utf8");
    await assert.rejects(
      store.listPending({ cursor: null, limit: 10, atMs: NOW + 3 }),
      /HMAC authentication failed/
    );
  });

  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "a2-actions.json");
    const original = createStore(filePath);
    await claimAndCreateRecord(original);
    const wrongKeyStore = createStore(filePath, {
      integrityKeys: { "attacker-key": "cd".repeat(32) },
      activeIntegrityKeyId: "attacker-key"
    });
    await assert.rejects(
      wrongKeyStore.listPending({ cursor: null, limit: 10, atMs: NOW + 3 }),
      /HMAC authentication failed/
    );
  });
});

test("A2 guard key rotation verifies the previous key and re-signs with the active key", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "a2-actions.json");
    const oldKeyId = "a2-test-old";
    const newKeyId = "a2-test-new";
    const oldKey = "11".repeat(32);
    const newKey = "22".repeat(32);
    const oldStore = createStore(filePath, {
      integrityKeys: { [oldKeyId]: oldKey },
      activeIntegrityKeyId: oldKeyId
    });
    const claim = await claimAndCreateRecord(oldStore);
    const guardPath = filePath + ".guard";
    assert.equal(JSON.parse(await readFile(guardPath, "utf8")).keyId, oldKeyId);

    const rotatingStore = createStore(filePath, {
      integrityKeys: { [oldKeyId]: oldKey, [newKeyId]: newKey },
      activeIntegrityKeyId: newKeyId
    });
    const page = await rotatingStore.listPending({ cursor: null, limit: 10, atMs: NOW + 2 });
    assert.deepEqual(page.claimIds, [claim.claimId]);
    const rotatedGuard = JSON.parse(await readFile(guardPath, "utf8"));
    assert.equal(rotatedGuard.keyId, newKeyId);
    assert.match(rotatedGuard.hmacSha256, /^[a-f0-9]{64}$/);

    const newOnlyStore = createStore(filePath, {
      integrityKeys: { [newKeyId]: newKey },
      activeIntegrityKeyId: newKeyId
    });
    assert.deepEqual(
      await newOnlyStore.listPending({ cursor: null, limit: 10, atMs: NOW + 2 }),
      { claimIds: [claim.claimId], nextCursor: null }
    );
  });
});


test("external monotonic revision anchor rejects coordinated restoration of an older journal and HMAC guard", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "a2-actions.json");
    const anchor = createMemoryRevisionAnchor();
    const options = {
      revisionAnchor: anchor,
      ledgerId: "a2-lab-ledger-01"
    };
    const store = createStore(filePath, options);

    // Establish the external anchor for the empty journal and preserve a
    // cryptographically valid old pair of local files.
    await store.listPending({ cursor: null, limit: 10, atMs: NOW });
    const earlierLedger = await readFile(filePath, "utf8");
    const earlierGuard = await readFile(filePath + ".guard", "utf8");

    const claim = await claimAndCreateRecord(store);
    const committed = await store.getPendingByClaimId({
      claimId: claim.claimId,
      atMs: NOW + 2
    });
    assert.equal(committed.found, true);

    // Both local files are restored together, so their HMAC is still valid.
    // The independently stored monotonic anchor must reject this paired replay.
    await writeFile(filePath, earlierLedger, "utf8");
    await writeFile(filePath + ".guard", earlierGuard, "utf8");
    const restarted = createStore(filePath, options);
    await assert.rejects(
      restarted.listPending({ cursor: null, limit: 10, atMs: NOW + 3 }),
      /external monotonic revision anchor does not match/
    );
  });
});

test("external revision-anchor CAS failure holds the journal after local commit", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "a2-actions.json");
    const backing = createMemoryRevisionAnchor();
    const refusingAnchor = Object.freeze({
      read: (input) => backing.read(input),
      compareAndSwap: (input) => input.next.revision === 0
        ? backing.compareAndSwap(input)
        : Promise.resolve(false)
    });
    const store = createStore(filePath, {
      revisionAnchor: refusingAnchor,
      ledgerId: "a2-cas-failure-ledger"
    });
    await store.listPending({ cursor: null, limit: 10, atMs: NOW });

    await assert.rejects(
      store.claim({
        action: "apply-containment-profile",
        scope: SCOPE,
        profileId: PROFILE_ID,
        idempotencyKey: makeIdempotencyKey(),
        claimedAtMs: NOW + 1,
        expiresAtMs: NOW + 10_000
      }),
      /compare-and-swap failed after local journal commit/
    );
    await assert.rejects(
      store.listPending({ cursor: null, limit: 10, atMs: NOW + 2 }),
      /external monotonic revision anchor does not match/
    );
  });
});


test("A2 does not bootstrap an empty journal when the external anchor survives loss of both local files", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, "a2-actions.json");
    const anchor = createMemoryRevisionAnchor();
    const options = {
      revisionAnchor: anchor,
      ledgerId: "a2-lost-local-files"
    };
    const store = createStore(filePath, options);
    await store.listPending({ cursor: null, limit: 10, atMs: NOW });
    await claimAndCreateRecord(store);

    await unlink(filePath);
    await unlink(filePath + ".guard");
    const restarted = createStore(filePath, options);
    await assert.rejects(
      restarted.listPending({ cursor: null, limit: 10, atMs: NOW + 3 }),
      /journal and guard are missing while the external revision anchor exists/
    );
    await assert.rejects(readFile(filePath, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(filePath + ".guard", "utf8"), { code: "ENOENT" });
  });
});