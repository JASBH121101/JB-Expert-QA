import { randomUUID } from "node:crypto";

const EVENT_TYPES = new Set([
  "JOB_CREATED", "JOB_QUEUED", "JOB_CLAIMED", "JOB_COMPLETED", "JOB_FAILED",
  "JOB_CANCELLED", "JOB_INTERRUPTED", "JOB_REQUEUED", "RECOVERY_COMPLETED",
  "INTERRUPTED_JOB_FAILED", "RETRY_REQUESTED", "RETRY_QUEUED",
  "WORKER_STARTED", "WORKER_STOPPING", "WORKER_STOPPED",
  "EXECUTION_STARTED", "EXECUTION_SUCCEEDED", "EXECUTION_FAILED",
  "EXECUTION_TIMEOUT", "EXECUTION_CANCEL_REQUESTED", "EXECUTION_CANCELLED",
  "CONTAINMENT_CONTROLLER_READY", "CONTAINMENT_FALLBACK_ACTIVE",
  "CONTAINMENT_SCOPE_CREATED", "CONTAINMENT_PROCESS_ATTACHED",
  "CONTAINMENT_FALLBACK_USED", "CONTAINMENT_SCOPE_TERMINATED",
  "CONTAINMENT_SCOPE_CLOSED", "CONTAINMENT_CONTROLLER_CLOSED",
  "CONTAINMENT_RESOURCE_SNAPSHOT", "CONTAINMENT_FAILURE",
  "RUNTIME_READY", "SUPERVISOR_STARTED", "SUPERVISOR_SHUTDOWN_STARTED",
  "SUPERVISOR_SHUTDOWN_COMPLETED", "SHUTDOWN_FAILURE"
]);
const SEVERITIES = new Set(["info", "warning", "error"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const TOKEN_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/u;
const STAGE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/u;
const RESOURCE_METRIC_KEYS = Object.freeze([
  "memoryCurrentBytes",
  "memoryPeakBytes",
  "memoryLimitBytes",
  "cpuUsageMicros",
  "cpuLimitPercent",
  "cpuPeriods",
  "cpuThrottledPeriods",
  "cpuThrottledMicros",
  "processCount",
  "processLimit",
  "totalProcesses",
  "terminatedProcesses",
  "memoryMaxEvents",
  "memoryOomEvents",
  "memoryOomKillEvents"
]);

export class ExecutionEventJournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionEventJournalError";
    this.code = code;
  }
}

function readRecord(value, label, allowedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionEventJournalError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ExecutionEventJournalError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new ExecutionEventJournalError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ExecutionEventJournalError("ACCESSOR_NOT_ALLOWED", label + " cannot contain accessors");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function identifier(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ExecutionEventJournalError("INVALID_IDENTIFIER", label + " has an invalid format");
  }
  return value;
}

function token(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new ExecutionEventJournalError("INVALID_TOKEN", label + " has an invalid format");
  }
  return value;
}

function freezeRecord(value) {
  return Object.freeze(value);
}

/**
 * Creates a bounded, in-memory operational journal for Phase 5 lifecycle events.
 * It stores identifiers, fixed metadata and allowlisted numeric resource counters;
 * payloads, PIDs and free-form messages are deliberately not accepted. Oldest
 * records roll off at maxEvents and the droppedEvents counter exposes eviction.
 */
