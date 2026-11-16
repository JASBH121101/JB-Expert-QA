import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";

const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const STORE_SCHEMA = "jb.resilience.recovery-ledger/v1";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateProposal(proposal) {
  if (!isRecord(proposal) ||
      proposal.schema !== "jb.resilience.recovery-proposal/v1" ||
      typeof proposal.proposalId !== "string" || proposal.proposalId.length < 8 ||
      proposal.proposalId.length > 128 ||
      typeof proposal.nonce !== "string" || proposal.nonce.length < 8 ||
      proposal.nonce.length > 128 ||
      typeof proposal.serviceId !== "string" || !SERVICE_ID.test(proposal.serviceId) ||
      proposal.action !== "restart-service" ||
      !Number.isSafeInteger(proposal.issuedAt) || proposal.issuedAt < 0 ||
      !Number.isSafeInteger(proposal.expiresAt) || proposal.expiresAt <= proposal.issuedAt) {
    throw new TypeError("recovery proposal is invalid");
  }
}

function validateClaimInput({ proposal, claimedAt, maxRestarts } = {}) {
  validateProposal(proposal);
  if (!Number.isSafeInteger(claimedAt) || claimedAt < 0 ||
      !Number.isSafeInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 5) {
    throw new TypeError("recovery claim limits are invalid");
  }
}

function validateCompletionInput({ proposal, completedAt, outcome } = {}) {
  validateProposal(proposal);
  if (!Number.isSafeInteger(completedAt) || completedAt < 0 ||
      !["succeeded", "failed", "unverified", "verification-failed"].includes(outcome)) {
    throw new TypeError("recovery completion is invalid");
  }
}

function emptyLedger() {
  return { schema: STORE_SCHEMA, revision: 0, services: {}, proposals: {}, history: [] };
}

function validateLedger(value) {
  if (!isRecord(value) || value.schema !== STORE_SCHEMA ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !isRecord(value.services) || !isRecord(value.proposals) ||
      !Array.isArray(value.history)) {
    throw new Error("recovery ledger is malformed; refusing to overwrite it");
  }
  for (const [serviceId, service] of Object.entries(value.services)) {
    if (!SERVICE_ID.test(serviceId) || !isRecord(service) ||
        !Number.isSafeInteger(service.attemptCount) || service.attemptCount < 0) {
      throw new Error("recovery ledger contains an invalid service record");
    }
  }
  for (const [proposalId, proposal] of Object.entries(value.proposals)) {
    if (proposalId !== proposal?.proposalId ||
        !["claimed", "succeeded", "failed", "unverified", "verification-failed"].includes(proposal.status)) {
      throw new Error("recovery ledger contains an invalid proposal record");
    }
  }
  return value;
}

function serviceSnapshot(service) {
  return Object.freeze({
    attemptCount: service?.attemptCount ?? 0,
    lastAttemptAt: service?.lastAttemptAt ?? null,
    lastCompletedAt: service?.lastCompletedAt ?? null,
    lastStatus: service?.lastStatus ?? "unknown",
    lastProposalId: service?.lastProposalId ?? null
  });
}

function appendHistory(ledger, entry, maxHistoryEntries) {
  ledger.history.push(Object.freeze({ ...entry }));
  if (ledger.history.length > maxHistoryEntries) {
    ledger.history.splice(0, ledger.history.length - maxHistoryEntries);
  }
}

function pruneExpiredProposals(ledger, now) {
  for (const [proposalId, proposal] of Object.entries(ledger.proposals)) {
    if (proposal.expiresAt <= now && proposal.status !== "claimed") {
      delete ledger.proposals[proposalId];
    }
  }
}

