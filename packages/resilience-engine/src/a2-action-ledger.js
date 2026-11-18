import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  mkdir, open, readFile, rename, unlink, lstat
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";

const LEDGER_SCHEMA = "jb.resilience.a2-action-ledger/v1";
const GUARD_SCHEMA = "jb.resilience.a2-action-ledger-guard/v2";
const INTEGRITY_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const RECORD_SCHEMA = "jb.resilience.a2-recovery-record/v1";
const SCOPE_KEYS = Object.freeze([
  "assetId", "environment", "incidentId", "policyId", "policyRevision", "policyHash"
]);
const RECORD_KEYS = Object.freeze([
  "schema", "claimId", "action", "scope", "profileId", "providerId",
  "verifierId", "recorderId", "idempotencyKey", "state",
  "originalOperationId", "evidenceRefs", "createdAtMs",
  "updatedAtMs", "leaseExpiresAtMs"
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ACTIONS = new Set(["apply-containment-profile", "release-containment"]);
const TERMINAL_OUTCOMES = new Set(["succeeded", "not-applied"]);
const ACTIVE_STATUSES = new Set(["claimed", "provider-started"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(label + " must be a plain data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new TypeError(label + " has missing or unsupported fields");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " must contain enumerable data properties only");
    }
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(label + " is invalid");
  }
  return value;
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(label + " is invalid");
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(value[key])
  ).join(",") + "}";
}

function operationKey(action, scope, profileId) {
  return createHash("sha256").update(canonicalJson({
    schema: "jb.resilience.a2-operation-key/v1",
    action,
    scope,
    profileId
  }), "utf8").digest("hex");
}

function normalizeScope(input) {
  exactKeys(input, SCOPE_KEYS, "A2 action scope");
  const scope = Object.create(null);
  for (const key of SCOPE_KEYS) {
    const value = input[key];
    if (key === "policyRevision") {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("policyRevision is invalid");
    } else if (key === "policyHash") {
      if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError("policyHash is invalid");
    } else {
      assertIdentifier(value, key);
    }
    scope[key] = value;
  }
  return Object.freeze(scope);
}

function normalizeEvidenceRefs(input) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length < 1 || input.length > 128 ||
      Object.getOwnPropertySymbols(input).length !== 0 ||
      Reflect.ownKeys(input).length !== input.length + 1) {
    throw new TypeError("A2 evidence references must be a dense plain array");
  }
  const seen = new Set();
  const refs = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("A2 evidence references must not contain holes or accessors");
    }
    const item = descriptor.value;
    exactKeys(item, ["refId", "sha256"], "A2 evidence reference");
    const refId = assertIdentifier(item.refId, "evidence refId");
    if (typeof item.sha256 !== "string" || !SHA256.test(item.sha256) || seen.has(refId)) {
      throw new TypeError("A2 evidence reference digest or identity is invalid");
    }
    seen.add(refId);
    refs.push(Object.freeze({ refId, sha256: item.sha256 }));
  }
  return Object.freeze(refs);
}

function normalizeRecoveryRecord(input, identities) {
  exactKeys(input, RECORD_KEYS, "A2 recovery record");
  if (input.schema !== RECORD_SCHEMA) throw new TypeError("A2 recovery record schema is unsupported");
  const claimId = assertIdentifier(input.claimId, "claimId");
  const action = input.action;
  if (!ACTIONS.has(action)) throw new TypeError("A2 recovery action is invalid");
  const scope = normalizeScope(input.scope);
  const profileId = assertIdentifier(input.profileId, "profileId");
  const providerId = assertIdentifier(input.providerId, "providerId");
  const verifierId = assertIdentifier(input.verifierId, "verifierId");
  const recorderId = assertIdentifier(input.recorderId, "recorderId");
  if (providerId !== identities.providerId || verifierId !== identities.verifierId ||
      recorderId !== identities.recorderId ||
      new Set([providerId, verifierId, recorderId]).size !== 3) {
    throw new TypeError("A2 recovery adapter identities do not match the file ledger");
  }
  if (typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey !== operationKey(action, scope, profileId)) {
    throw new TypeError("A2 recovery idempotency key is invalid");
  }
  const state = input.state;
  if (!["claimed", "provider-started", "held-for-reconciliation"].includes(state)) {
    throw new TypeError("A2 recovery state is invalid");
  }
  const originalOperationId = input.originalOperationId;
  if (originalOperationId !== null) assertIdentifier(originalOperationId, "originalOperationId");
  if ((action === "release-containment") !== (originalOperationId !== null)) {
    throw new TypeError("A2 recovery original operation binding is invalid");
  }
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs);
  const createdAtMs = assertTimestamp(input.createdAtMs, "createdAtMs");
  const updatedAtMs = assertTimestamp(input.updatedAtMs, "updatedAtMs");
  const leaseExpiresAtMs = assertTimestamp(input.leaseExpiresAtMs, "leaseExpiresAtMs");
  if (updatedAtMs < createdAtMs || leaseExpiresAtMs <= createdAtMs) {
    throw new TypeError("A2 recovery record timestamps are inconsistent");
  }
  return Object.freeze({
    schema: RECORD_SCHEMA, claimId, action, scope, profileId,
    providerId, verifierId, recorderId, idempotencyKey: input.idempotencyKey,
    state, originalOperationId, evidenceRefs, createdAtMs, updatedAtMs, leaseExpiresAtMs
  });
}

