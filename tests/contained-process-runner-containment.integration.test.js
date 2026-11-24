import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionEventJournal } from "../src/agent/execution-event-journal.js";
import { createContainedLocalProcessEngineRunner } from "../src/agent/contained-process-runner.js";

const linuxCgroupRoot = process.env.JBQA_CGROUP_V2_TEST_ROOT;
const supportedHost = process.platform === "win32" ||
  (process.platform === "linux" && typeof linuxCgroupRoot === "string" && linuxCgroupRoot.length > 0);

test("native containment dispatcher integrates with the contained runner and lifecycle journal", {
  skip: !supportedHost
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-native-containment-dispatch-"));
  const modulePath = join(root, "runner.mjs");
  await writeFile(modulePath, `
    export async function run(input) {
      return { value: input.value, pid: process.pid };
    }
  `, "utf8");

  const journal = createExecutionEventJournal({ maxEvents: 100 });
  const containment = {
    policy: {
      required: true,
      memoryLimit: "256MiB",
      cpuLimit: 50,
      processLimit: 16
    },
    ...(process.platform === "linux" ? { cgroupRoot: linuxCgroupRoot } : {})
  };
  const runner = createContainedLocalProcessEngineRunner({
    runner: {
      engineId: "jb.test.payload-redaction-probe-84c2",
      moduleRoot: root,
      modulePath,
      cwd: root,
      timeoutMs: 10000,
      killGraceMs: 250
    },
    containment,
    eventJournal: journal
  });

  try {
    const before = runner.getStatus();
    const expectedMode = process.platform === "win32"
      ? "windows-job-object"
      : "linux-cgroup-v2";

    assert.equal(before.containmentDispatcher.state, "ready");
    assert.equal(before.containmentDispatcher.platform, process.platform);
    assert.equal(before.containmentDispatcher.mode, expectedMode);
    assert.equal(before.containmentDispatcher.available, true);
    assert.equal(before.containmentDispatcher.enforced, true);
    assert.equal(before.containmentDispatcher.required, true);

    const result = await runner.run({ value: "payload-redaction-probe-84c2" });
    assert.deepEqual(result, {
      value: "payload-redaction-probe-84c2",
      pid: result.pid
    });
    assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0);

    const lifecycle = journal.getEventsForEngine("jb.test.payload-redaction-probe-84c2");
    const lifecycleTypes = lifecycle.map((event) => event.eventType);
    assert.ok(lifecycleTypes.includes("CONTAINMENT_CONTROLLER_READY"));
    assert.ok(lifecycleTypes.includes("CONTAINMENT_SCOPE_CREATED"));
    assert.ok(lifecycleTypes.includes("CONTAINMENT_PROCESS_ATTACHED"));
    assert.ok(lifecycleTypes.includes("CONTAINMENT_SCOPE_CLOSED"));
    assert.equal(lifecycleTypes.includes("CONTAINMENT_FALLBACK_ACTIVE"), false);
    assert.equal(lifecycleTypes.includes("CONTAINMENT_FALLBACK_USED"), false);

    const scopeCreated = lifecycle.find((event) =>
      event.eventType === "CONTAINMENT_SCOPE_CREATED"
    );
    assert.ok(scopeCreated?.executionId);
    const correlated = journal.getEventsForExecution(scopeCreated.executionId);
    assert.deepEqual(
      correlated.map((event) => event.eventType),
      [
        "CONTAINMENT_SCOPE_CREATED",
        "CONTAINMENT_PROCESS_ATTACHED",
        "CONTAINMENT_SCOPE_CLOSED"
      ]
    );

    const closed = await runner.close();
    assert.equal(closed.containmentDispatcher.state, "closed");
    assert.equal(closed.containmentDispatcher.activeScopes, 0);
    assert.equal(closed.eventJournal.emissionFailures, 0);
    assert.equal(
      journal.getEventsByType("CONTAINMENT_CONTROLLER_CLOSED", {
        engineId: "jb.test.payload-redaction-probe-84c2"
      }).length,
      1
    );

    const serialized = JSON.stringify(journal.listEvents());
    assert.equal(serialized.includes("payload-redaction-probe-84c2"), false);
    assert.equal(journal.listEvents().some((event) => Object.hasOwn(event, "pid")), false);
  } finally {
    await runner.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