export function createMemoryRecoveryStore({ maxHistoryEntries = 1000 } = {}) {
  if (!Number.isSafeInteger(maxHistoryEntries) || maxHistoryEntries < 1 || maxHistoryEntries > 10_000) {
    throw new TypeError("maxHistoryEntries must be between 1 and 10000");
  }
  const ledger = emptyLedger();

  async function claimRecovery(input) {
    validateClaimInput(input);
    const { proposal, claimedAt, maxRestarts } = input;
    if (claimedAt >= proposal.expiresAt) return Object.freeze({ claimed: false, reason: "proposal-expired" });
    pruneExpiredProposals(ledger, claimedAt);
    if (ledger.proposals[proposal.proposalId] ||
        Object.values(ledger.proposals).some((entry) => entry.nonce === proposal.nonce)) {
      return Object.freeze({ claimed: false, reason: "proposal-already-claimed" });
    }
    const service = ledger.services[proposal.serviceId] ?? {
      attemptCount: 0, lastAttemptAt: null, lastCompletedAt: null,
      lastStatus: "unknown", lastProposalId: null
    };
    if (service.attemptCount >= maxRestarts) {
      return Object.freeze({ claimed: false, reason: "recovery-attempt-limit-reached" });
    }
    service.attemptCount += 1;
    service.lastAttemptAt = claimedAt;
    service.lastStatus = "claimed";
    service.lastProposalId = proposal.proposalId;
    ledger.services[proposal.serviceId] = service;
    ledger.proposals[proposal.proposalId] = {
      proposalId: proposal.proposalId, nonce: proposal.nonce,
      serviceId: proposal.serviceId, action: proposal.action,
      issuedAt: proposal.issuedAt, expiresAt: proposal.expiresAt,
      claimedAt, completedAt: null, status: "claimed"
    };
    ledger.revision += 1;
    appendHistory(ledger, {
      type: "claimed", proposalId: proposal.proposalId,
      serviceId: proposal.serviceId, at: claimedAt
    }, maxHistoryEntries);
    return Object.freeze({ claimed: true, service: serviceSnapshot(service) });
  }

  async function completeRecovery(input) {
    validateCompletionInput(input);
    const { proposal, completedAt, outcome } = input;
    const entry = ledger.proposals[proposal.proposalId];
    if (!entry || entry.nonce !== proposal.nonce || entry.serviceId !== proposal.serviceId ||
        entry.status !== "claimed") {
      throw new Error("recovery claim is missing, mismatched, or already finalized");
    }
    entry.status = outcome;
    entry.completedAt = completedAt;
    const service = ledger.services[proposal.serviceId];
    service.lastCompletedAt = completedAt;
    service.lastStatus = outcome;
    ledger.revision += 1;
    appendHistory(ledger, {
      type: outcome, proposalId: proposal.proposalId,
      serviceId: proposal.serviceId, at: completedAt
    }, maxHistoryEntries);
    return Object.freeze({ recorded: true, service: serviceSnapshot(service) });
  }

  async function getServiceState(serviceId) {
    if (typeof serviceId !== "string" || !SERVICE_ID.test(serviceId)) {
      throw new TypeError("serviceId is invalid");
    }
    return serviceSnapshot(ledger.services[serviceId]);
  }

  async function listRecoveryHistory({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxHistoryEntries) {
      throw new TypeError("history limit is invalid");
    }
    return Object.freeze(ledger.history.slice(-limit).map((entry) => Object.freeze({ ...entry })));
  }

  return Object.freeze({
    durable: false,
    claimRecovery,
    completeRecovery,
    getServiceState,
    listRecoveryHistory
  });
}

