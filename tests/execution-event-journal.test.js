import assert from "node:assert/strict";
import test from "node:test";
import {
  createExecutionEventJournal,
  ExecutionEventJournalError
} from "../src/agent/execution-event-journal.js";

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
}

test("journal appends immutable, sequenced and timestamped lifecycle events", () => {
  const journal = createExecutionEventJournal({ now: clock() });
  const first = journal.recordEvent({ eventType: "JOB_CREATED", jobId: "job-1", attempt: 0 });
  const second = journal.recordEvent({
    eventType: "EXECUTION_STARTED",
    jobId: "job-1",
    workerId: "worker-1",
    attempt: 1,
    stage: "worker"
  });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(first.timestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(second.severity, "info");
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => { first.eventType = "JOB_FAILED"; }, TypeError);
  assert.deepEqual(journal.getEventsForJob("job-1"), [first, second]);
  assert.deepEqual(journal.getEventsByType("JOB_CREATED"), [first]);
});

test("journal enforces a bounded rolling window and exposes evictions", () => {
  const journal = createExecutionEventJournal({ maxEvents: 2, now: clock() });
  journal.recordEvent({ eventType: "JOB_CREATED", jobId: "job-1" });
  journal.recordEvent({ eventType: "JOB_QUEUED", jobId: "job-1" });
  journal.recordEvent({ eventType: "JOB_CLAIMED", jobId: "job-1", attempt: 1 });

  assert.deepEqual(journal.listEvents().map((event) => event.sequence), [2, 3]);
  assert.equal(journal.getStatus().droppedEvents, 1);
  assert.equal(journal.getStatus().firstSequence, 2);
  assert.equal(journal.getStatus().lastSequence, 3);
});

test("journal only accepts fixed metadata and never accepts payloads or free-form errors", () => {
  const journal = createExecutionEventJournal({ now: clock() });
  assert.throws(
    () => journal.recordEvent({ eventType: "JOB_FAILED", jobId: "job-1", message: "token=secret" }),
    (error) => error instanceof ExecutionEventJournalError && error.code === "UNSUPPORTED_OPTION"
  );
  assert.throws(
    () => journal.recordEvent({ eventType: "UNKNOWN_EVENT" }),
    (error) => error.code === "INVALID_EVENT_TYPE"
  );
  assert.throws(
    () => journal.recordEvent({ eventType: "JOB_FAILED", jobId: "bad id" }),
    (error) => error.code === "INVALID_IDENTIFIER"
  );
  assert.throws(
    () => journal.recordEvent({ eventType: "JOB_FAILED", code: "raw error text" }),
    (error) => error.code === "INVALID_TOKEN"
  );
  assert.equal(journal.getStatus().retainedEvents, 0);
});

test("journal validates bounded queries and returns events in append order", () => {
  const journal = createExecutionEventJournal({ now: clock() });
  journal.recordEvent({ eventType: "JOB_CREATED", jobId: "job-1" });
  journal.recordEvent({ eventType: "JOB_CREATED", jobId: "job-2" });
  journal.recordEvent({ eventType: "JOB_FAILED", jobId: "job-1" });

  assert.deepEqual(journal.listEvents({ afterSequence: 1 }).map((event) => event.sequence), [2, 3]);
  assert.deepEqual(journal.getEventsForJob("job-1", { limit: 1 }).map((event) => event.sequence), [3]);
  assert.deepEqual(journal.getEventsByType("JOB_CREATED").map((event) => event.jobId), ["job-1", "job-2"]);
  assert.throws(() => journal.listEvents({ limit: 1001 }), (error) => error.code === "INVALID_QUERY_LIMIT");
  assert.throws(() => journal.listEvents({ afterSequence: -1 }), (error) => error.code === "INVALID_CURSOR");
});

