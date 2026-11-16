import { createHash, randomUUID } from "node:crypto";
import {
  mkdir, open, readFile, rename, unlink, lstat
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LEDGER_SCHEMA = "jb.resilience.orchestration-ledger/v1";
const AUDIT_SCHEMA = "jb.resilience.audit-chain/v1";
const GENESIS_HASH = "0".repeat(64);
const INCIDENT_STATES = new Set([
  "OBSERVING", "DEGRADED", "HELD", "ESCALATED", "PLANNED",
  "AUTHORIZED", "EXECUTING", "VERIFYING", "RECOVERED",
  "FAILED", "FAILED_CLOSED", "RECONCILIATION_REQUIRED"
]);
const ACTION_OUTCOMES = new Set([
  "succeeded", "failed", "unverified", "cancelled-before-execution"
]);
const TRANSITIONS = Object.freeze({
  OBSERVING: new Set(["OBSERVING", "DEGRADED", "HELD", "ESCALATED", "PLANNED", "EXECUTING", "RECONCILIATION_REQUIRED", "FAILED_CLOSED"]),
  DEGRADED: new Set(["DEGRADED", "HELD", "ESCALATED", "PLANNED", "EXECUTING", "FAILED_CLOSED"]),
  HELD: new Set(["HELD", "OBSERVING", "ESCALATED", "RECONCILIATION_REQUIRED", "FAILED_CLOSED"]),
  ESCALATED: new Set(["ESCALATED", "HELD", "FAILED_CLOSED"]),
  PLANNED: new Set(["PLANNED", "AUTHORIZED", "HELD", "FAILED_CLOSED"]),
  AUTHORIZED: new Set(["AUTHORIZED", "EXECUTING", "HELD", "FAILED_CLOSED"]),
  EXECUTING: new Set(["EXECUTING", "VERIFYING", "RECONCILIATION_REQUIRED", "FAILED_CLOSED"]),
  VERIFYING: new Set(["VERIFYING", "RECOVERED", "RECONCILIATION_REQUIRED", "FAILED_CLOSED"]),
  RECONCILIATION_REQUIRED: new Set(["RECONCILIATION_REQUIRED", "RECOVERED", "FAILED_CLOSED", "HELD"]),
  RECOVERED: new Set(["RECOVERED"]),
  FAILED: new Set(["FAILED"]),
  FAILED_CLOSED: new Set(["FAILED_CLOSED"])
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(label + " is invalid");
  }
  return value;
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(label + " must be a non-negative safe integer");
  }
  return value;
}

function cloneJsonData(value, depth = 0, seen = new WeakSet()) {
  if (depth > 12) throw new TypeError("record nesting exceeds the supported depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("record contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("record must contain JSON data only");
  if (seen.has(value)) throw new TypeError("record contains circular data");
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length) {
      throw new TypeError("record arrays must be dense and contain no extra properties");
    }
    const output = [];
    for (let i = 0; i < value.length; i += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError("record arrays must not contain accessors");
      }
      output.push(cloneJsonData(descriptor.value, depth + 1, seen));
    }
    seen.delete(value);
    return output;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("record objects must be plain data records");
  }
  if (Object.getOwnPropertySymbols(value).length) {
    throw new TypeError("record objects must not contain symbol properties");
  }
  const output = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (["__proto__", "prototype", "constructor"].includes(key) ||
        !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("record contains an unsafe or accessor property");
    }
    output[key] = cloneJsonData(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(value[key])
  ).join(",") + "}";
}

function emptyLedger() {
  return {
    schema: LEDGER_SCHEMA,
    revision: 0,
    incidents: {},
    actions: {},
    idempotency: {},
    services: {},
    circuits: {},
    history: []
  };
}