export function createFileRecoveryStore({
  filePath,
  lockTimeoutMs = 5000,
  lockStaleMs = 120_000,
  pollIntervalMs = 25,
  maxHistoryEntries = 1000,
  maxServices = 1000
} = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new TypeError("filePath is required");
  }
  for (const [name, value, min, max] of [
    ["lockTimeoutMs", lockTimeoutMs, 100, 60_000],
    ["lockStaleMs", lockStaleMs, 1000, 86_400_000],
    ["pollIntervalMs", pollIntervalMs, 5, 1000],
    ["maxHistoryEntries", maxHistoryEntries, 1, 10_000],
    ["maxServices", maxServices, 1, 10_000]
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new TypeError(name + " is invalid");
    }
  }

  const target = resolve(filePath);
  const directory = dirname(target);
  const lockPath = target + ".lock";

  async function loadLedger() {
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error("recovery ledger path must be a regular file, not a symbolic link");
      }
      const parsed = JSON.parse(await readFile(target, "utf8"));
      return validateLedger(parsed);
    } catch (error) {
      if (error?.code === "ENOENT") return emptyLedger();
      throw error;
    }
  }

  async function persistLedger(ledger) {
    const temporaryPath = target + "." + process.pid + "." + randomUUID() + ".tmp";
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify(ledger) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, target);
      try {
        const directoryHandle = await open(directory, "r");
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch (error) {
        if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES"].includes(error?.code)) throw error;
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporaryPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async function reclaimDeadLock() {
    let before;
    let metadata;
    try {
      [before, metadata] = await Promise.all([readFile(lockPath, "utf8"), lstat(lockPath)]);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      return false;
    }

    let owner;
    try { owner = JSON.parse(before); } catch {}
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        if (error?.code !== "ESRCH") return false;
      }
    } else if (Date.now() - metadata.mtimeMs < lockStaleMs) {
      return false;
    }

    try {
      const [current, currentMetadata] = await Promise.all([readFile(lockPath, "utf8"), lstat(lockPath)]);
      if (current !== before || currentMetadata.ino !== metadata.ino ||
          currentMetadata.mtimeMs !== metadata.mtimeMs) return false;
      await unlink(lockPath);
      return true;
    } catch (error) {
      return error?.code === "ENOENT";
    }
  }

  async function withLock(operation) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const started = performance.now();
    const token = randomUUID();
    let lockHandle;

    while (!lockHandle) {
      try {
        lockHandle = await open(lockPath, "wx", 0o600);
        await lockHandle.writeFile(JSON.stringify({
          pid: process.pid, token, createdAt: Date.now()
        }), "utf8");
        await lockHandle.sync();
      } catch (error) {
        if (lockHandle) {
          await lockHandle.close().catch(() => {});
          lockHandle = null;
          await unlink(lockPath).catch(() => {});
        }
        if (error?.code !== "EEXIST") throw error;
        await reclaimDeadLock();
        if (performance.now() - started >= lockTimeoutMs) {
          throw new Error("recovery ledger is locked; no operation was performed");
        }
        await delay(pollIntervalMs);
      }
    }

    try {
      return await operation();
    } finally {
      await lockHandle.close().catch(() => {});
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8"));
        if (current.token === token && current.pid === process.pid) await unlink(lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  async function mutate(operation) {
    return withLock(async () => {
      const ledger = await loadLedger();
      const result = await operation(ledger);
      if (result.changed) {
        ledger.revision += 1;
        await persistLedger(ledger);
      }
      return result.value;
    });
  }

  async function claimRecovery(input) {
    validateClaimInput(input);
    return mutate(async (ledger) => {
      const { proposal, claimedAt, maxRestarts } = input;
      if (claimedAt >= proposal.expiresAt) {
        return { changed: false, value: Object.freeze({ claimed: false, reason: "proposal-expired" }) };
      }
      pruneExpiredProposals(ledger, claimedAt);
      if (ledger.proposals[proposal.proposalId] ||
          Object.values(ledger.proposals).some((entry) => entry.nonce === proposal.nonce)) {
        return { changed: false, value: Object.freeze({ claimed: false, reason: "proposal-already-claimed" }) };
      }
      const serviceIds = Object.keys(ledger.services);
      if (!ledger.services[proposal.serviceId] && serviceIds.length >= maxServices) {
        return { changed: false, value: Object.freeze({ claimed: false, reason: "recovery-store-capacity-reached" }) };
      }
      const service = ledger.services[proposal.serviceId] ?? {
        attemptCount: 0, lastAttemptAt: null, lastCompletedAt: null,
        lastStatus: "unknown", lastProposalId: null
      };
      if (service.attemptCount >= maxRestarts) {
        return { changed: false, value: Object.freeze({ claimed: false, reason: "recovery-attempt-limit-reached" }) };
      }
      service.attemptCount += 1;
      service.lastAttemptAt = claimedAt;
      service.lastStatus = "claimed";
      service.lastProposalId = proposal.proposalId;
      ledger.services[proposal.serviceId] = service;
      ledger.proposals[proposal.proposalId] = {
        proposalId: proposal.proposalId, nonce: proposal.nonce,
        serviceId: proposal.serviceId, action: proposal.action,
        issuedAt: proposal.issuedAt, expiresAt: proposal.expiresAt,
        claimedAt, completedAt: null, status: "claimed"
      };
      appendHistory(ledger, {
        type: "claimed", proposalId: proposal.proposalId,
        serviceId: proposal.serviceId, at: claimedAt
      }, maxHistoryEntries);
      return { changed: true, value: Object.freeze({ claimed: true, service: serviceSnapshot(service) }) };
    });
  }

  async function completeRecovery(input) {
    validateCompletionInput(input);
    return mutate(async (ledger) => {
      const { proposal, completedAt, outcome } = input;
      const entry = ledger.proposals[proposal.proposalId];
      if (!entry || entry.nonce !== proposal.nonce || entry.serviceId !== proposal.serviceId ||
          entry.status !== "claimed") {
        throw new Error("recovery claim is missing, mismatched, or already finalized");
      }
      entry.status = outcome;
      entry.completedAt = completedAt;
      const service = ledger.services[proposal.serviceId];
      service.lastCompletedAt = completedAt;
      service.lastStatus = outcome;
      appendHistory(ledger, {
        type: outcome, proposalId: proposal.proposalId,
        serviceId: proposal.serviceId, at: completedAt
      }, maxHistoryEntries);
      return { changed: true, value: Object.freeze({ recorded: true, service: serviceSnapshot(service) }) };
    });
  }

  async function getServiceState(serviceId) {
    if (typeof serviceId !== "string" || !SERVICE_ID.test(serviceId)) {
      throw new TypeError("serviceId is invalid");
    }
    return withLock(async () => {
      const ledger = await loadLedger();
      return serviceSnapshot(ledger.services[serviceId]);
    });
  }

  async function listRecoveryHistory({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxHistoryEntries) {
      throw new TypeError("history limit is invalid");
    }
    return withLock(async () => {
      const ledger = await loadLedger();
      return Object.freeze(ledger.history.slice(-limit).map((entry) => Object.freeze({ ...entry })));
    });
  }

  return Object.freeze({
    durable: true,
    filePath: target,
    claimRecovery,
    completeRecovery,
    getServiceState,
    listRecoveryHistory
  });
}