test("journal rejects accessors, unknown options and invalid clocks", () => {
  assert.throws(() => createExecutionEventJournal({ unexpected: true }), (error) => error.code === "UNSUPPORTED_OPTION");
  const options = {};
  Object.defineProperty(options, "maxEvents", { enumerable: true, get: () => 5 });
  assert.throws(() => createExecutionEventJournal(options), (error) => error.code === "ACCESSOR_NOT_ALLOWED");
  const journal = createExecutionEventJournal({ now: () => "not-a-date" });
  assert.throws(() => journal.recordEvent({ eventType: "JOB_CREATED" }), (error) => error.code === "INVALID_CLOCK_VALUE");
});


import { createExecutionJobQueue } from "../src/agent/execution-job-queue.js";
import { createPersistentExecutionJobQueue } from "../src/agent/execution-job-persistence.js";
import { createExecutionWorker } from "../src/agent/execution-worker.js";
import { createExecutionLifecycleSupervisor } from "../src/agent/execution-supervisor.js";

test("queue, worker and supervisor emit one ordered operational timeline", async () => {
  const journal = createExecutionEventJournal({ now: clock() });
  const queue = createExecutionJobQueue({ eventJournal: journal });
  const runtime = Object.freeze({
    getStatus: () => Object.freeze({ enabled: true, state: "ready" }),
    execute: async (_payload, options) => ({ status: "succeeded", executionId: options.executionId }),
    close: async () => undefined
  });
  const worker = createExecutionWorker({ queue, runtime, eventJournal: journal, workerId: "worker-test" });
  const supervisor = createExecutionLifecycleSupervisor({
    queue,
    runtime,
    worker,
    eventJournal: journal,
    supervisorId: "supervisor-test"
  });

  supervisor.enqueue({ plan: "metadata-only-example" }, { id: "timeline-job" });
  supervisor.start();
  const completed = await supervisor.runNext();
  assert.equal(completed.state, "completed");
  await supervisor.close();

  const events = journal.getEventsForJob("timeline-job");
  assert.deepEqual(events.map((event) => event.eventType), [
    "JOB_CREATED",
    "JOB_QUEUED",
    "JOB_CLAIMED",
    "EXECUTION_STARTED",
    "JOB_COMPLETED",
    "EXECUTION_SUCCEEDED"
  ]);
  assert.equal(events[2].attempt, 1);
  assert.equal(events[3].workerId, "worker-test");
  assert.equal(journal.listEvents().some((event) => event.eventType === "SUPERVISOR_STARTED"), true);
  assert.equal(journal.listEvents().some((event) => event.eventType === "SUPERVISOR_SHUTDOWN_COMPLETED"), true);
  assert.equal(journal.listEvents().some((event) => event.supervisorId === "supervisor-test"), true);
});

test("journal failures are isolated from queue state transitions and counted", () => {
  const eventJournal = Object.freeze({
    recordEvent() {
      throw new Error("private failure detail must not escape");
    }
  });
  const queue = createExecutionJobQueue({ eventJournal });
  const job = queue.enqueue({ plan: "still-queued" }, { id: "journal-unavailable" });

  assert.equal(job.state, "queued");
  assert.equal(queue.getJob(job.id).state, "queued");
  assert.equal(queue.stats().eventEmissionFailures, 2);
});