function validateLedger(value, limits) {
  if (!isRecord(value) || value.schema !== LEDGER_SCHEMA ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !isRecord(value.incidents) || !isRecord(value.actions) ||
      !isRecord(value.idempotency) || !isRecord(value.services) ||
      !isRecord(value.circuits) || !Array.isArray(value.history) ||
      value.history.length > limits.maxHistoryEntries ||
      Object.keys(value.incidents).length > limits.maxIncidents ||
      Object.keys(value.actions).length > limits.maxActions) {
    throw new Error("orchestration ledger is malformed or exceeds its configured capacity");
  }
  for (const [incidentId, entry] of Object.entries(value.incidents)) {
    if (!IDENTIFIER.test(incidentId) || !isRecord(entry) ||
        entry.incidentId !== incidentId || !INCIDENT_STATES.has(entry.state)) {
      throw new Error("orchestration ledger contains an invalid incident");
    }
  }
  for (const [actionId, entry] of Object.entries(value.actions)) {
    if (!IDENTIFIER.test(actionId) || !isRecord(entry) ||
        entry.actionId !== actionId ||
        !["claimed", ...ACTION_OUTCOMES].includes(entry.status) ||
        typeof entry.idempotencyKey !== "string" || !SHA256.test(entry.idempotencyKey)) {
      throw new Error("orchestration ledger contains an invalid action");
    }
  }
  for (const [serviceKey, service] of Object.entries(value.services)) {
    if (typeof serviceKey !== "string" || !serviceKey.includes(":") ||
        !isRecord(service) ||
        !IDENTIFIER.test(service.assetId ?? "") ||
        !IDENTIFIER.test(service.environment ?? "") ||
        serviceKey !== service.environment + ":" + service.assetId ||
        (service.lastActionAt !== null &&
          (!Number.isSafeInteger(service.lastActionAt) || service.lastActionAt < 0)) ||
        !Number.isSafeInteger(service.consecutiveFailures) || service.consecutiveFailures < 0) {
      throw new Error("orchestration ledger contains invalid service state");
    }
  }
  for (const [circuitKey, circuit] of Object.entries(value.circuits)) {
    if (typeof circuitKey !== "string" || !circuitKey.includes(":") ||
        !isRecord(circuit) ||
        !Number.isSafeInteger(circuit.failureCount) || circuit.failureCount < 0 ||
        !Number.isSafeInteger(circuit.failureThreshold) || circuit.failureThreshold < 1 ||
        !Number.isSafeInteger(circuit.cooldownMs) || circuit.cooldownMs < 1_000 ||
        (circuit.retryAtMs !== null &&
          (!Number.isSafeInteger(circuit.retryAtMs) || circuit.retryAtMs < 0))) {
      throw new Error("orchestration ledger contains invalid circuit state");
    }
  }
  for (const [key, actionId] of Object.entries(value.idempotency)) {
    if (!SHA256.test(key) || typeof actionId !== "string" || !value.actions[actionId] ||
        value.actions[actionId].idempotencyKey !== key) {
      throw new Error("orchestration ledger contains an invalid idempotency index");
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

async function withFileLock(lockPath, {
  timeoutMs = 5_000,
  staleMs = 120_000,
  pollIntervalMs = 25
} = {}, operation) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const started = performance.now();
  const token = randomUUID();
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({
        pid: process.pid, token, createdAt: Date.now()
      }), "utf8");
      await handle.sync();
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        handle = null;
        await unlink(lockPath).catch(() => {});
      }
      if (error?.code !== "EEXIST") throw error;
      await reclaimDeadLock(lockPath, staleMs);
      if (performance.now() - started >= timeoutMs) {
        throw new Error("durable store is locked; no operation was performed");
      }
      await delay(pollIntervalMs);
    }
  }
  try {
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

async function readJsonFile(filePath, maxBytes, fallback) {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("durable store path must be a regular file, not a symbolic link");
    }
    if (metadata.size > maxBytes) throw new Error("durable store exceeds configured size limit");
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicWriteJson(filePath, value, maxBytes) {
  const directory = dirname(filePath);
  const temporaryPath = filePath + "." + process.pid + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    const serialized = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
      throw new Error("durable store exceeds configured size limit");
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

/**
 * Durable single-host incident/action/circuit ledger for the v0.6 orchestrator.
 * It serializes local processes with an exclusive lock and atomic file replacement.
 * It is not a distributed lock, consensus store or cross-host failover database.
 */
export function createFileOrchestrationStore({
  filePath,
  lockTimeoutMs = 5_000,
  lockStaleMs = 120_000,
  pollIntervalMs = 25,
  maxIncidents = 10_000,
  maxActions = 20_000,
  maxHistoryEntries = 20_000,
  maxLedgerBytes = 16 * 1024 * 1024
} = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new TypeError("filePath is required");
  }
  for (const [name, value, min, max] of [
    ["lockTimeoutMs", lockTimeoutMs, 100, 60_000],
    ["lockStaleMs", lockStaleMs, 1_000, 86_400_000],
    ["pollIntervalMs", pollIntervalMs, 5, 1_000],
    ["maxIncidents", maxIncidents, 1, 100_000],
    ["maxActions", maxActions, 1, 200_000],
    ["maxHistoryEntries", maxHistoryEntries, 1, 200_000],
    ["maxLedgerBytes", maxLedgerBytes, 1_024, 128 * 1024 * 1024]
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new TypeError(name + " is invalid");
    }
  }
  const target = resolve(filePath);
  const lockPath = target + ".lock";
  const limits = { maxIncidents, maxActions, maxHistoryEntries };

  async function load() {
    const data = await readJsonFile(target, maxLedgerBytes, emptyLedger());
    return validateLedger(data, limits);
  }
  async function read(operation) {
    return withFileLock(lockPath, {
      timeoutMs: lockTimeoutMs, staleMs: lockStaleMs, pollIntervalMs
    }, async () => operation(await load()));
  }
  async function mutate(operation) {
    return withFileLock(lockPath, {
      timeoutMs: lockTimeoutMs, staleMs: lockStaleMs, pollIntervalMs
    }, async () => {
      const ledger = await load();
      const result = await operation(ledger);
      if (result.changed) {
        ledger.revision += 1;
        await atomicWriteJson(target, ledger, maxLedgerBytes);
      }
      return result.value;
    });
  }

  async function recordIncidentState(record) {
    const safe = cloneJsonData(record);
    if (!isRecord(safe) ||
        Object.keys(safe).length !== 9 ||
        !["incidentId", "assetId", "environment", "serviceId", "state",
          "decision", "decisionRule", "reasonCode", "at"].every((key) => Object.hasOwn(safe, key))) {
      throw new TypeError("incident state record has an invalid shape");
    }
    assertIdentifier(safe.incidentId, "incidentId");
    assertIdentifier(safe.assetId, "assetId");
    assertIdentifier(safe.environment, "environment");
    assertIdentifier(safe.serviceId, "serviceId");
    if (!INCIDENT_STATES.has(safe.state) ||
        typeof safe.decision !== "string" || safe.decision.length > 64 ||
        typeof safe.decisionRule !== "string" || safe.decisionRule.length > 128 ||
        typeof safe.reasonCode !== "string" || safe.reasonCode.length > 128) {
      throw new TypeError("incident state fields are invalid");
    }
    assertTimestamp(safe.at, "incident state timestamp");
    return mutate(async (ledger) => {
      const current = ledger.incidents[safe.incidentId];
      if (!current && !["OBSERVING", "FAILED_CLOSED"].includes(safe.state)) {
        return { changed: false, value: false };
      }
      if (current && (
        current.assetId !== safe.assetId ||
        current.environment !== safe.environment ||
        current.serviceId !== safe.serviceId ||
        !TRANSITIONS[current.state]?.has(safe.state) ||
        safe.at < current.updatedAt
      )) {
        return { changed: false, value: false };
      }
      if (!current && Object.keys(ledger.incidents).length >= maxIncidents) {
        return { changed: false, value: false };
      }
      if (ledger.history.length >= maxHistoryEntries) {
        return { changed: false, value: false };
      }
      ledger.incidents[safe.incidentId] = {
        ...safe,
        updatedAt: safe.at
      };
      ledger.history.push({
        type: "incident-state",
        incidentId: safe.incidentId,
        state: safe.state,
        at: safe.at
      });
      return { changed: true, value: true };
    });
  }

  async function getServiceState({ assetId, environment } = {}) {
    assertIdentifier(assetId, "assetId");
    assertIdentifier(environment, "environment");
    return read((ledger) => Object.freeze({
      lastActionAt: ledger.services[environment + ":" + assetId]?.lastActionAt ?? null,
      lastOutcome: ledger.services[environment + ":" + assetId]?.lastOutcome ?? "unknown",
      consecutiveFailures: ledger.services[environment + ":" + assetId]?.consecutiveFailures ?? 0
    }));
  }

  async function getCircuitState({ assetId, action, now } = {}) {
    assertIdentifier(assetId, "assetId");
    assertIdentifier(action, "action");
    assertTimestamp(now, "circuit clock");
    return read((ledger) => {
      const state = ledger.circuits[assetId + ":" + action];
      const open = Boolean(state && state.failureCount >= state.failureThreshold &&
        state.retryAtMs !== null && now < state.retryAtMs);
      return Object.freeze({
        open,
        failureCount: state?.failureCount ?? 0,
        retryAtMs: open ? state.retryAtMs : null
      });
    });
  }

  async function claimAction(input) {
    const safe = cloneJsonData(input);
    if (!isRecord(safe) ||
        !["idempotencyKey", "incidentId", "assetId", "environment", "serviceId",
          "action", "claimedAt", "expiresAt"].every((key) => Object.hasOwn(safe, key)) ||
        Object.keys(safe).length !== 8 ||
        typeof safe.idempotencyKey !== "string" || !SHA256.test(safe.idempotencyKey)) {
      throw new TypeError("action claim is invalid");
    }
    for (const key of ["incidentId", "assetId", "environment", "serviceId", "action"]) {
      assertIdentifier(safe[key], key);
    }
    assertTimestamp(safe.claimedAt, "claimedAt");
    assertTimestamp(safe.expiresAt, "expiresAt");
    if (safe.expiresAt <= safe.claimedAt) throw new TypeError("action claim expiry is invalid");
    return mutate(async (ledger) => {
      if (ledger.idempotency[safe.idempotencyKey]) {
        return { changed: false, value: Object.freeze({ claimed: false, reason: "idempotency-key-already-claimed" }) };
      }
      const active = Object.values(ledger.actions).find((entry) =>
        entry.status === "claimed" && entry.assetId === safe.assetId &&
        entry.environment === safe.environment
      );
      if (active) {
        return {
          changed: false,
          value: Object.freeze({
            claimed: false,
            reason: active.expiresAt <= safe.claimedAt
              ? "action-reconciliation-required" : "asset-action-already-in-progress"
          })
        };
      }
      if (Object.keys(ledger.actions).length >= maxActions) {
        return { changed: false, value: Object.freeze({ claimed: false, reason: "action-ledger-capacity-exceeded" }) };
      }
      const actionId = randomUUID();
      ledger.actions[actionId] = {
        actionId,
        idempotencyKey: safe.idempotencyKey,
        incidentId: safe.incidentId,
        assetId: safe.assetId,
        environment: safe.environment,
        serviceId: safe.serviceId,
        action: safe.action,
        claimedAt: safe.claimedAt,
        expiresAt: safe.expiresAt,
        completedAt: null,
        status: "claimed",
        outcome: null,
        reasonCode: null
      };
      ledger.idempotency[safe.idempotencyKey] = actionId;
      const serviceKey = safe.environment + ":" + safe.assetId;
      ledger.services[serviceKey] ??= {
        assetId: safe.assetId,
        environment: safe.environment,
        lastActionAt: null,
        lastOutcome: "unknown",
        consecutiveFailures: 0
      };
      return {
        changed: true,
        value: Object.freeze({ claimed: true, actionId })
      };
    });
  }

  async function completeAction({ actionId, outcome, completedAt, reasonCode } = {}) {
    assertIdentifier(actionId, "actionId");
    assertTimestamp(completedAt, "completedAt");
    if (!ACTION_OUTCOMES.has(outcome) ||
        typeof reasonCode !== "string" || reasonCode.length < 1 || reasonCode.length > 128) {
      throw new TypeError("action completion is invalid");
    }
    return mutate(async (ledger) => {
      const entry = ledger.actions[actionId];
      if (!entry || entry.status !== "claimed" || completedAt < entry.claimedAt) {
        return { changed: false, value: false };
      }
      entry.status = outcome;
      entry.outcome = outcome;
      entry.completedAt = completedAt;
      entry.reasonCode = reasonCode;
      return { changed: true, value: true };
    });
  }

  async function recordActionOutcome({
    assetId, environment, action, outcome, at, failureThreshold, cooldownMs
  } = {}) {
    assertIdentifier(assetId, "assetId");
    assertIdentifier(environment, "environment");
    assertIdentifier(action, "action");
    assertTimestamp(at, "action outcome timestamp");
    if (!ACTION_OUTCOMES.has(outcome) ||
        !Number.isSafeInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 10 ||
        !Number.isSafeInteger(cooldownMs) || cooldownMs < 1_000 || cooldownMs > 86_400_000) {
      throw new TypeError("action outcome policy is invalid");
    }
    return mutate(async (ledger) => {
      const serviceKey = environment + ":" + assetId;
      const service = ledger.services[serviceKey] ?? null;
      if (outcome === "cancelled-before-execution") {
        return { changed: false, value: true };
      }
      if (!service) return { changed: false, value: false };
      if (service.lastActionAt !== null && at < service.lastActionAt) {
        return { changed: false, value: false };
      }
      service.lastActionAt = at;
      service.lastOutcome = outcome;
      service.consecutiveFailures = outcome === "succeeded"
        ? 0 : Math.min(1000, service.consecutiveFailures + 1);
      const circuitKey = assetId + ":" + action;
      const prior = ledger.circuits[circuitKey] ?? {
        failureCount: 0, failureThreshold, cooldownMs, retryAtMs: null
      };
      prior.failureThreshold = failureThreshold;
      prior.cooldownMs = cooldownMs;
      prior.failureCount = outcome === "succeeded" ? 0 : prior.failureCount + 1;
      prior.retryAtMs = prior.failureCount >= failureThreshold ? at + cooldownMs : null;
      if (prior.retryAtMs !== null && !Number.isSafeInteger(prior.retryAtMs)) {
        return { changed: false, value: false };
      }
      ledger.circuits[circuitKey] = prior;
      return { changed: true, value: true };
    });
  }

  async function getIncident(incidentId) {
    assertIdentifier(incidentId, "incidentId");
    return read((ledger) => {
      const entry = ledger.incidents[incidentId];
      return entry ? Object.freeze({ ...entry }) : null;
    });
  }

  return Object.freeze({
    durable: true,
    filePath: target,
    recordIncidentState,
    getServiceState,
    getCircuitState,
    claimAction,
    completeAction,
    recordActionOutcome,
    getIncident
  });
}

function normalizeAuditEntry(entry) {
  const safe = cloneJsonData(entry);
  if (!isRecord(safe)) throw new TypeError("audit entry must be a plain data record");
  const serialized = JSON.stringify(safe);
  if (Buffer.byteLength(serialized, "utf8") > 32 * 1024) {
    throw new TypeError("audit entry exceeds the 32 KiB limit");
  }
  return safe;
}

function auditRecordHash(record) {
  return createHash("sha256").update(canonicalJson({
    schema: record.schema,
    sequence: record.sequence,
    previousHash: record.previousHash,
    entry: record.entry
  }), "utf8").digest("hex");
}

function validateAuditLog(content, maxBytes) {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new Error("audit log exceeds configured size limit");
  }
  if (content === "") return { sequence: 0, lastHash: GENESIS_HASH };
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let sequence = 0;
  let previousHash = GENESIS_HASH;
  for (const line of lines) {
    if (!line) throw new Error("audit log contains an empty record");
    let record;
    try { record = JSON.parse(line); } catch {
      throw new Error("audit log contains malformed JSON");
    }
    if (!isRecord(record) ||
        Object.keys(record).length !== 5 ||
        !["schema", "sequence", "previousHash", "hash", "entry"].every((key) => Object.hasOwn(record, key))) {
      throw new Error("audit log record has an invalid shape");
    }
    if (record.schema !== AUDIT_SCHEMA ||
        record.sequence !== sequence + 1 ||
        record.previousHash !== previousHash ||
        typeof record.hash !== "string" || !SHA256.test(record.hash)) {
      throw new Error("audit log chain is invalid");
    }
    const expected = auditRecordHash(record);
    if (expected !== record.hash) throw new Error("audit log integrity verification failed");
    sequence = record.sequence;
    previousHash = record.hash;
  }
  return { sequence, lastHash: previousHash };
}

