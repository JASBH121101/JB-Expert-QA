import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPersistentExecutionEventJournal
} from "../src/agent/execution-event-journal-persistence.js";
import { createExecutionEventJournal } from "../src/agent/execution-event-journal.js";
import { createJsonFileExecutionJobStore } from "../src/agent/execution-job-persistence.js";

function createClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 10, 24, 0, 0, tick++));
}

async function withTempDir(callback) {
  const directory = await mkdtemp(join(tmpdir(), "jbqa-durable-event-journal-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("persistent event journal restores IDs, timestamps, sequence and retention across restart", async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, "events.json");
    const now = createClock();
    const first = createPersistentExecutionEventJournal({
      filePath,
      maxEvents: 2,
      now
    });

    const created = first.recordEvent({
      eventType: "JOB_CREATED",
      jobId: "durable-job",
      severity: "info"
    });
    const resource = first.recordEvent({
      eventType: "CONTAINMENT_RESOURCE_SNAPSHOT",
      engineId: "jb.test.durable",
      executionId: "12345678-1234-4234-8234-123456789012",
      code: "RESOURCE_USAGE_CAPTURED",
      memoryPeakBytes: 2097152,
      memoryLimitBytes: 268435456,
      cpuUsageMicros: 710,
      processCount: 1
    });
    first.recordEvent({
      eventType: "JOB_COMPLETED",
      jobId: "durable-job"
    });

    assert.equal(created.sequence, 1);
    assert.equal(resource.sequence, 2);
    assert.equal(first.getStatus().mode, "persistent");
    assert.equal(first.getStatus().droppedEvents, 1);
    first.close();

    const recovered = createPersistentExecutionEventJournal({
      filePath,
      maxEvents: 2,
      now
    });
    try {
      assert.equal(recovered.getStatus().mode, "persistent");
      assert.equal(recovered.getStatus().retainedEvents, 2);
      assert.equal(recovered.getStatus().droppedEvents, 1);
      assert.equal(recovered.getStatus().nextSequence, 4);
      assert.deepEqual(recovered.listEvents(), [
        resource,
        {
          eventId: recovered.listEvents()[1].eventId,
          sequence: 3,
          timestamp: recovered.listEvents()[1].timestamp,
          eventType: "JOB_COMPLETED",
          severity: "info",
          jobId: "durable-job"
        }
      ]);
      assert.deepEqual(
        recovered.getEventsForExecution("12345678-1234-4234-8234-123456789012").map((event) => event.eventType),
        ["CONTAINMENT_RESOURCE_SNAPSHOT"]
      );
      const appended = recovered.recordEvent({ eventType: "WORKER_STOPPED", workerId: "worker-durable" });
      assert.equal(appended.sequence, 4);
      assert.equal(recovered.getStatus().droppedEvents, 2);
      assert.deepEqual(recovered.listEvents().map((event) => event.sequence), [3, 4]);
    } finally {
      recovered.close();
    }

    const reopened = createPersistentExecutionEventJournal({ filePath, maxEvents: 2, now });
    try {
      assert.equal(reopened.getStatus().nextSequence, 5);
      assert.equal(reopened.getStatus().droppedEvents, 2);
      assert.deepEqual(reopened.listEvents().map((event) => event.eventType), ["JOB_COMPLETED", "WORKER_STOPPED"]);
    } finally {
      reopened.close();
    }
  });
});

test("persistent event journal uses the exclusive single-writer lock and releases it on close", async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, "events.json");
    const first = createPersistentExecutionEventJournal({ filePath });
    try {
      assert.throws(
        () => createPersistentExecutionEventJournal({ filePath }),
        (error) => error.code === "STORE_LOCKED"
      );
    } finally {
      first.close();
    }

    const second = createPersistentExecutionEventJournal({ filePath });
    second.recordEvent({ eventType: "JOB_CREATED", jobId: "after-lock-release" });
    second.close();
  });
});

test("durable journal rejects corrupt checksums and invalid persisted event schemas", async () => {
  await withTempDir(async (directory) => {
    const checksumPath = join(directory, "checksum.json");
    const journal = createPersistentExecutionEventJournal({ filePath: checksumPath });
    journal.recordEvent({ eventType: "JOB_CREATED", jobId: "checksum-protected" });
    journal.close();

    const contents = await readFile(checksumPath, "utf8");
    await writeFile(checksumPath, contents.replace("JOB_CREATED", "JOB_FAILED"), "utf8");
    assert.throws(
      () => createPersistentExecutionEventJournal({ filePath: checksumPath }),
      (error) => error.code === "STORE_CHECKSUM_MISMATCH"
    );

    const schemaPath = join(directory, "schema.json");
    const store = createJsonFileExecutionJobStore({ filePath: schemaPath });
    store.save({
      schemaVersion: 1,
      sequence: 1,
      droppedEvents: 0,
      events: [{
        eventId: "c3a28db6-bd59-4e85-93ea-70c46f41d8a2",
        sequence: 1,
        timestamp: "2026-11-24T00:00:00.000Z",
        eventType: "CONTAINMENT_SCOPE_CLOSED",
        severity: "info",
        pid: 12345
      }]
    });
    store.close();
    assert.throws(
      () => createPersistentExecutionEventJournal({ filePath: schemaPath }),
      (error) => error.code === "UNSUPPORTED_OPTION"
    );
  });
});

test("durable persistence failures do not mutate the in-memory journal sequence", () => {
  const journal = createExecutionEventJournal({
    persistence: Object.freeze({
      load: () => null,
      save() {
        throw new Error("private filesystem detail");
      },
      close: () => undefined
    })
  });
  assert.throws(
    () => journal.recordEvent({ eventType: "JOB_CREATED", jobId: "must-not-commit" }),
    (error) => error.code === "PERSISTENCE_FAILED"
  );
  assert.equal(journal.getStatus().retainedEvents, 0);
  assert.equal(journal.getStatus().nextSequence, 1);
  assert.equal(journal.getStatus().droppedEvents, 0);
  journal.close();
});

test("persistent journal trims restored retention windows and persists eviction accounting", async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, "events.json");
    const first = createPersistentExecutionEventJournal({ filePath, maxEvents: 4 });
    for (let index = 0; index < 4; index += 1) {
      first.recordEvent({ eventType: "JOB_CREATED", jobId: "job-" + index });
    }
    first.close();

    const smaller = createPersistentExecutionEventJournal({ filePath, maxEvents: 2 });
    try {
      assert.equal(smaller.getStatus().retainedEvents, 2);
      assert.equal(smaller.getStatus().droppedEvents, 2);
      assert.deepEqual(smaller.listEvents().map((event) => event.sequence), [3, 4]);
    } finally {
      smaller.close();
    }
  });
});