import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("persistent queue restart records interrupted jobs without replaying them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jbqa-phase5-block8-"));
  const filePath = join(directory, "jobs.json");
  try {
    const initial = createPersistentExecutionJobQueue({ filePath });
    initial.enqueue({ plan: "interrupted-job" }, { id: "interrupted-event-job" });
    initial.claimNext();
    initial.close();

    const journal = createExecutionEventJournal({ now: clock() });
    const recovered = createPersistentExecutionJobQueue({ filePath, eventJournal: journal });
    assert.equal(recovered.getJob("interrupted-event-job").state, "interrupted");
    assert.deepEqual(
      journal.getEventsForJob("interrupted-event-job").map((event) => event.eventType),
      ["JOB_INTERRUPTED"]
    );
    assert.equal(journal.getEventsForJob("interrupted-event-job")[0].severity, "warning");
    recovered.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("worker and supervisor continue explicit execution when the journal sink fails", async () => {
  const eventJournal = Object.freeze({
    recordEvent() {
      throw new Error("observer unavailable");
    }
  });
  const queue = createExecutionJobQueue({ eventJournal });
  const runtime = Object.freeze({
    getStatus: () => Object.freeze({ enabled: true, state: "ready" }),
    execute: async (_payload, options) => ({ status: "succeeded", executionId: options.executionId }),
    close: async () => undefined
  });
  const worker = createExecutionWorker({ queue, runtime, eventJournal });
  const supervisor = createExecutionLifecycleSupervisor({ queue, runtime, worker, eventJournal });

  supervisor.enqueue({ plan: "explicit-execution" }, { id: "observer-failure-job" });
  supervisor.start();
  const result = await supervisor.runNext();
  assert.equal(result.state, "completed");
  assert.ok(queue.stats().eventEmissionFailures > 0);
  assert.ok(worker.getStatus().eventEmissionFailures > 0);
  await supervisor.close();
  assert.ok(supervisor.getStatus().eventEmissionFailures > 0);
});


test("journal records containment lifecycle metadata and correlates events by execution", () => {
  const journal = createExecutionEventJournal({ now: clock() });
  const engineId = "jb.test.engine";
  const executionId = "12345678-1234-4234-8234-123456789012";

  journal.recordEvent({
    eventType: "CONTAINMENT_CONTROLLER_READY",
    engineId,
    stage: "containment",
    code: "LINUX_CGROUP_V2_READY"
  });
  journal.recordEvent({
    eventType: "CONTAINMENT_SCOPE_CREATED",
    engineId,
    executionId,
    stage: "containment"
  });
  journal.recordEvent({
    eventType: "CONTAINMENT_FALLBACK_USED",
    engineId,
    executionId,
    severity: "warning",
    stage: "containment",
    code: "UNCONTAINED_PROCESS_ATTACHMENT"
  });
  journal.recordEvent({
    eventType: "CONTAINMENT_SCOPE_CLOSED",
    engineId,
    executionId,
    stage: "containment"
  });

  assert.deepEqual(
    journal.getEventsForExecution(executionId).map((event) => event.eventType),
    ["CONTAINMENT_SCOPE_CREATED", "CONTAINMENT_FALLBACK_USED", "CONTAINMENT_SCOPE_CLOSED"]
  );
  assert.equal(journal.getEventsForEngine(engineId).length, 4);
  assert.equal(
    journal.getEventsByType("CONTAINMENT_FALLBACK_USED", {
      engineId,
      executionId
    })[0].severity,
    "warning"
  );
  assert.throws(
    () => journal.recordEvent({
      eventType: "CONTAINMENT_FAILURE",
      engineId,
      executionId,
      message: "token=must-not-be-stored"
    }),
    (error) => error.code === "UNSUPPORTED_OPTION"
  );
  assert.throws(
    () => journal.recordEvent({
      eventType: "CONTAINMENT_FAILURE",
      engineId,
      executionId,
      code: "token=must-not-be-stored"
    }),
    (error) => error.code === "INVALID_TOKEN"
  );
  assert.equal(journal.getStatus().retainedEvents, 4);
});


test("journal stores sanitized numeric resource snapshots correlated by execution", () => {
  const journal = createExecutionEventJournal({ now: clock() });
  const executionId = "12345678-1234-4234-8234-123456789012";
  const snapshot = journal.recordEvent({
    eventType: "CONTAINMENT_RESOURCE_SNAPSHOT",
    engineId: "jb.test.resource-evidence",
    executionId,
    stage: "containment",
    code: "RESOURCE_USAGE_CAPTURED",
    memoryCurrentBytes: 1048576,
    memoryPeakBytes: 2097152,
    memoryLimitBytes: 268435456,
    cpuUsageMicros: 1700,
    cpuLimitPercent: 50,
    cpuPeriods: 12,
    cpuThrottledPeriods: 2,
    cpuThrottledMicros: 400,
    processCount: 1,
    processLimit: 16,
    totalProcesses: 3,
    terminatedProcesses: 2,
    memoryMaxEvents: 0,
    memoryOomEvents: 0,
    memoryOomKillEvents: 0
  });

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.memoryPeakBytes, 2097152);
  assert.equal(snapshot.cpuThrottledPeriods, 2);
  assert.equal(snapshot.processLimit, 16);
  assert.deepEqual(journal.getEventsForExecution(executionId), [snapshot]);
  assert.equal(journal.getEventsByType("CONTAINMENT_RESOURCE_SNAPSHOT", {
    engineId: "jb.test.resource-evidence",
    executionId
  }).length, 1);
  assert.equal(Object.hasOwn(snapshot, "pid"), false);
  assert.equal(Object.hasOwn(snapshot, "attachedPid"), false);
  assert.equal(Object.hasOwn(snapshot, "input"), false);
});

