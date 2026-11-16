import { createHash, randomUUID } from "node:crypto";
import {
  mkdir, open, readFile, rename, unlink, lstat
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { validateTrustedSignalEnvelope } from "./trusted-signal-gateway.js";

const LEDGER_SCHEMA = "jb.resilience.trusted-signal-ledger/v1";
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(label + " must be a non-negative safe integer");
  }
}

function digestFor(signal) {
  return createHash("sha256")
    .update(JSON.stringify({ ...signal, evidenceRefs: signal.evidenceRefs }), "utf8")
    .digest("hex");
}

function replayKey(signal) {
  return signal.sourceId + ":" + signal.eventId;
}

function emptyLedger() {
  return { schema: LEDGER_SCHEMA, revision: 0, records: [] };
}

function validateLedger(value, maxRecords) {
  if (!isRecord(value) || value.schema !== LEDGER_SCHEMA ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !Array.isArray(value.records) || value.records.length > maxRecords) {
    throw new Error("trusted-signal ledger is malformed; refusing to overwrite it");
  }

  const seen = new Set();
  for (const record of value.records) {
    if (!isRecord(record) ||
        Object.keys(record).length !== 4 ||
        !Object.hasOwn(record, "signal") ||
        !Object.hasOwn(record, "signalDigest") ||
        !Object.hasOwn(record, "receivedAtMs") ||
        !Object.hasOwn(record, "retentionUntilMs")) {
      throw new Error("trusted-signal ledger contains an invalid record");
    }
    const signal = validateTrustedSignalEnvelope(record.signal);
    assertTimestamp(record.receivedAtMs, "receivedAtMs");
    assertTimestamp(record.retentionUntilMs, "retentionUntilMs");
    if (record.retentionUntilMs < signal.expiresAtMs ||
        typeof record.signalDigest !== "string" ||
        !SHA256.test(record.signalDigest) ||
        digestFor(signal) !== record.signalDigest) {
      throw new Error("trusted-signal ledger integrity check failed");
    }
    const key = replayKey(signal);
    if (seen.has(key)) throw new Error("trusted-signal ledger contains duplicate replay keys");
    seen.add(key);
  }
  return value;
}

function cloneStoredRecord(record) {
  const signal = validateTrustedSignalEnvelope(record.signal);
  return Object.freeze({
    signal,
    signalDigest: record.signalDigest,
    receivedAtMs: record.receivedAtMs,
    retentionUntilMs: record.retentionUntilMs
  });
}

/**
 * Durable, single-host replay storage for the Trusted Signal Gateway.
 *
 * Writes are serialized across local processes with an exclusive lock file.
 * Each mutation is fsynced and atomically renamed. This is not a distributed
 * database and must not be placed on an eventually consistent network share.
 */
export function createFileTrustedSignalStore({
  filePath,
  lockTimeoutMs = 5000,
  lockStaleMs = 120_000,
  pollIntervalMs = 25,
  maxRecords = 10_000,
  maxLedgerBytes = 16 * 1024 * 1024
} = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new TypeError("filePath is required");
  }
  for (const [name, value, min, max] of [
    ["lockTimeoutMs", lockTimeoutMs, 100, 60_000],
    ["lockStaleMs", lockStaleMs, 1000, 86_400_000],
    ["pollIntervalMs", pollIntervalMs, 5, 1000],
    ["maxRecords", maxRecords, 1, 10_000],
    ["maxLedgerBytes", maxLedgerBytes, 1024, 64 * 1024 * 1024]
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
        throw new Error("trusted-signal ledger path must be a regular file, not a symbolic link");
      }
      if (metadata.size > maxLedgerBytes) {
        throw new Error("trusted-signal ledger exceeds the configured size limit");
      }
      return validateLedger(JSON.parse(await readFile(target, "utf8")), maxRecords);
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
      const serialized = JSON.stringify(ledger) + "\n";
      if (Buffer.byteLength(serialized, "utf8") > maxLedgerBytes) {
        throw new Error("trusted-signal ledger exceeds the configured size limit");
      }
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, target);
      try {
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch (error) {
        if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES"].includes(error?.code)) {
          throw error;
        }
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
      [before, metadata] = await Promise.all([
        readFile(lockPath, "utf8"),
        lstat(lockPath)
      ]);
      if (metadata.isSymbolicLink() || !metadata.isFile()) return false;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      return false;
    }

    let owner;
    try {
      owner = JSON.parse(before);
    } catch {}

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
      const [current, currentMetadata] = await Promise.all([
        readFile(lockPath, "utf8"),
        lstat(lockPath)
      ]);
      if (current !== before ||
          currentMetadata.ino !== metadata.ino ||
          currentMetadata.mtimeMs !== metadata.mtimeMs) {
        return false;
      }
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
          pid: process.pid,
          token,
          createdAt: Date.now()
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
          throw new Error("trusted-signal ledger is locked; no operation was performed");
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
        if (current.token === token && current.pid === process.pid) {
          await unlink(lockPath);
        }
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

  async function recordSignal({
    signal: inputSignal,
    signalDigest,
    receivedAtMs,
    retentionUntilMs
  } = {}) {
    const signal = validateTrustedSignalEnvelope(inputSignal);
    assertTimestamp(receivedAtMs, "receivedAtMs");
    assertTimestamp(retentionUntilMs, "retentionUntilMs");
    if (retentionUntilMs < signal.expiresAtMs) {
      throw new TypeError("retentionUntilMs must be at least expiresAtMs");
    }
    if (typeof signalDigest !== "string" || !SHA256.test(signalDigest) ||
        digestFor(signal) !== signalDigest) {
      throw new TypeError("signalDigest does not match the trusted signal");
    }

    return mutate(async (ledger) => {
      const key = replayKey(signal);
      const existing = ledger.records.find((record) => replayKey(record.signal) === key);
      if (existing) {
        return {
          changed: false,
          value: Object.freeze({
            recorded: false,
            reason: existing.signalDigest === signalDigest
              ? "signal-replay"
              : "signal-id-conflict"
          })
        };
      }
      if (ledger.records.length >= maxRecords) {
        return {
          changed: false,
          value: Object.freeze({ recorded: false, reason: "replay-store-capacity-exceeded" })
        };
      }
      ledger.records.push({
        signal,
        signalDigest,
        receivedAtMs,
        retentionUntilMs
      });
      return {
        changed: true,
        value: Object.freeze({ recorded: true })
      };
    });
  }

  async function listSignals({ assetId, environment, sinceMs } = {}) {
    if (typeof assetId !== "string" || !ASSET_ID.test(assetId)) {
      throw new TypeError("assetId is invalid");
    }
    if (typeof environment !== "string" || !IDENTIFIER.test(environment)) {
      throw new TypeError("environment is invalid");
    }
    assertTimestamp(sinceMs, "sinceMs");

    return withLock(async () => {
      const ledger = await loadLedger();
      return Object.freeze(ledger.records
        .filter((record) =>
          record.signal.assetId === assetId &&
          record.signal.environment === environment &&
          record.signal.issuedAtMs >= sinceMs
        )
        .sort((left, right) =>
          left.signal.issuedAtMs - right.signal.issuedAtMs ||
          left.signal.eventId.localeCompare(right.signal.eventId)
        )
        .map(cloneStoredRecord));
    });
  }

  return Object.freeze({
    durable: true,
    filePath: target,
    recordSignal,
    listSignals
  });
}
