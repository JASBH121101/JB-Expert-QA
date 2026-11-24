import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQaEngineRegistry } from "../src/engine-registry/index.js";
import {
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION,
  QA_ENGINE_ORCHESTRATOR_RISK
} from "../src/engine-registry/orchestrator.js";
import { createAutonomousExecutionRuntime } from "../src/agent/execution-runtime.js";
import { createExecutionJobQueue } from "../src/agent/execution-job-queue.js";
import { createExecutionWorker } from "../src/agent/execution-worker.js";
import { createExecutionLifecycleSupervisor } from "../src/agent/execution-supervisor.js";
import { createPersistentExecutionEventJournal } from "../src/agent/execution-event-journal-persistence.js";
import { createContainedLocalProcessEngineRunner } from "../src/agent/contained-process-runner.js";

const linuxCgroupRoot = process.env.JBQA_CGROUP_V2_TEST_ROOT;
const supportedHost = process.platform === "win32" ||
  (process.platform === "linux" && typeof linuxCgroupRoot === "string" && linuxCgroupRoot.length > 0);

const ENGINE_ID = "jb.test.native-pipeline";
const ACTION_TYPE = getQaEngineActionType(ENGINE_ID);
const PRIVATE_PAYLOAD = "phase5-block12-8-private-payload-6b71";

function makePolicy() {
  return {
    id: "phase5-block12-8-native-pipeline",
    grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
    rules: [{
      type: ACTION_TYPE,
      maxRisk: QA_ENGINE_ORCHESTRATOR_RISK,
      requireApproval: true
    }],
    limits: {
      maxActions: 1,
      maxExecutionMs: 30000,
      maxActionMs: 20000,
      approvalTimeoutMs: 5000,
      maxInputBytes: 32768,
      maxOutputBytes: 32768
    }
  };
}

function makePlan(actionId, input) {
  return {
    id: "plan-" + actionId,
    actions: [{
      id: actionId,
      type: ACTION_TYPE,
      input
    }]
  };
}

async function waitForFile(filePath, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return existsSync(filePath);
}