test("journal rejects unsafe, non-integral, negative and unapproved resource metrics", () => {
  const journal = createExecutionEventJournal({ now: clock() });
  const base = {
    eventType: "CONTAINMENT_RESOURCE_SNAPSHOT",
    engineId: "jb.test.resource-evidence",
    executionId: "12345678-1234-4234-8234-123456789012"
  };

  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => journal.recordEvent({ ...base, cpuUsageMicros: value }),
      (error) => error.code === "INVALID_RESOURCE_METRIC"
    );
  }
  assert.throws(
    () => journal.recordEvent({ ...base, pid: 1234, cpuUsageMicros: 1 }),
    (error) => error.code === "UNSUPPORTED_OPTION"
  );
  assert.throws(
    () => journal.recordEvent({ ...base, memoryEvents: { oom: 0 }, cpuUsageMicros: 1 }),
    (error) => error.code === "UNSUPPORTED_OPTION"
  );
  assert.throws(
    () => journal.recordEvent({ ...base, eventType: "CONTAINMENT_SCOPE_CLOSED", cpuUsageMicros: 1 }),
    (error) => error.code === "RESOURCE_METRICS_EVENT_MISMATCH"
  );
  assert.throws(
    () => journal.recordEvent(base),
    (error) => error.code === "RESOURCE_SNAPSHOT_EMPTY"
  );
  assert.equal(journal.getStatus().retainedEvents, 0);
});


test("journal supports descending history pages with an exclusive before-sequence cursor", () => {
  const journal = createExecutionEventJournal({ now: clock() });
  for (let index = 0; index < 7; index += 1) {
    journal.recordEvent({
      eventType: index % 2 ? "JOB_COMPLETED" : "JOB_CREATED",
      jobId: "page-job-" + index
    });
  }

  const latest = journal.listEvents({ limit: 3 });
  assert.deepEqual(latest.map((event) => event.sequence), [5, 6, 7]);

  const previous = journal.listEvents({
    beforeSequence: latest[0].sequence,
    limit: 3
  });
  assert.deepEqual(previous.map((event) => event.sequence), [2, 3, 4]);

  const oldest = journal.listEvents({
    beforeSequence: previous[0].sequence,
    limit: 3
  });
  assert.deepEqual(oldest.map((event) => event.sequence), [1]);

  assert.deepEqual(
    journal.listEvents({ afterSequence: 1, beforeSequence: 5 }).map((event) => event.sequence),
    [2, 3, 4]
  );
  assert.deepEqual(
    journal.getEventsForJob("page-job-4", { beforeSequence: 7 }).map((event) => event.sequence),
    [5]
  );
});

test("journal rejects invalid before-sequence cursors", () => {
  const journal = createExecutionEventJournal({ now: clock() });
  journal.recordEvent({ eventType: "JOB_CREATED", jobId: "cursor-job" });
  for (const beforeSequence of [0, 1, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => journal.listEvents({ beforeSequence }),
      (error) => error.code === "INVALID_CURSOR"
    );
  }
  assert.throws(
    () => journal.listEvents({ afterSequence: 4, beforeSequence: 4 }),
    (error) => error.code === "INVALID_CURSOR"
  );
  assert.throws(
    () => journal.listEvents({ afterSequence: 4, beforeSequence: 3 }),
    (error) => error.code === "INVALID_CURSOR"
  );
});