function copyRecord(record) {
  return {
    schema: record.schema,
    claimId: record.claimId,
    action: record.action,
    scope: { ...record.scope },
    profileId: record.profileId,
    providerId: record.providerId,
    verifierId: record.verifierId,
    recorderId: record.recorderId,
    idempotencyKey: record.idempotencyKey,
    state: record.state,
    originalOperationId: record.originalOperationId,
    evidenceRefs: record.evidenceRefs.map((ref) => ({ ...ref })),
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    leaseExpiresAtMs: record.leaseExpiresAtMs
  };
}

function emptyLedger() {
  return { schema: LEDGER_SCHEMA, revision: 0, claims: {}, idempotency: {} };
}

function validateLedger(value, maxClaims, identities) {
  try {
    exactKeys(value, ["schema", "revision", "claims", "idempotency"], "A2 action ledger");
  } catch {
    throw new Error("A2 action ledger is malformed or exceeds configured capacity");
  }
  if (value.schema !== LEDGER_SCHEMA ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !isRecord(value.claims) || !isRecord(value.idempotency) ||
      Object.keys(value.claims).length > maxClaims ||
      Object.keys(value.idempotency).length !== Object.keys(value.claims).length) {
    throw new Error("A2 action ledger is malformed or exceeds configured capacity");
  }
  const keys = new Set();
  const sequences = new Set();
  for (const [claimId, entry] of Object.entries(value.claims)) {
    try {
      exactKeys(entry, [
        "claimId", "sequence", "action", "scope", "profileId", "idempotencyKey",
        "claimedAtMs", "expiresAtMs", "status", "outcome", "reason",
        "completedAtMs", "recoveryRecord"
      ], "A2 ledger claim");
    } catch {
      throw new Error("A2 action ledger contains an invalid claim");
    }
    if (!IDENTIFIER.test(claimId) || !isRecord(entry) ||
        entry.claimId !== claimId ||
        !ACTIONS.has(entry.action) ||
        !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 ||
        entry.sequence > value.revision || sequences.has(entry.sequence) ||
        !Number.isSafeInteger(entry.claimedAtMs) || entry.claimedAtMs < 0 ||
        !Number.isSafeInteger(entry.expiresAtMs) || entry.expiresAtMs <= entry.claimedAtMs ||
        typeof entry.idempotencyKey !== "string" || !SHA256.test(entry.idempotencyKey) ||
        !["claimed", "provider-started", "completed"].includes(entry.status) ||
        (entry.reason !== null && (typeof entry.reason !== "string" || entry.reason.length > 160))) {
      throw new Error("A2 action ledger contains an invalid claim");
    }
    sequences.add(entry.sequence);
    const scope = normalizeScope(entry.scope);
    const profileId = assertIdentifier(entry.profileId, "profileId");
    if (operationKey(entry.action, scope, profileId) !== entry.idempotencyKey) {
      throw new Error("A2 action ledger idempotency binding failed");
    }
    if (keys.has(entry.idempotencyKey) || value.idempotency[entry.idempotencyKey] !== claimId) {
      throw new Error("A2 action ledger contains a duplicate or invalid idempotency index");
    }
    keys.add(entry.idempotencyKey);
    if (entry.status === "completed") {
      if (!TERMINAL_OUTCOMES.has(entry.outcome) ||
          !Number.isSafeInteger(entry.completedAtMs) || entry.completedAtMs < entry.claimedAtMs ||
          entry.recoveryRecord !== null) {
        throw new Error("A2 action ledger contains an invalid terminal claim");
      }
    } else {
      if (entry.outcome !== null || entry.completedAtMs !== null) {
        throw new Error("A2 active claim contains terminal metadata");
      }
      if (entry.status === "claimed") {
        if (entry.recoveryRecord !== null) {
          const record = normalizeRecoveryRecord(entry.recoveryRecord, identities);
          if (record.claimId !== claimId || record.state !== "claimed" ||
              record.action !== entry.action || record.profileId !== entry.profileId ||
              record.idempotencyKey !== entry.idempotencyKey ||
              canonicalJson(record.scope) !== canonicalJson(scope)) {
            throw new Error("A2 claimed record is inconsistent with its action claim");
          }
        }
      } else {
        if (entry.recoveryRecord === null) throw new Error("provider-started claim has no recovery record");
        const record = normalizeRecoveryRecord(entry.recoveryRecord, identities);
        if (record.claimId !== claimId ||
            !["provider-started", "held-for-reconciliation"].includes(record.state) ||
            record.action !== entry.action || record.profileId !== entry.profileId ||
            record.idempotencyKey !== entry.idempotencyKey ||
            canonicalJson(record.scope) !== canonicalJson(scope)) {
          throw new Error("A2 provider-started recovery record is inconsistent");
        }
      }
    }
  }
  for (const [key, claimId] of Object.entries(value.idempotency)) {
    if (!SHA256.test(key) || typeof claimId !== "string" ||
        !value.claims[claimId] || value.claims[claimId].idempotencyKey !== key) {
      throw new Error("A2 action ledger idempotency index is corrupt");
    }
  }
  return value;
}