test("native containment protects the full registry-to-supervisor pipeline and shutdown", {
  skip: !supportedHost
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-native-supervisor-pipeline-"));
  const modulePath = join(root, "runner.mjs");
  const markerPath = join(root, "adapter-started.marker");
  await writeFile(modulePath, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";

    export async function run(input) {
      if (input.behavior === "hang") {
        const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
          windowsHide: true,
          detached: false
        });
        await new Promise((resolve, reject) => {
          descendant.once("spawn", resolve);
          descendant.once("error", reject);
        });
        writeFileSync(join(process.cwd(), "adapter-started.marker"), "started");
        setInterval(() => {}, 1000);
        return await new Promise(() => {});
      }
      return { accepted: input.value, pid: process.pid };
    }
  `, "utf8");

  const journalPath = join(root, "execution-events.json");
  const journal = createPersistentExecutionEventJournal({ filePath: journalPath, maxEvents: 500 });
  const containment = {
    policy: {
      required: true,
      allowUncontainedFallback: false,
      memoryLimit: "256MiB",
      cpuLimit: 50,
      processLimit: 16
    },
    ...(process.platform === "linux" ? { cgroupRoot: linuxCgroupRoot } : {})
  };
  const runner = createContainedLocalProcessEngineRunner({
    runner: {
      engineId: ENGINE_ID,
      moduleRoot: root,
      modulePath,
      cwd: root,
      timeoutMs: 15000,
      killGraceMs: 250
    },
    containment,
    eventJournal: journal
  });

  let supervisor = null;
  try {
    const initialStatus = runner.getStatus();
    const expectedMode = process.platform === "win32"
      ? "windows-job-object"
      : "linux-cgroup-v2";
    assert.equal(initialStatus.containmentDispatcher.mode, expectedMode);
    assert.equal(initialStatus.containmentDispatcher.enforced, true);
    assert.equal(initialStatus.containmentDispatcher.required, true);
    assert.equal(initialStatus.containmentDispatcher.allowUncontainedFallback, false);

    const registry = createQaEngineRegistry();
    registry.register({
      id: ENGINE_ID,
      name: "Native Pipeline QA",
      version: "1.0.0",
      category: "audit",
      targetType: "payload",
      executionMode: "local-process",
      capabilities: ["process-isolated", "native-contained"],
      run: runner.run
    });
    registry.seal();

    // The high-risk action remains blocked without an external approval provider.
    const deniedOrchestrator = createQaEngineOrchestrator({
      registry,
      policy: makePolicy()
    });
    const denied = await deniedOrchestrator.execute(
      makePlan("denied-action", { value: "must-not-start" })
    );
    assert.equal(denied.status, "blocked");
    assert.equal(runner.getStatus().startedProcesses, 0);
    assert.equal(runner.getStatus().containmentDispatcher.activeScopes, 0);

    const approvals = [];
    const orchestrator = createQaEngineOrchestrator({
      registry,
      policy: makePolicy(),
      requestApproval: async (request) => {
        assert.equal(request.actionType, ACTION_TYPE);
        assert.equal(request.risk, "high");
        assert.equal(request.input, undefined);
        assert.equal(typeof request.inputDigest, "string");
        approvals.push(request.approvalId ?? request.actionId);
        return {
          approved: true,
          approvalId: "approval-native-pipeline-" + (approvals.length + 1)
        };
      }
    });
    const runtime = createAutonomousExecutionRuntime({
      orchestrator,
      enabled: true
    });
    const queue = createExecutionJobQueue({
      maxQueueSize: 8,
      maxJobs: 8,
      maxAttempts: 1,
      eventJournal: journal
    });
    const worker = createExecutionWorker({
      queue,
      runtime,
      workerId: "worker-native-pipeline",
      timeoutMs: 25000,
      eventJournal: journal
    });
    supervisor = createExecutionLifecycleSupervisor({
      queue,
      runtime,
      worker,
      supervisorId: "supervisor-native-pipeline",
      eventJournal: journal,
      processRunners: [runner]
    });

    supervisor.enqueue(
      makePlan("approved-action", { value: PRIVATE_PAYLOAD }),
      { id: "job-native-success" }
    );
    supervisor.start();

    const completed = await supervisor.runNext();
    assert.equal(completed.id, "job-native-success");
    assert.equal(completed.state, "completed");
    assert.equal(completed.result.status, "succeeded");
    assert.equal(completed.result.actions[0].status, "succeeded");
    assert.equal(completed.result.actions[0].output.accepted, PRIVATE_PAYLOAD);
    assert.ok(Number.isSafeInteger(completed.result.actions[0].output.pid));
    assert.equal(approvals.length, 1);
    assert.equal(runner.getStatus().containmentDispatcher.activeScopes, 0);

    // A second authorized action deliberately ignores cooperative cancellation
    // and starts a descendant. Supervisor shutdown must force-terminate the scope.
    supervisor.enqueue(
      makePlan("hanging-action", { behavior: "hang" }),
      { id: "job-native-hang" }
    );
    const hanging = supervisor.runNext();
    assert.equal(await waitForFile(markerPath), true);
    assert.equal(runner.getStatus().active, true);

    const closing = supervisor.close({
      abortActive: true,
      reason: "Block 12.8 native supervisor shutdown certification"
    });
    const cancelled = await hanging;
    const finalStatus = await closing;

    assert.equal(cancelled.id, "job-native-hang");
    assert.equal(cancelled.state, "cancelled");
    assert.equal(finalStatus.state, "closed");
    assert.equal(finalStatus.worker.state, "stopped");
    assert.equal(finalStatus.runtime.state, "closed");
    assert.equal(finalStatus.processRunners[0].state, "closed");
    assert.equal(finalStatus.processRunners[0].containmentDispatcher.state, "closed");
    assert.equal(finalStatus.processRunners[0].containmentDispatcher.activeScopes, 0);
    assert.equal(finalStatus.processRunners[0].eventJournal.emissionFailures, 0);
    assert.equal(approvals.length, 2);

    const engineEvents = journal.getEventsForEngine(ENGINE_ID);
    const scopeEvents = engineEvents.filter((event) =>
      event.eventType === "CONTAINMENT_SCOPE_CREATED"
    );
    assert.equal(scopeEvents.length, 2);
    for (const scopeEvent of scopeEvents) {
      const correlated = journal.getEventsForExecution(scopeEvent.executionId);
      const types = correlated.map((event) => event.eventType);
      assert.ok(types.includes("CONTAINMENT_SCOPE_CREATED"));
      assert.ok(types.includes("CONTAINMENT_PROCESS_ATTACHED"));
      assert.ok(types.includes("CONTAINMENT_RESOURCE_SNAPSHOT"));
      assert.ok(types.includes("CONTAINMENT_SCOPE_CLOSED"));
      const snapshots = correlated.filter((event) =>
        event.eventType === "CONTAINMENT_RESOURCE_SNAPSHOT"
      );
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0].memoryLimitBytes, 268435456);
      assert.equal(snapshots[0].cpuLimitPercent, 50);
      assert.equal(snapshots[0].processLimit, 16);
      assert.ok(Number.isSafeInteger(snapshots[0].cpuUsageMicros));
      assert.ok(Number.isSafeInteger(snapshots[0].processCount));
      assert.equal(Object.hasOwn(snapshots[0], "pid"), false);
      assert.equal(Object.hasOwn(snapshots[0], "attachedPid"), false);
      const scopeClosed = correlated.find((event) =>
        event.eventType === "CONTAINMENT_SCOPE_CLOSED"
      );
      assert.ok(snapshots[0].sequence < scopeClosed.sequence);
    }

    const successfulScope = journal.getEventsForExecution(scopeEvents[0].executionId)
      .map((event) => event.eventType);
    assert.equal(successfulScope.includes("CONTAINMENT_SCOPE_TERMINATED"), false);
    const cancelledScope = journal.getEventsForExecution(scopeEvents[1].executionId)
      .map((event) => event.eventType);
    assert.ok(cancelledScope.includes("CONTAINMENT_SCOPE_TERMINATED"));

    assert.equal(journal.getEventsByType("CONTAINMENT_FALLBACK_ACTIVE", {
      engineId: ENGINE_ID
    }).length, 0);
    assert.equal(journal.getEventsByType("CONTAINMENT_FALLBACK_USED", {
      engineId: ENGINE_ID
    }).length, 0);
    assert.equal(journal.getEventsByType("CONTAINMENT_CONTROLLER_CLOSED", {
      engineId: ENGINE_ID
    }).length, 1);

    const successfulJobEvents = journal.getEventsForJob("job-native-success")
      .map((event) => event.eventType);
    assert.ok(successfulJobEvents.includes("JOB_CREATED"));
    assert.ok(successfulJobEvents.includes("JOB_COMPLETED"));
    const cancelledJobEvents = journal.getEventsForJob("job-native-hang")
      .map((event) => event.eventType);
    assert.ok(cancelledJobEvents.includes("JOB_CREATED"));
    assert.ok(cancelledJobEvents.includes("JOB_CANCELLED"));

    const allEvents = journal.listEvents({ limit: 1000 });
    const serializedEvents = JSON.stringify(allEvents);
    assert.equal(serializedEvents.includes(PRIVATE_PAYLOAD), false);
    assert.equal(serializedEvents.includes("adapter-started.marker"), false);
    assert.equal(allEvents.some((event) => Object.hasOwn(event, "pid")), false);

    const ledger = JSON.stringify(orchestrator.getLedger());
    assert.equal(ledger.includes(PRIVATE_PAYLOAD), false);
    assert.equal(orchestrator.verifyLedger().valid, true);

    const shutdownCompleted = allEvents.find((event) =>
      event.eventType === "SUPERVISOR_SHUTDOWN_COMPLETED"
    );
    const controllerClosed = allEvents.find((event) =>
      event.eventType === "CONTAINMENT_CONTROLLER_CLOSED" && event.engineId === ENGINE_ID
    );
    assert.ok(controllerClosed);
    assert.ok(shutdownCompleted);
    assert.ok(shutdownCompleted.sequence > controllerClosed.sequence);

    const durableStatus = journal.getStatus();
    assert.equal(durableStatus.mode, "persistent");
    assert.equal(durableStatus.persistent, true);
    const engineEventSummary = engineEvents.map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
      eventType: event.eventType,
      executionId: event.executionId
    }));
    journal.close();

    const recoveredJournal = createPersistentExecutionEventJournal({
      filePath: journalPath,
      maxEvents: 500
    });
    try {
      assert.equal(recoveredJournal.getStatus().lastSequence, durableStatus.lastSequence);
      assert.equal(recoveredJournal.getStatus().droppedEvents, durableStatus.droppedEvents);
      assert.deepEqual(
        recoveredJournal.getEventsForEngine(ENGINE_ID).map((event) => ({
          eventId: event.eventId,
          sequence: event.sequence,
          eventType: event.eventType,
          executionId: event.executionId
        })),
        engineEventSummary
      );
      assert.equal(recoveredJournal.getEventsByType("CONTAINMENT_RESOURCE_SNAPSHOT", {
        engineId: ENGINE_ID
      }).length, 2);
      assert.equal(recoveredJournal.getEventsByType("SUPERVISOR_SHUTDOWN_COMPLETED").length, 1);
    } finally {
      recoveredJournal.close();
    }
  } finally {
    if (supervisor) {
      await supervisor.close({ abortActive: true }).catch(() => undefined);
    } else {
      await runner.close().catch(() => undefined);
    }
    try { journal.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});
