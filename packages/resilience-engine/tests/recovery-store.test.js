import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createFileRecoveryStore,
  createMemoryRecoveryStore
} from "../src/recovery-store.js";

function proposal(overrides = {}) {
  return Object.freeze({
    schema: "jb.resilience.recovery-proposal/v1",
    proposalId: randomUUID(),
    nonce: randomUUID(),
    action: "restart-service",
    serviceId: "catalog-api.service",
    approvalRequired: false,
    reason: "allowlisted-recovery",
    issuedAt: 1000,
    expiresAt: 61_000,
    ...overrides
  });
}

test("memory recovery store atomically claims once and enforces the attempt cap", async () => {
  const store = createMemoryRecoveryStore();
  const first = proposal();
  const claimed = await store.claimRecovery({
    proposal: first, claimedAt: 1100, maxRestarts: 1
  });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.service.attemptCount, 1);
  assert.equal((await store.claimRecovery({
    proposal: first, claimedAt: 1101, maxRestarts: 1
  })).reason, "proposal-already-claimed");

  await store.completeRecovery({
    proposal: first, completedAt: 1200, outcome: "succeeded"
  });
  const second = proposal({ issuedAt: 1300, expiresAt: 61_300 });
  assert.equal((await store.claimRecovery({
    proposal: second, claimedAt: 1301, maxRestarts: 1
  })).reason, "recovery-attempt-limit-reached");
  assert.equal((await store.getServiceState("catalog-api.service")).lastStatus, "succeeded");
  assert.equal((await store.listRecoveryHistory()).length, 2);
});

test("file recovery store survives re-instantiation and enforces limits across processes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jb-resilience-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "state", "recovery-ledger.json");
  const firstStore = createFileRecoveryStore({ filePath });
  const first = proposal();

  const claim = await firstStore.claimRecovery({
    proposal: first, claimedAt: 1100, maxRestarts: 1
  });
  assert.equal(claim.claimed, true);
  await firstStore.completeRecovery({
    proposal: first, completedAt: 1200, outcome: "succeeded"
  });

  const secondStore = createFileRecoveryStore({ filePath });
  const state = await secondStore.getServiceState("catalog-api.service");
  assert.equal(state.attemptCount, 1);
  assert.equal(state.lastStatus, "succeeded");

  const second = proposal({ issuedAt: 1300, expiresAt: 61_300 });
  assert.equal((await secondStore.claimRecovery({
    proposal: second, claimedAt: 1301, maxRestarts: 1
  })).reason, "recovery-attempt-limit-reached");

  const onDisk = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(onDisk.schema, "jb.resilience.recovery-ledger/v1");
  assert.ok(onDisk.revision >= 2);
});

test("file recovery store serializes concurrent claims of the same proposal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jb-resilience-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "ledger.json");
  const stores = [
    createFileRecoveryStore({ filePath }),
    createFileRecoveryStore({ filePath })
  ];
  const candidate = proposal();
  const results = await Promise.all(stores.map((store) => store.claimRecovery({
    proposal: candidate, claimedAt: 1100, maxRestarts: 2
  })));
  assert.equal(results.filter((result) => result.claimed).length, 1);
  assert.equal(results.filter((result) => result.reason === "proposal-already-claimed").length, 1);
});

test("file recovery store rejects expired proposals and corrupt ledgers without overwriting", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jb-resilience-corrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "ledger.json");
  const store = createFileRecoveryStore({ filePath });
  assert.equal((await store.claimRecovery({
    proposal: proposal({ expiresAt: 1050 }), claimedAt: 1050, maxRestarts: 2
  })).reason, "proposal-expired");

  await writeFile(filePath, "{not-json", "utf8");
  await assert.rejects(() => store.getServiceState("catalog-api.service"), SyntaxError);
  assert.equal(await readFile(filePath, "utf8"), "{not-json");
});

test("file recovery store fails closed while another live process owns the lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jb-resilience-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "ledger.json");
  await writeFile(filePath + ".lock", JSON.stringify({
    pid: process.pid, token: "held-by-test", createdAt: Date.now()
  }), { mode: 0o600 });
  const store = createFileRecoveryStore({
    filePath, lockTimeoutMs: 100, pollIntervalMs: 10
  });
  await assert.rejects(() => store.getServiceState("catalog-api.service"), /ledger is locked/);
});

test("file recovery store validates its configuration and service identifiers", async () => {
  assert.throws(() => createFileRecoveryStore({}), /filePath is required/);
  assert.throws(() => createMemoryRecoveryStore({ maxHistoryEntries: 0 }), /maxHistoryEntries/);
  const store = createMemoryRecoveryStore();
  await assert.rejects(() => store.getServiceState("../unsafe"), /serviceId is invalid/);
});