async function reclaimDeadLock(lockPath, staleMs) {
  let before;
  let metadata;
  try {
    [before, metadata] = await Promise.all([readFile(lockPath, "utf8"), lstat(lockPath)]);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return false;
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
  } else if (Date.now() - metadata.mtimeMs < staleMs) {
    return false;
  }
  try {
    const [current, currentMetadata] = await Promise.all([
      readFile(lockPath, "utf8"), lstat(lockPath)
    ]);
    if (current !== before || currentMetadata.ino !== metadata.ino ||
        currentMetadata.mtimeMs !== metadata.mtimeMs) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function withFileLock(lockPath, options, signal, operation) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const started = performance.now();
  const token = randomUUID();
  let handle;
  while (!handle) {
    if (signal?.aborted) throw new Error("A2 action ledger operation aborted");
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), "utf8");
      await handle.sync();
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        handle = null;
        // Only remove a lock that still belongs to this invocation.
        try {
          const owner = JSON.parse(await readFile(lockPath, "utf8"));
          if (owner.token === token && owner.pid === process.pid) await unlink(lockPath);
        } catch {}
      }
      if (error?.code !== "EEXIST") throw error;
      await reclaimDeadLock(lockPath, options.staleMs);
      if (performance.now() - started >= options.timeoutMs) {
        throw new Error("A2 action ledger lock timed out; no state was changed");
      }
      await delay(options.pollIntervalMs, undefined, signal ? { signal } : undefined);
    }
  }
  try {
    if (signal?.aborted) throw new Error("A2 action ledger operation aborted");
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8"));
      if (owner.token === token && owner.pid === process.pid) await unlink(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function ledgerDigest(ledger) {
  return createHash("sha256")
    .update(JSON.stringify(ledger) + "\n", "utf8")
    .digest("hex");
}

function normalizeIntegrityKeyring(input, activeKeyId) {
  if (!isRecord(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
       Object.getPrototypeOf(input) !== null) ||
      Object.getOwnPropertySymbols(input).length !== 0) {
    throw new TypeError("integrityKeys must be a plain keyring object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const ids = Object.keys(descriptors);
  if (ids.length < 1 || ids.length > 8) {
    throw new TypeError("integrityKeys must contain between 1 and 8 versioned keys");
  }
  const keys = Object.create(null);
  for (const id of ids) {
    const descriptor = descriptors[id];
    if (!INTEGRITY_KEY_ID.test(id) || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("integrityKeys contains an invalid key entry");
    }
    const value = descriptor.value;
    let bytes;
    if (typeof value === "string" && /^(?:[a-f0-9]{2}){32,4096}$/.test(value)) {
      bytes = Buffer.from(value, "hex");
    } else if (value instanceof Uint8Array) {
      bytes = Buffer.from(value);
    } else {
      throw new TypeError("each A2 integrity key must be 32-4096 bytes or lowercase hex");
    }
    if (bytes.length < 32 || bytes.length > 4096) {
      throw new TypeError("each A2 integrity key must contain 32-4096 bytes");
    }
    keys[id] = bytes;
  }
  if (typeof activeKeyId !== "string" || !INTEGRITY_KEY_ID.test(activeKeyId) ||
      !Object.hasOwn(keys, activeKeyId)) {
    throw new TypeError("activeIntegrityKeyId must identify a key in integrityKeys");
  }
  return Object.freeze({ keys, activeKeyId });
}

function ledgerGuardMac(payload, key) {
  return createHmac("sha256", key)
    .update("jb.resilience.a2-ledger-guard/v2", "utf8")
    .update(Buffer.from([0]))
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

function verifyLedgerGuardMac(guard, key) {
  const payload = {
    schema: guard.schema,
    revision: guard.revision,
    ledgerSha256: guard.ledgerSha256,
    keyId: guard.keyId
  };
  const expected = Buffer.from(ledgerGuardMac(payload, key), "hex");
  const supplied = Buffer.from(guard.hmacSha256, "hex");
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

async function readLedgerGuard(guardPath, integrityKeys) {
  let handle;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
      ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(guardPath, fsConstants.O_RDONLY | noFollow);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 2_048) {
      throw new Error("A2 action ledger cryptographic guard is malformed");
    }
    if (noFollow === 0) {
      const pathMetadata = await lstat(guardPath);
      if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() ||
          pathMetadata.dev !== metadata.dev || pathMetadata.ino !== metadata.ino) {
        throw new Error("A2 action ledger cryptographic guard must be a regular file");
      }
    }
    const guard = JSON.parse(await handle.readFile("utf8"));
    exactKeys(guard, [
      "schema", "revision", "ledgerSha256", "keyId", "hmacSha256"
    ], "A2 action ledger cryptographic guard");
    if (guard.schema !== GUARD_SCHEMA ||
        !Number.isSafeInteger(guard.revision) || guard.revision < 0 ||
        typeof guard.ledgerSha256 !== "string" || !SHA256.test(guard.ledgerSha256) ||
        typeof guard.keyId !== "string" || !INTEGRITY_KEY_ID.test(guard.keyId) ||
        typeof guard.hmacSha256 !== "string" || !SHA256.test(guard.hmacSha256)) {
      throw new Error("A2 action ledger cryptographic guard is invalid");
    }
    const key = integrityKeys.keys[guard.keyId];
    if (!key || !verifyLedgerGuardMac(guard, key)) {
      throw new Error("A2 action ledger guard HMAC authentication failed");
    }
    return Object.freeze({
      schema: GUARD_SCHEMA,
      revision: guard.revision,
      ledgerSha256: guard.ledgerSha256,
      keyId: guard.keyId,
      hmacSha256: guard.hmacSha256
    });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP" || error?.code === "EMLINK") {
      throw new Error("A2 action ledger cryptographic guard must be a regular file", { cause: error });
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function writeLedgerGuard(guardPath, ledger, integrityKeys) {
  const directory = dirname(guardPath);
  const temporaryPath = guardPath + "." + process.pid + "." + randomUUID() + ".tmp";
  const payload = {
    schema: GUARD_SCHEMA,
    revision: ledger.revision,
    ledgerSha256: ledgerDigest(ledger),
    keyId: integrityKeys.activeKeyId
  };
  const guard = {
    ...payload,
    hmacSha256: ledgerGuardMac(payload, integrityKeys.keys[integrityKeys.activeKeyId])
  };
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(guard) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, guardPath);
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

async function ensureLedgerGuard(filePath, ledger, integrityKeys) {
  const guardPath = filePath + ".guard";
  const current = await readLedgerGuard(guardPath, integrityKeys);
  if (ledger === null) {
    if (current) {
      throw new Error("A2 action ledger is missing while its cryptographic guard exists; refusing empty reinitialization");
    }
    return;
  }

  const digest = ledgerDigest(ledger);
  if (current === null) {
    if (ledger.revision !== 0 ||
        Object.keys(ledger.claims).length !== 0 ||
        Object.keys(ledger.idempotency).length !== 0) {
      throw new Error("A2 action ledger cryptographic guard is missing; refusing to reinitialize its trust baseline");
    }
    await writeLedgerGuard(guardPath, ledger, integrityKeys);
    return;
  }
  if (current.revision === ledger.revision) {
    if (current.ledgerSha256 !== digest) {
      throw new Error("A2 action ledger digest does not match its authenticated guard");
    }
    if (current.keyId !== integrityKeys.activeKeyId) {
      await writeLedgerGuard(guardPath, ledger, integrityKeys);
    }
    return;
  }
  if (current.revision > ledger.revision) {
    throw new Error("A2 action ledger appears rolled back behind its authenticated guard");
  }
  throw new Error("A2 action ledger revision diverges from its authenticated guard; manual review is required");
}

const REVISION_ANCHOR_SCHEMA = "jb.resilience.a2-revision-anchor/v1";

function normalizeRevisionAnchorState(value) {
  exactKeys(value, ["schema", "revision", "ledgerSha256"], "A2 external revision anchor");
  if (value.schema !== REVISION_ANCHOR_SCHEMA ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.ledgerSha256 !== "string" || !SHA256.test(value.ledgerSha256)) {
    throw new Error("A2 external revision anchor state is malformed");
  }
  return Object.freeze({
    schema: REVISION_ANCHOR_SCHEMA,
    revision: value.revision,
    ledgerSha256: value.ledgerSha256
  });
}

function makeRevisionAnchorState(ledger) {
  return Object.freeze({
    schema: REVISION_ANCHOR_SCHEMA,
    revision: ledger.revision,
    ledgerSha256: ledgerDigest(ledger)
  });
}

function normalizeRevisionAnchorAdapter(adapter, ledgerId) {
  if (adapter === undefined && ledgerId === undefined) return null;
  if (!isRecord(adapter) || typeof adapter.read !== "function" ||
      typeof adapter.compareAndSwap !== "function") {
    throw new TypeError("revisionAnchor must implement read and compareAndSwap");
  }
  const normalizedLedgerId = assertIdentifier(ledgerId, "ledgerId");
  return Object.freeze({ adapter, ledgerId: normalizedLedgerId });
}

async function readLedgerFile(filePath, maxBytes, identities, maxClaims, integrityKeys, revisionAnchorConfig) {
  let handle;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
      ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error("A2 action ledger path must be a regular file, not a symbolic link");
    }
    if (noFollow === 0) {
      const pathMetadata = await lstat(filePath);
      if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() ||
          pathMetadata.dev !== metadata.dev || pathMetadata.ino !== metadata.ino) {
        throw new Error("A2 action ledger path must be a regular file, not a symbolic link");
      }
    }
    if (metadata.size > maxBytes) {
      throw new Error("A2 action ledger exceeds the configured size limit");
    }
    const serialized = await handle.readFile("utf8");
    const ledger = validateLedger(JSON.parse(serialized), maxClaims, identities);
    await ensureLedgerGuard(filePath, ledger, integrityKeys);
    return ledger;
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (revisionAnchorConfig) {
        const anchorState = await revisionAnchorConfig.adapter.read({
          ledgerId: revisionAnchorConfig.ledgerId
        });
        if (anchorState !== null) {
          throw new Error("A2 journal and guard are missing while the external revision anchor exists; refusing empty reinitialization");
        }
      }
      await ensureLedgerGuard(filePath, null, integrityKeys);
      const initial = emptyLedger();
      await writeLedgerFile(filePath, initial, maxBytes);
      await ensureLedgerGuard(filePath, initial, integrityKeys);
      return initial;
    }
    if (error?.code === "ELOOP" || error?.code === "EMLINK") {
      throw new Error("A2 action ledger path must be a regular file, not a symbolic link", { cause: error });
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function writeLedgerFile(filePath, value, maxBytes) {
  const directory = dirname(filePath);
  const temporaryPath = filePath + "." + process.pid + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    const serialized = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
      throw new Error("A2 action ledger exceeds the configured size limit");
    }
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
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

function assertIdentityOptions({ providerId, verifierId, recorderId }) {
  const identities = {
    providerId: assertIdentifier(providerId, "providerId"),
    verifierId: assertIdentifier(verifierId, "verifierId"),
    recorderId: assertIdentifier(recorderId, "recorderId")
  };
  if (new Set(Object.values(identities)).size !== 3) {
    throw new TypeError("A2 provider, verifier and forensic recorder identities must differ");
  }
  return Object.freeze(identities);
}

function assertSignal(signal) {
  if (signal !== undefined && (
    signal === null || typeof signal !== "object" || typeof signal.aborted !== "boolean"
  )) {
    throw new TypeError("A2 action ledger AbortSignal is invalid");
  }
}

function validateMethodInput(input, requiredKeys, optionalKeys = []) {
  if (!isRecord(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
       Object.getPrototypeOf(input) !== null) ||
      Object.getOwnPropertySymbols(input).length !== 0) {
    throw new TypeError("A2 action ledger input must be a plain data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = new Set([...requiredKeys, ...optionalKeys, "deadline", "signal"]);
  const actual = Object.keys(descriptors);
  if (requiredKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
      actual.some((key) => !allowed.has(key))) {
    throw new TypeError("A2 action ledger input has missing or unsupported fields");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("A2 action ledger input must not contain accessors or hidden fields");
    }
  }
  if (Object.hasOwn(descriptors, "deadline")) {
    assertTimestamp(descriptors.deadline.value, "A2 dependency deadline");
  }
  if (Object.hasOwn(descriptors, "signal")) assertSignal(descriptors.signal.value);
}

function actionMatches(entry, action, scope, profileId, idempotencyKey) {
  return entry.action === action && entry.profileId === profileId &&
    entry.idempotencyKey === idempotencyKey &&
    canonicalJson(entry.scope) === canonicalJson(scope);
}

/**
 * Durable single-host transactional A2 action journal.
 *
 * Action claims, pending recovery records, provider-start transitions and
 * terminal completion share one locked JSON ledger and atomic fsync/rename
 * writes. This is not a multi-host database or distributed consensus store.
 */
export function createFileA2ActionLedger({
  filePath,
  providerId,
  verifierId,
  recorderId,
  lockTimeoutMs = 5_000,
  lockStaleMs = 120_000,
  pollIntervalMs = 25,
  maxClaims = 20_000,
  maxLedgerBytes = 16 * 1024 * 1024,
  integrityKeys,
  activeIntegrityKeyId,
  revisionAnchor,
  ledgerId
} = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new TypeError("filePath is required");
  }
  for (const [name, value, min, max] of [
    ["lockTimeoutMs", lockTimeoutMs, 100, 60_000],
    ["lockStaleMs", lockStaleMs, 1_000, 86_400_000],
    ["pollIntervalMs", pollIntervalMs, 5, 1_000],
    ["maxClaims", maxClaims, 1, 200_000],
    ["maxLedgerBytes", maxLedgerBytes, 1_024, 128 * 1024 * 1024]
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new TypeError(name + " is invalid");
    }
  }
  const identities = assertIdentityOptions({ providerId, verifierId, recorderId });
  const normalizedIntegrityKeys = normalizeIntegrityKeyring(integrityKeys, activeIntegrityKeyId);
  const normalizedRevisionAnchor = normalizeRevisionAnchorAdapter(revisionAnchor, ledgerId);
  const target = resolve(filePath);
  const lockPath = target + ".lock";
  const lockOptions = { timeoutMs: lockTimeoutMs, staleMs: lockStaleMs, pollIntervalMs };

  async function verifyExternalRevisionAnchor(ledger) {
    if (!normalizedRevisionAnchor) return null;
    const { adapter, ledgerId: anchorId } = normalizedRevisionAnchor;
    let current = await adapter.read({ ledgerId: anchorId });
    if (current === null) {
      const isEmpty = ledger.revision === 0 &&
        Object.keys(ledger.claims).length === 0 &&
        Object.keys(ledger.idempotency).length === 0;
      if (!isEmpty) {
        throw new Error("A2 external revision anchor is missing for a used ledger; refusing to establish a new baseline");
      }
      const initial = makeRevisionAnchorState(ledger);
      const inserted = await adapter.compareAndSwap({
        ledgerId: anchorId,
        expected: null,
        next: initial
      });
      if (inserted === true) {
        current = initial;
      } else {
        current = await adapter.read({ ledgerId: anchorId });
      }
    }
    const observed = normalizeRevisionAnchorState(current);
    const expected = makeRevisionAnchorState(ledger);
    if (canonicalJson(observed) !== canonicalJson(expected)) {
      throw new Error("A2 external monotonic revision anchor does not match the authenticated journal; rollback or interrupted commit requires operator review");
    }
    return observed;
  }

  async function read(signal, operation) {
    assertSignal(signal);
    return withFileLock(lockPath, lockOptions, signal, async () => {
      const ledger = await readLedgerFile(target, maxLedgerBytes, identities, maxClaims, normalizedIntegrityKeys, normalizedRevisionAnchor);
      await verifyExternalRevisionAnchor(ledger);
      return operation(ledger);
    });
  }

  async function mutate(signal, operation) {
    assertSignal(signal);
    return withFileLock(lockPath, lockOptions, signal, async () => {
      const ledger = await readLedgerFile(target, maxLedgerBytes, identities, maxClaims, normalizedIntegrityKeys, normalizedRevisionAnchor);
      const priorAnchor = await verifyExternalRevisionAnchor(ledger);
      const result = await operation(ledger);
      if (result.changed) {
        ledger.revision += 1;
        validateLedger(ledger, maxClaims, identities);
        // Advance the guard first. If the subsequent journal replacement is
        // interrupted, the guard will be ahead and every read fails closed
        // for operator review instead of silently accepting ambiguous state.
        await writeLedgerGuard(target + ".guard", ledger, normalizedIntegrityKeys);
        await writeLedgerFile(target, ledger, maxLedgerBytes);
        if (normalizedRevisionAnchor) {
          const { adapter, ledgerId: anchorId } = normalizedRevisionAnchor;
          const advanced = await adapter.compareAndSwap({
            ledgerId: anchorId,
            expected: priorAnchor,
            next: makeRevisionAnchorState(ledger)
          });
          if (advanced !== true) {
            throw new Error("A2 external monotonic revision anchor compare-and-swap failed after local journal commit; all further recovery must hold for operator review");
          }
        }
      }
      return result.value;
    });
  }

  async function claim(input = {}) {
    validateMethodInput(input, [
      "action", "scope", "profileId", "idempotencyKey", "claimedAtMs", "expiresAtMs"
    ]);
    const action = input.action;
    if (!ACTIONS.has(action)) throw new TypeError("A2 action is invalid");
    const scope = normalizeScope(input.scope);
    const profileId = assertIdentifier(input.profileId, "profileId");
    const idempotencyKey = input.idempotencyKey;
    if (typeof idempotencyKey !== "string" ||
        idempotencyKey !== operationKey(action, scope, profileId)) {
      throw new TypeError("A2 claim idempotency key does not bind its exact action");
    }
    const claimedAtMs = assertTimestamp(input.claimedAtMs, "claimedAtMs");
    const expiresAtMs = assertTimestamp(input.expiresAtMs, "expiresAtMs");
    if (expiresAtMs <= claimedAtMs) throw new TypeError("A2 claim expiry is invalid");
    return mutate(input.signal, async (ledger) => {
      if (ledger.idempotency[idempotencyKey]) {
        return { changed: false, value: Object.freeze({ claimed: false, claimId: null }) };
      }
      const active = Object.values(ledger.claims).some((entry) =>
        ACTIVE_STATUSES.has(entry.status) &&
        entry.scope.assetId === scope.assetId &&
        entry.scope.environment === scope.environment
      );
      if (active || Object.keys(ledger.claims).length >= maxClaims) {
        return { changed: false, value: Object.freeze({ claimed: false, claimId: null }) };
      }
      const claimId = randomUUID();
      ledger.claims[claimId] = {
        claimId,
        sequence: ledger.revision + 1,
        action,
        scope: { ...scope },
        profileId,
        idempotencyKey,
        claimedAtMs,
        expiresAtMs,
        status: "claimed",
        outcome: null,
        reason: null,
        completedAtMs: null,
        recoveryRecord: null
      };
      ledger.idempotency[idempotencyKey] = claimId;
      return { changed: true, value: Object.freeze({ claimed: true, claimId }) };
    });
  }

  async function createPendingRecord(input = {}) {
    validateMethodInput(input, ["record", "atMs"]);
    const atMs = assertTimestamp(input.atMs, "pending record creation time");
    const record = normalizeRecoveryRecord(input.record, identities);
    return mutate(input.signal, async (ledger) => {
      const claimEntry = ledger.claims[record.claimId];
      if (!claimEntry || claimEntry.status !== "claimed" ||
          claimEntry.recoveryRecord !== null ||
          atMs < claimEntry.claimedAtMs || atMs >= claimEntry.expiresAtMs ||
          !actionMatches(claimEntry, record.action, record.scope, record.profileId, record.idempotencyKey) ||
          record.createdAtMs !== atMs || record.updatedAtMs !== atMs ||
          record.leaseExpiresAtMs <= atMs || record.state !== "claimed") {
        return { changed: false, value: Object.freeze({ created: false }) };
      }
      claimEntry.recoveryRecord = copyRecord(record);
      return { changed: true, value: Object.freeze({ created: true }) };
    });
  }

  async function markProviderStarted(input = {}) {
    validateMethodInput(input, [
      "claimId", "action", "scope", "profileId", "idempotencyKey", "recoveryRecord", "atMs"
    ]);
    const claimId = assertIdentifier(input.claimId, "claimId");
    const action = input.action;
    if (!ACTIONS.has(action)) throw new TypeError("A2 action is invalid");
    const scope = normalizeScope(input.scope);
    const profileId = assertIdentifier(input.profileId, "profileId");
    const idempotencyKey = input.idempotencyKey;
    const atMs = assertTimestamp(input.atMs, "provider-start time");
    const nextRecord = normalizeRecoveryRecord(input.recoveryRecord, identities);
    return mutate(input.signal, async (ledger) => {
      const entry = ledger.claims[claimId];
      if (!entry || entry.status !== "claimed" || entry.recoveryRecord === null ||
          atMs < entry.claimedAtMs || atMs >= entry.expiresAtMs ||
          !actionMatches(entry, action, scope, profileId, idempotencyKey) ||
          nextRecord.claimId !== claimId || nextRecord.state !== "provider-started" ||
          nextRecord.updatedAtMs !== atMs ||
          canonicalJson(entry.recoveryRecord) !== canonicalJson({
            ...copyRecord(nextRecord), state: "claimed",
            updatedAtMs: entry.recoveryRecord.updatedAtMs
          })) {
        return { changed: false, value: Object.freeze({ started: false }) };
      }
      entry.status = "provider-started";
      entry.recoveryRecord = copyRecord(nextRecord);
      return { changed: true, value: Object.freeze({ started: true }) };
    });
  }

  async function reconcile(input = {}) {
    validateMethodInput(input, ["action", "scope", "profileId", "idempotencyKey", "atMs"]);
    const action = input.action;
    if (!ACTIONS.has(action)) throw new TypeError("A2 action is invalid");
    const scope = normalizeScope(input.scope);
    const profileId = assertIdentifier(input.profileId, "profileId");
    const idempotencyKey = input.idempotencyKey;
    const atMs = assertTimestamp(input.atMs, "reconciliation time");
    if (typeof idempotencyKey !== "string" ||
        idempotencyKey !== operationKey(action, scope, profileId)) {
      return Object.freeze({ state: "unknown", claimId: null });
    }
    return read(input.signal, async (ledger) => {
      const claimId = ledger.idempotency[idempotencyKey] ?? null;
      if (claimId === null) return Object.freeze({ state: "not-found", claimId: null });
      const entry = ledger.claims[claimId];
      if (!entry || !actionMatches(entry, action, scope, profileId, idempotencyKey)) {
        return Object.freeze({ state: "unknown", claimId: null });
      }
      if (entry.status === "claimed" && atMs < entry.expiresAtMs) {
        return Object.freeze({ state: "claimed", claimId });
      }
      if (entry.status === "claimed" || entry.status === "provider-started") {
        return Object.freeze({
          state: entry.status === "claimed" ? "claimed" : "provider-started",
          claimId
        });
      }
      return Object.freeze({ state: "completed", claimId });
    });
  }

  async function complete(input = {}) {
    validateMethodInput(input, [
      "claimId", "outcome", "reason", "completedAtMs"
    ], ["providerReconciliation"]);
    const claimId = assertIdentifier(input.claimId, "claimId");
    const completedAtMs = assertTimestamp(input.completedAtMs, "completedAtMs");
    const outcome = input.outcome;
    if (!["succeeded", "not-applied", "held-for-reconciliation"].includes(outcome)) {
      throw new TypeError("A2 completion outcome is invalid");
    }
    const reason = input.reason;
    if (reason !== null && (typeof reason !== "string" || reason.length > 160)) {
      throw new TypeError("A2 completion reason is invalid");
    }
    return mutate(input.signal, async (ledger) => {
      const entry = ledger.claims[claimId];
      if (!entry || !ACTIVE_STATUSES.has(entry.status) || completedAtMs < entry.claimedAtMs) {
        return { changed: false, value: Object.freeze({ completed: false }) };
      }
      if (outcome === "succeeded" && (
        entry.status !== "provider-started" || entry.recoveryRecord === null ||
        entry.recoveryRecord.state !== "provider-started"
      )) {
        return { changed: false, value: Object.freeze({ completed: false }) };
      }
      if (outcome === "not-applied" && entry.status === "provider-started") {
        const proof = input.providerReconciliation;
        try {
          exactKeys(proof, [
            "schema", "providerId", "action", "scope", "profileId",
            "idempotencyKey", "outcome", "observedAtMs"
          ], "A2 provider non-application evidence");
          if (proof.schema !== "jb.resilience.a2-provider-non-application/v1" ||
              proof.providerId !== identities.providerId ||
              proof.action !== entry.action || proof.profileId !== entry.profileId ||
              proof.idempotencyKey !== entry.idempotencyKey ||
              proof.outcome !== "not-applied" ||
              canonicalJson(normalizeScope(proof.scope)) !== canonicalJson(entry.scope) ||
              !Number.isSafeInteger(proof.observedAtMs) ||
              proof.observedAtMs < entry.claimedAtMs ||
              proof.observedAtMs > completedAtMs) {
            return { changed: false, value: Object.freeze({ completed: false }) };
          }
        } catch {
          return { changed: false, value: Object.freeze({ completed: false }) };
        }
      }
      if (outcome === "held-for-reconciliation") {
        if (entry.status === "provider-started" && entry.recoveryRecord !== null) {
          entry.recoveryRecord = {
            ...entry.recoveryRecord,
            state: "held-for-reconciliation",
            updatedAtMs: Math.max(entry.recoveryRecord.updatedAtMs, completedAtMs)
          };
        }
        entry.reason = reason;
        return { changed: true, value: Object.freeze({ completed: true }) };
      }
      entry.status = "completed";
      entry.outcome = outcome;
      entry.reason = reason;
      entry.completedAtMs = completedAtMs;
      entry.recoveryRecord = null;
      return { changed: true, value: Object.freeze({ completed: true }) };
    });
  }

  async function listPending(input = {}) {
    validateMethodInput(input, ["limit", "atMs"], ["cursor"]);
    const atMs = assertTimestamp(input.atMs, "pending journal page time");
    const limit = input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("pending journal page limit is invalid");
    }
    let snapshotRevision;
    let lastSequence;
    if (input.cursor === null || input.cursor === undefined) {
      snapshotRevision = null;
      lastSequence = 0;
    } else {
      if (typeof input.cursor !== "string" || !/^a2v1:[0-9]+:[0-9]+$/.test(input.cursor)) {
        throw new TypeError("pending journal cursor is invalid");
      }
      const parts = input.cursor.split(":");
      snapshotRevision = Number(parts[1]);
      lastSequence = Number(parts[2]);
      if (!Number.isSafeInteger(snapshotRevision) || snapshotRevision < 0 ||
          !Number.isSafeInteger(lastSequence) || lastSequence < 0) {
        throw new TypeError("pending journal cursor is invalid");
      }
    }
    return read(input.signal, async (ledger) => {
      const snapshot = snapshotRevision ?? ledger.revision;
      if (snapshot > ledger.revision || lastSequence > snapshot) {
        throw new TypeError("pending journal cursor is ahead of the ledger");
      }
      const candidates = Object.values(ledger.claims)
        .filter((entry) => ACTIVE_STATUSES.has(entry.status) &&
          entry.sequence > lastSequence && entry.sequence <= snapshot)
        .sort((left, right) => left.sequence - right.sequence);
      const selected = candidates.slice(0, limit);
      const hasMore = candidates.length > selected.length;
      const claimIds = selected.map((entry) => entry.claimId);
      const nextCursor = hasMore && selected.length > 0
        ? "a2v1:" + snapshot + ":" + selected[selected.length - 1].sequence
        : null;
      return Object.freeze({ claimIds: Object.freeze(claimIds), nextCursor });
    });
  }

  async function getPendingByClaimId(input = {}) {
    validateMethodInput(input, ["claimId", "atMs"]);
    const claimId = assertIdentifier(input.claimId, "claimId");
    assertTimestamp(input.atMs, "pending journal exact lookup time");
    return read(input.signal, async (ledger) => {
      const entry = ledger.claims[claimId];
      if (!entry || !ACTIVE_STATUSES.has(entry.status) || entry.recoveryRecord === null) {
        return Object.freeze({ found: false, record: null });
      }
      return Object.freeze({ found: true, record: Object.freeze(copyRecord(entry.recoveryRecord)) });
    });
  }

  return Object.freeze({
    durable: true,
    externalRevisionAnchorConfigured: normalizedRevisionAnchor !== null,
    filePath: target,
    claim,
    createPendingRecord,
    markProviderStarted,
    reconcile,
    complete,
    listPending,
    getPendingByClaimId
  });
}