/**
 * Durable append-only, hash-chained audit file for a single host.
 * Each append is serialized and fsynced. A broken chain blocks further writes.
 * Ship signed checkpoints to an independent sink for stronger tamper resistance.
 */
export function createFileAuditStore({
  filePath,
  lockTimeoutMs = 5_000,
  lockStaleMs = 120_000,
  pollIntervalMs = 25,
  maxAuditBytes = 16 * 1024 * 1024
} = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new TypeError("filePath is required");
  }
  for (const [name, value, min, max] of [
    ["lockTimeoutMs", lockTimeoutMs, 100, 60_000],
    ["lockStaleMs", lockStaleMs, 1_000, 86_400_000],
    ["pollIntervalMs", pollIntervalMs, 5, 1_000],
    ["maxAuditBytes", maxAuditBytes, 1_024, 128 * 1024 * 1024]
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new TypeError(name + " is invalid");
    }
  }
  const target = resolve(filePath);
  const lockPath = target + ".lock";

  async function readAndValidate() {
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error("audit path must be a regular file, not a symbolic link");
      }
      if (metadata.size > maxAuditBytes) throw new Error("audit log exceeds configured size limit");
      return validateAuditLog(await readFile(target, "utf8"), maxAuditBytes);
    } catch (error) {
      if (error?.code === "ENOENT") return { sequence: 0, lastHash: GENESIS_HASH };
      throw error;
    }
  }

  async function withAuditLock(operation) {
    return withFileLock(lockPath, {
      timeoutMs: lockTimeoutMs,
      staleMs: lockStaleMs,
      pollIntervalMs
    }, operation);
  }

  async function append(entry) {
    const safeEntry = normalizeAuditEntry(entry);
    return withAuditLock(async () => {
      const current = await readAndValidate();
      const record = {
        schema: AUDIT_SCHEMA,
        sequence: current.sequence + 1,
        previousHash: current.lastHash,
        entry: safeEntry
      };
      const hash = auditRecordHash(record);
      const line = JSON.stringify({ ...record, hash }) + "\n";
      const existingBytes = await readFile(target, "utf8").catch((error) => {
        if (error?.code === "ENOENT") return "";
        throw error;
      });
      if (Buffer.byteLength(existingBytes, "utf8") + Buffer.byteLength(line, "utf8") > maxAuditBytes) {
        throw new Error("audit log capacity exceeded; refusing to drop prior records");
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, "a", 0o600);
      try {
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    });
  }

  async function verify() {
    return withAuditLock(async () => {
      const state = await readAndValidate();
      return Object.freeze({ valid: true, ...state });
    });
  }

  return Object.freeze({
    durable: true,
    filePath: target,
    append,
    verify
  });
}
