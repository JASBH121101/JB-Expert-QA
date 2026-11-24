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
