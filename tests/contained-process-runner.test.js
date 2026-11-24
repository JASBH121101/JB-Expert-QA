import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionEventJournal } from "../src/agent/execution-event-journal.js";
import {
  createContainedLocalProcessEngineRunner,
  ContainedProcessEngineRunnerError
} from "../src/agent/contained-process-runner.js";

async function createFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "jbqa-contained-process-"));
  const modulePath = join(root, "runner.mjs");
  await writeFile(modulePath, `
    export async function run(input) {
      return { received: input.value, executed: true };
    }
  `, "utf8");

  const runner = createContainedLocalProcessEngineRunner({
    runner: {
      engineId: "jb.test.contained",
      moduleRoot: root,
      modulePath,
      cwd: root,
      timeoutMs: 5000
    },
    containment: {
      policy: { allowUncontainedFallback: true },
      capabilityProbeOptions: { platform: "freebsd" },
      ...options.containment
    },
    ...(options.eventJournal === undefined ? {} : { eventJournal: options.eventJournal })
  });

  return {
    root,
    runner,
    async cleanup() {
      await runner.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("contained runner owns dispatch and reports an explicit uncontained fallback", async () => {
  const journal = createExecutionEventJournal();
  const item = await createFixture({ eventJournal: journal });
  try {
    const before = item.runner.getStatus();
    assert.equal(before.containmentDispatcher.mode, "uncontained-fallback");
    assert.equal(before.containmentDispatcher.enforced, false);
    assert.equal(before.resourceContainment.configured, true);
    assert.equal(before.resourceContainment.controller.mode, "uncontained-fallback");

    const result = await item.runner.run({ value: "runner-integration" });
    assert.deepEqual(result, {
      received: "runner-integration",
      executed: true
    });
    assert.equal(item.runner.getStatus().containmentDispatcher.activeScopes, 0);
    assert.equal(journal.getEventsByType("CONTAINMENT_RESOURCE_SNAPSHOT", {
      engineId: "jb.test.contained"
    }).length, 0);
  } finally {
    await item.cleanup();
  }
});

test("contained runner closes the process runner before its dispatcher and rejects later runs", async () => {
  const item = await createFixture();
  try {
    await item.runner.run({ value: "close-order" });
    const closed = await item.runner.close();
    assert.equal(closed.state, "closed");
    assert.equal(closed.containmentDispatcher.state, "closed");
    assert.equal(closed.containmentDispatcher.accepting, false);
    assert.equal(closed.containmentDispatcher.activeScopes, 0);
    await assert.rejects(
      item.runner.run({ value: "after-close" }),
      (error) => error instanceof ContainedProcessEngineRunnerError &&
        error.code === "RUNNER_CLOSED"
    );
  } finally {
    await item.cleanup();
  }
});

test("contained runner fails closed when native containment is unavailable by default", () => {
  assert.throws(
    () => createContainedLocalProcessEngineRunner({
      runner: {
        engineId: "jb.test.contained",
        moduleRoot: "/tmp",
        modulePath: "/tmp/runner.mjs"
      },
      containment: {
        capabilityProbeOptions: { platform: "freebsd" }
      }
    }),
    (error) => error.code === "UNSUPPORTED_CONTAINMENT_PLATFORM"
  );
});

test("contained runner rejects caller-injected resource controllers", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-contained-invalid-"));
  const modulePath = join(root, "runner.mjs");
  await writeFile(modulePath, "export function run() { return {}; }", "utf8");
  try {
    assert.throws(
      () => createContainedLocalProcessEngineRunner({
        runner: {
          engineId: "jb.test.contained",
          moduleRoot: root,
          modulePath,
          resourceController: {
            createScope() {},
            getStatus() {}
          }
        },
        containment: {
          policy: { allowUncontainedFallback: true },
          capabilityProbeOptions: { platform: "freebsd" }
        }
      }),
      (error) => error instanceof ContainedProcessEngineRunnerError &&
        error.code === "UNSUPPORTED_OPTION"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required containment cannot be weakened by an uncontained fallback policy", () => {
  assert.throws(
    () => createContainedLocalProcessEngineRunner({
      runner: {
        engineId: "jb.test.contained",
        moduleRoot: "/tmp",
        modulePath: "/tmp/runner.mjs"
      },
      containment: {
        policy: { required: true, allowUncontainedFallback: true },
        capabilityProbeOptions: { platform: "freebsd" }
      }
    }),
    (error) => error.code === "CONFLICTING_CONTAINMENT_POLICY"
  );
});


test("contained runner records correlated, metadata-only containment lifecycle events", async () => {
  const journal = createExecutionEventJournal();
  const privateInput = "private-payload-must-not-enter-the-journal";
  const item = await createFixture({ eventJournal: journal });
  try {
    const result = await item.runner.run({ value: privateInput });
    assert.deepEqual(result, {
      received: privateInput,
      executed: true
    });

    const allEvents = journal.listEvents();
    const events = journal.getEventsForEngine("jb.test.contained");
    assert.deepEqual(events.map((event) => event.eventType), [
      "CONTAINMENT_FALLBACK_ACTIVE",
      "CONTAINMENT_SCOPE_CREATED",
      "CONTAINMENT_FALLBACK_USED",
      "CONTAINMENT_SCOPE_CLOSED"
    ]);

    const scopeCreated = events.find((event) => event.eventType === "CONTAINMENT_SCOPE_CREATED");
    assert.equal(typeof scopeCreated.executionId, "string");
    assert.match(scopeCreated.executionId, /^[0-9a-f-]{36}$/iu);

    const correlated = journal.getEventsForExecution(scopeCreated.executionId);
    assert.deepEqual(correlated.map((event) => event.eventType), [
      "CONTAINMENT_SCOPE_CREATED",
      "CONTAINMENT_FALLBACK_USED",
      "CONTAINMENT_SCOPE_CLOSED"
    ]);
    assert.deepEqual(
      journal.getEventsByType("CONTAINMENT_FALLBACK_USED", {
        engineId: "jb.test.contained",
        executionId: scopeCreated.executionId
      }).map((event) => event.eventType),
      ["CONTAINMENT_FALLBACK_USED"]
    );

    const closed = await item.runner.close();
    assert.equal(closed.eventJournal.enabled, true);
    assert.equal(closed.eventJournal.emissionFailures, 0);
    assert.equal(
      journal.getEventsByType("CONTAINMENT_CONTROLLER_CLOSED", {
        engineId: "jb.test.contained"
      }).length,
      1
    );
    assert.equal(JSON.stringify(allEvents).includes(privateInput), false);
    assert.equal(JSON.stringify(journal.listEvents()).includes(privateInput), false);
    assert.equal(journal.listEvents().some((event) =>
      Object.hasOwn(event, "input") ||
      Object.hasOwn(event, "output") ||
      Object.hasOwn(event, "pid") ||
      Object.hasOwn(event, "message")
    ), false);
  } finally {
    await item.cleanup();
  }
});

test("contained runner isolates journal sink failures from execution and redacts event error details", async () => {
  const sensitiveDetail = "token=observer-private-failure";
  const journal = Object.freeze({
    recordEvent() {
      throw new Error(sensitiveDetail);
    }
  });
  const item = await createFixture({ eventJournal: journal });
  try {
    const result = await item.runner.run({ value: "still-executes" });
    assert.deepEqual(result, {
      received: "still-executes",
      executed: true
    });
    const beforeClose = item.runner.getStatus();
    assert.equal(beforeClose.eventJournal.enabled, true);
    assert.ok(beforeClose.eventJournal.emissionFailures >= 4);

    const closed = await item.runner.close();
    assert.ok(closed.eventJournal.emissionFailures >= beforeClose.eventJournal.emissionFailures);
    assert.equal(JSON.stringify(closed).includes(sensitiveDetail), false);
  } finally {
    await item.cleanup();
  }
});
