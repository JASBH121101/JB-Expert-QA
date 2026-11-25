import { randomUUID } from "node:crypto";

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ACTION_TYPE = /^qa\.engine\.[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const PERMISSION = /^[a-z][a-z0-9:-]{0,79}$/u;

export class LocalApprovalGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalApprovalGateError";
    this.code = code;
  }
}

function readOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalApprovalGateError("INVALID_OPTIONS", "options must be a plain object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new LocalApprovalGateError("INVALID_OPTIONS", "options must be a plain object");
  const allowed = new Set(["timeoutMs", "maxPending", "clock", "idFactory"]);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new LocalApprovalGateError("UNSUPPORTED_OPTION", "options contain an unsupported field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new LocalApprovalGateError("ACCESSOR_NOT_ALLOWED", "options cannot contain getters or setters");
    output[key] = descriptor.value;
  }
  return output;
}

function readRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalApprovalGateError("INVALID_APPROVAL_REQUEST", "approval request must be an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new LocalApprovalGateError("INVALID_APPROVAL_REQUEST", "approval request must be a plain object");
  const allowed = new Set(["executionId", "actionId", "actionType", "risk", "permissions", "inputDigest", "scope", "signal"]);
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new LocalApprovalGateError("INVALID_APPROVAL_REQUEST", "approval request contains an unsupported field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new LocalApprovalGateError("ACCESSOR_NOT_ALLOWED", "approval request cannot contain getters or setters");
    fields[key] = descriptor.value;
  }
  if (typeof fields.executionId !== "string" || !IDENTIFIER.test(fields.executionId) ||
      typeof fields.actionId !== "string" || !IDENTIFIER.test(fields.actionId) ||
      typeof fields.actionType !== "string" || !ACTION_TYPE.test(fields.actionType) ||
      !["low", "medium", "high"].includes(fields.risk) ||
      !Array.isArray(fields.permissions) || fields.permissions.length < 1 || fields.permissions.length > 16 ||
      fields.permissions.some((item) => typeof item !== "string" || !PERMISSION.test(item)) ||
      typeof fields.inputDigest !== "string" || !DIGEST.test(fields.inputDigest)) {
    throw new LocalApprovalGateError("INVALID_APPROVAL_REQUEST", "approval request metadata failed validation");
  }
  const signal = fields.signal;
  if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
    throw new LocalApprovalGateError("INVALID_ABORT_SIGNAL", "approval signal must be an AbortSignal");
  }
  return Object.freeze({
    executionId: fields.executionId,
    actionId: fields.actionId,
    actionType: fields.actionType,
    risk: fields.risk,
    permissions: Object.freeze([...fields.permissions]),
    inputDigest: fields.inputDigest,
    signal
  });
}

/**
 * Creates a single-use local operator approval gate. No request is approved
 * automatically. Only bounded metadata is exposed; input values and scope are
 * deliberately withheld from the operator-facing queue.
 */
export function createLocalApprovalGate(options = {}) {
  const config = readOptions(options);
  const timeoutMs = config.timeoutMs ?? 120_000;
  const maxPending = config.maxPending ?? 8;
  const clock = config.clock ?? Date.now;
  const idFactory = config.idFactory ?? randomUUID;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new LocalApprovalGateError("INVALID_TIMEOUT", "timeoutMs must be between 1000 and 300000");
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 32) throw new LocalApprovalGateError("INVALID_CAPACITY", "maxPending must be between 1 and 32");
  if (typeof clock !== "function" || typeof idFactory !== "function") throw new LocalApprovalGateError("INVALID_FACTORY", "clock and idFactory must be functions");

  const pending = new Map();
  let closed = false;
  let approvedCount = 0;
  let deniedCount = 0;
  let expiredCount = 0;

  function now() {
    const value = clock();
    if (!Number.isFinite(value) || value < 0 || value > 8.64e15) throw new LocalApprovalGateError("INVALID_CLOCK", "clock must return valid epoch milliseconds");
    return value;
  }

  function settle(id, approved, reason = "decision") {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.signal && entry.abortHandler) entry.signal.removeEventListener("abort", entry.abortHandler);
    if (approved) {
      approvedCount += 1;
      entry.resolve(Object.freeze({ approved: true, approvalId: "local-" + id }));
    } else {
      if (reason === "expired") expiredCount += 1;
      else deniedCount += 1;
      entry.resolve(Object.freeze({ approved: false }));
    }
    return true;
  }

  function requestApproval(rawRequest) {
    const request = readRequest(rawRequest);
    if (closed || request.signal?.aborted || pending.size >= maxPending) return Promise.resolve(Object.freeze({ approved: false }));
    const id = idFactory();
    if (typeof id !== "string" || !REQUEST_ID.test(id) || pending.has(id)) throw new LocalApprovalGateError("INVALID_REQUEST_ID", "idFactory must return a unique UUID v4");
    const createdAtMs = now();
    const expiresAtMs = createdAtMs + timeoutMs;
    if (!Number.isSafeInteger(expiresAtMs)) throw new LocalApprovalGateError("INVALID_TIMEOUT", "approval expiry is outside the supported range");

    return new Promise((resolve) => {
      const entry = {
        id,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        request,
        resolve,
        signal: request.signal,
        abortHandler: null,
        timer: null
      };
      entry.abortHandler = () => settle(id, false, "aborted");
      if (entry.signal) entry.signal.addEventListener("abort", entry.abortHandler, { once: true });
      entry.timer = setTimeout(() => settle(id, false, "expired"), timeoutMs);
      entry.timer.unref?.();
      pending.set(id, entry);
      if (entry.signal?.aborted) settle(id, false, "aborted");
    });
  }

  function decide(id, approved) {
    if (closed || typeof id !== "string" || !REQUEST_ID.test(id)) return false;
    const entry = pending.get(id);
    if (!entry) return false;
    if (now() >= entry.expiresAtMs) {
      settle(id, false, "expired");
      return false;
    }
    return settle(id, approved, approved ? "approved" : "denied");
  }

  function listPending() {
    const currentTime = now();
    for (const [id, entry] of pending) if (currentTime >= entry.expiresAtMs) settle(id, false, "expired");
    return Object.freeze([...pending.values()].map((entry) => Object.freeze({
      id: entry.id,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      executionId: entry.request.executionId,
      actionId: entry.request.actionId,
      actionType: entry.request.actionType,
      risk: entry.request.risk,
      permissions: entry.request.permissions,
      inputDigest: entry.request.inputDigest
    })));
  }

  function getStatus() {
    return Object.freeze({ enabled: !closed, closed, pendingCount: pending.size, approvedCount, deniedCount, expiredCount, maxPending, timeoutMs });
  }

  function close() {
    if (!closed) {
      closed = true;
      for (const id of [...pending.keys()]) settle(id, false, "closed");
    }
    return getStatus();
  }

  return Object.freeze({
    requestApproval,
    listPending,
    approve: (id) => decide(id, true),
    deny: (id) => decide(id, false),
    getStatus,
    close
  });
}