export function createExecutionEventJournal(options = {}) {
  const config = readRecord(options, "options", new Set(["maxEvents", "now"]));
  const maxEvents = config.maxEvents ?? 5000;
  const now = config.now ?? (() => new Date());

  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 100000) {
    throw new ExecutionEventJournalError("INVALID_EVENT_LIMIT", "maxEvents must be an integer from 1 to 100000");
  }
  if (typeof now !== "function") {
    throw new ExecutionEventJournalError("INVALID_CLOCK", "now must be a function");
  }

  const events = [];
  let sequence = 0;
  let droppedEvents = 0;

  function normalizeTimestamp() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new ExecutionEventJournalError("INVALID_CLOCK_VALUE", "journal clock must return a valid date");
    }
    return date.toISOString();
  }

  function recordEvent(input) {
    const data = readRecord(input, "event", new Set([
      "eventType", "severity", "supervisorId", "workerId", "jobId",
      "engineId", "executionId", "attempt", "stage", "code",
      ...RESOURCE_METRIC_KEYS
    ]));

    if (typeof data.eventType !== "string" || !EVENT_TYPES.has(data.eventType)) {
      throw new ExecutionEventJournalError("INVALID_EVENT_TYPE", "eventType is not supported");
    }
    const severity = data.severity ?? (
      ["JOB_FAILED", "EXECUTION_FAILED", "EXECUTION_TIMEOUT", "CONTAINMENT_FAILURE", "SHUTDOWN_FAILURE"].includes(data.eventType)
        ? "error"
        : [
          "JOB_INTERRUPTED", "EXECUTION_CANCELLED", "INTERRUPTED_JOB_FAILED",
          "CONTAINMENT_FALLBACK_ACTIVE", "CONTAINMENT_FALLBACK_USED"
        ].includes(data.eventType)
          ? "warning"
          : "info"
    );
    if (!SEVERITIES.has(severity)) {
      throw new ExecutionEventJournalError("INVALID_SEVERITY", "severity is not supported");
    }
    const attempt = data.attempt;
    if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 0 || attempt > 10)) {
      throw new ExecutionEventJournalError("INVALID_ATTEMPT", "attempt must be an integer from 0 to 10");
    }

    const record = {
      eventId: randomUUID(),
      sequence: sequence + 1,
      timestamp: normalizeTimestamp(),
      eventType: data.eventType,
      severity
    };
    const supervisorId = identifier(data.supervisorId, "supervisorId");
    const workerId = identifier(data.workerId, "workerId");
    const jobId = identifier(data.jobId, "jobId");
    const engineId = identifier(data.engineId, "engineId");
    const executionId = identifier(data.executionId, "executionId");
    const stage = data.stage;
    if (stage !== undefined && (typeof stage !== "string" || !STAGE_PATTERN.test(stage))) {
      throw new ExecutionEventJournalError("INVALID_STAGE", "stage has an invalid format");
    }
    const code = token(data.code, "code");
    const hasResourceMetrics = RESOURCE_METRIC_KEYS.some((key) => data[key] !== undefined);
    if (hasResourceMetrics && data.eventType !== "CONTAINMENT_RESOURCE_SNAPSHOT") {
      throw new ExecutionEventJournalError(
        "RESOURCE_METRICS_EVENT_MISMATCH",
        "resource metrics are valid only on containment resource snapshot events"
      );
    }
    if (data.eventType === "CONTAINMENT_RESOURCE_SNAPSHOT" && !hasResourceMetrics) {
      throw new ExecutionEventJournalError(
        "RESOURCE_SNAPSHOT_EMPTY",
        "containment resource snapshot must contain at least one numeric metric"
      );
    }
    for (const key of RESOURCE_METRIC_KEYS) {
      const value = data[key];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new ExecutionEventJournalError(
          "INVALID_RESOURCE_METRIC",
          key + " must be a non-negative safe integer"
        );
      }
      record[key] = value;
    }
    if (supervisorId !== undefined) record.supervisorId = supervisorId;
    if (workerId !== undefined) record.workerId = workerId;
    if (jobId !== undefined) record.jobId = jobId;
    if (engineId !== undefined) record.engineId = engineId;
    if (executionId !== undefined) record.executionId = executionId;
    if (attempt !== undefined) record.attempt = attempt;
    if (stage !== undefined) record.stage = stage;
    if (code !== undefined) record.code = code;

    const immutable = freezeRecord(record);
    sequence += 1;
    events.push(immutable);
    if (events.length > maxEvents) {
      events.shift();
      droppedEvents += 1;
    }
    return immutable;
  }

  function normalizeQuery(options = {}) {
    const query = readRecord(options, "query options", new Set([
      "afterSequence", "limit", "eventType", "jobId", "engineId", "executionId"
    ]));
    const afterSequence = query.afterSequence ?? 0;
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new ExecutionEventJournalError("INVALID_CURSOR", "afterSequence must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new ExecutionEventJournalError("INVALID_QUERY_LIMIT", "limit must be an integer from 1 to 1000");
    }
    if (query.eventType !== undefined && (typeof query.eventType !== "string" || !EVENT_TYPES.has(query.eventType))) {
      throw new ExecutionEventJournalError("INVALID_EVENT_TYPE", "eventType is not supported");
    }
    const jobId = identifier(query.jobId, "jobId");
    const engineId = identifier(query.engineId, "engineId");
    const executionId = identifier(query.executionId, "executionId");
    return { afterSequence, limit, eventType: query.eventType, jobId, engineId, executionId };
  }

  function listEvents(options = {}) {
    const query = normalizeQuery(options);
    const matches = events.filter((event) =>
      event.sequence > query.afterSequence &&
      (query.eventType === undefined || event.eventType === query.eventType) &&
      (query.jobId === undefined || event.jobId === query.jobId) &&
      (query.engineId === undefined || event.engineId === query.engineId) &&
      (query.executionId === undefined || event.executionId === query.executionId)
    );
    return Object.freeze(matches.slice(-query.limit));
  }

  function getEventsForJob(jobId, options = {}) {
    const query = readRecord(options, "job query options", new Set(["afterSequence", "limit", "eventType"]));
    return listEvents({ ...query, jobId });
  }

  function getEventsForExecution(executionId, options = {}) {
    const query = readRecord(options, "execution query options", new Set([
      "afterSequence", "limit", "eventType", "engineId"
    ]));
    return listEvents({ ...query, executionId });
  }

  function getEventsForEngine(engineId, options = {}) {
    const query = readRecord(options, "engine query options", new Set([
      "afterSequence", "limit", "eventType", "executionId", "jobId"
    ]));
    return listEvents({ ...query, engineId });
  }

  function getEventsByType(eventType, options = {}) {
    if (typeof eventType !== "string" || !EVENT_TYPES.has(eventType)) {
      throw new ExecutionEventJournalError("INVALID_EVENT_TYPE", "eventType is not supported");
    }
    return listEvents({
      ...readRecord(options, "type query options", new Set([
        "afterSequence", "limit", "jobId", "engineId", "executionId"
      ])),
      eventType
    });
  }

  function getStatus() {
    return Object.freeze({
      mode: "memory",
      retainedEvents: events.length,
      maxEvents,
      droppedEvents,
      nextSequence: sequence + 1,
      firstSequence: events.length ? events[0].sequence : null,
      lastSequence: events.length ? events[events.length - 1].sequence : null,
      retentionWindowFull: events.length === maxEvents
    });
  }

  return Object.freeze({
    recordEvent,
    listEvents,
    getEventsForJob,
    getEventsForExecution,
    getEventsForEngine,
    getEventsByType,
    getStatus
  });
}
