import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const BOOTSTRAP_URL = new URL("../src/agent/autonomous-execution-host-bootstrap.js", import.meta.url).href;
const LEDGER_URL = new URL("../src/agent/execution-ledger.js", import.meta.url).href;
const JOB_ID = "process-restart-job";
const CHILD_SOURCE = String.raw`
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";

const mode = process.argv[1];
const storageDirectory = process.argv[2];
const ledgerPath = process.argv[3];
const markerPath = process.argv[4];
const bootstrapModule = process.argv[5];
const ledgerModule = process.argv[6];
assert.equal(process.env.GITHUB_ACTIONS, undefined, "host must not require GITHUB_ACTIONS");
assert.equal(process.env.CI, undefined, "host must not require CI");

const [{ createAutonomousExecutionHostBootstrap }, { createJsonlExecutionLedger }] =
  await Promise.all([import(bootstrapModule), import(ledgerModule)]);
const engineId = "jb.ops.echo";
const actionType = "qa.engine." + engineId;
const plan = {
  id: "autonomous-operations-plan",
  actions: [{
    id: "autonomous-operations-action",
    type: actionType,
    input: { value: "local-runtime-proof" }
  }]
};
const ledger = await createJsonlExecutionLedger(ledgerPath);
const orchestrator = Object.freeze({
  listEngines: () => Object.freeze([Object.freeze({
    id: engineId,
    name: "Autonomous Operations Fixture",
    version: "1.0.0"
  })]),
  getPolicy: () => Object.freeze({
    id: "autonomous-operations-policy",
    grantedPermissions: Object.freeze(["qa:engine-execute"]),
    allowedActions: Object.freeze([actionType]),
    limits: Object.freeze({
      maxActions: 1,
      maxExecutionMs: 30000,
      maxActionMs: 10000,
      approvalTimeoutMs: 5000,
      maxInputBytes: 4096,
      maxOutputBytes: 4096
    })
  }),
  verifyLedger: () => ledger.verify(),
  execute: async (executionPlan, options) => {
    await ledger.append({
      event: "LOCAL_QA_EXECUTION_COMPLETED",
      executionId: options.executionId,
      planId: executionPlan.id,
      actionCount: executionPlan.actions.length
    });
    return {
      status: "succeeded",
      executionId: options.executionId,
      actions: [{ id: executionPlan.actions[0].id, status: "succeeded" }]
    };
  }
});

const bootstrap = createAutonomousExecutionHostBootstrap({
  orchestrator,
  storageDirectory,
  enabled: true,
  signalSource: new EventEmitter(),
  hostOptions: {
    runnerId: "ops-runner",
    supervisorId: "ops-supervisor",
    workerId: "ops-worker",
    pollIntervalMs: 100,
    maxJobsPerTick: 1,
    maxConsecutiveErrors: 2
  }
});
let started = false;
async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for autonomous host operation");
}

try {
  if (mode === "lock-check") {
    try {
      await bootstrap.start();
      started = true;
      await bootstrap.stop();
      started = false;
      process.stdout.write(JSON.stringify({ lockAcquired: true }) + "\n");
    } catch (error) {
      if (error?.code !== "STORE_LOCKED") throw error;
      process.stdout.write(JSON.stringify({ lockAcquired: false, code: error.code }) + "\n");
    }
    process.exitCode = 0;
  } else if (mode === "execute") {
    const status = await bootstrap.start();
    started = true;
    assert.equal(status.state, "running");
    assert.equal(status.host.queuePersistenceEnabled, true);
    assert.equal(status.host.eventJournalPersistenceEnabled, true);
    assert.equal((await bootstrap.getReadiness()).ready, true);
    writeFileSync(markerPath, JSON.stringify({ pid: process.pid, ready: true }), { mode: 0o600 });

    bootstrap.enqueue(plan, { id: "process-restart-job" });
    await waitFor(() => bootstrap.getJob("process-restart-job")?.state === "completed");
    const ledgerStatus = ledger.verify();
    assert.equal(ledgerStatus.valid, true);
    assert.equal(ledgerStatus.entries, 1);
    const events = bootstrap.listEvents({ limit: 100 });
    assert.ok(events.some(event => event.eventType === "EXECUTION_SUCCEEDED"));
    assert.ok(events.some(event => event.eventType === "JOB_COMPLETED"));
    await new Promise(resolve => setTimeout(resolve, 1200));

    const diagnostics = await bootstrap.getDiagnostics();
    assert.equal(diagnostics.readiness.ready, true);
    assert.equal(diagnostics.queue.completed, 1);
    assert.equal(diagnostics.ledger.verified, true);
    process.stdout.write(JSON.stringify({
      phase: "execute",
      state: (await bootstrap.getStatus()).state,
      jobState: bootstrap.getJob("process-restart-job").state,
      completed: diagnostics.queue.completed,
      eventCount: events.length,
      ledger: ledgerStatus,
      githubActions: process.env.GITHUB_ACTIONS ?? null,
      ci: process.env.CI ?? null
    }) + "\n");
    await bootstrap.stop();
    started = false;
    await ledger.close();
  } else if (mode === "verify-restart") {
    const status = await bootstrap.start();
    started = true;
    assert.equal(status.state, "running");
    assert.equal((await bootstrap.getReadiness()).ready, true);
    const job = bootstrap.getJob("process-restart-job");
    assert.equal(job?.state, "completed", "completed durable jobs must survive a process restart");
    const persistedEvents = bootstrap.listEvents({ limit: 100 });
    assert.ok(persistedEvents.some(event => event.eventType === "EXECUTION_SUCCEEDED"));
    assert.ok(persistedEvents.some(event => event.eventType === "JOB_COMPLETED"));

    const firstLedgerCheck = ledger.verify();
    assert.equal(firstLedgerCheck.valid, true);
    assert.equal(firstLedgerCheck.entries, 1);
    await new Promise(resolve => setTimeout(resolve, 400));
    const secondLedgerCheck = ledger.verify();
    assert.equal(secondLedgerCheck.valid, true);
    assert.equal(secondLedgerCheck.entries, 1, "a completed job must not execute again after restart");
    const diagnostics = await bootstrap.getDiagnostics();
    assert.equal(diagnostics.queue.completed, 1);
    assert.equal(diagnostics.queue.queued, 0);
    assert.equal(diagnostics.ledger.verified, true);

    process.stdout.write(JSON.stringify({
      phase: "verify-restart",
      state: (await bootstrap.getStatus()).state,
      jobState: job.state,
      queue: diagnostics.queue,
      eventCount: persistedEvents.length,
      ledger: secondLedgerCheck,
      githubActions: process.env.GITHUB_ACTIONS ?? null,
      ci: process.env.CI ?? null
    }) + "\n");
    await bootstrap.stop();
    started = false;
    await ledger.close();
  } else {
    throw new Error("Unknown operations lab mode");
  }
} finally {
  if (started) {
    await bootstrap.stop().catch(() => {});
  }
  await ledger.close().catch(() => {});
}
`;

function isolatedNodeEnvironment() {
  const environment = Object.create(null);
  for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR"]) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  return environment;
}

function spawnLab(mode, storageDirectory, ledgerPath, markerPath) {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    CHILD_SOURCE,
    mode,
    storageDirectory,
    ledgerPath,
    markerPath,
    BOOTSTRAP_URL,
    LEDGER_URL
  ], {
    cwd: process.cwd(),
    env: isolatedNodeEnvironment(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error("Autonomous host lab child failed (" + code + ", " + signal + "): " + stderr + stdout));
        return;
      }
      const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
      let result;
      try { result = JSON.parse(lines.at(-1)); }
      catch { reject(new Error("Autonomous host lab did not emit a JSON result: " + stdout)); return; }
      resolve(result);
    });
  });
  return { child, completion };
}

async function waitForFile(filePath, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for local autonomous host readiness marker");
}

test("autonomous host executes locally, excludes a concurrent process and preserves queue, journal and hash-chain ledger across process restart", async t => {
  const storageDirectory = await mkdtemp(join(tmpdir(), "jbqa-autonomous-operations-"));
  t.after(async () => rm(storageDirectory, { recursive: true, force: true }));
  const ledgerPath = join(storageDirectory, "qa-execution-ledger.jsonl");
  const markerPath = join(storageDirectory, "host-ready.marker");

  const firstProcess = spawnLab("execute", storageDirectory, ledgerPath, markerPath);
  await waitForFile(markerPath);

  const competingProcess = spawnLab("lock-check", storageDirectory, ledgerPath, markerPath);
  const contention = await competingProcess.completion;
  assert.deepEqual(contention, { lockAcquired: false, code: "STORE_LOCKED" });

  const first = await firstProcess.completion;
  assert.equal(first.phase, "execute");
  assert.equal(first.state, "running");
  assert.equal(first.jobState, "completed");
  assert.equal(first.completed, 1);
  assert.equal(first.ledger.valid, true);
  assert.equal(first.ledger.entries, 1);
  assert.equal(first.githubActions, null);
  assert.equal(first.ci, null);

  assert.equal(existsSync(join(storageDirectory, "execution-jobs.json.lock")), false);
  assert.equal(existsSync(join(storageDirectory, "execution-events.json.lock")), false);

  const restartedProcess = spawnLab("verify-restart", storageDirectory, ledgerPath, markerPath);
  const restarted = await restartedProcess.completion;
  assert.equal(restarted.phase, "verify-restart");
  assert.equal(restarted.state, "running");
  assert.equal(restarted.jobState, "completed");
  assert.equal(restarted.queue.completed, 1);
  assert.equal(restarted.queue.queued, 0);
  assert.equal(restarted.ledger.valid, true);
  assert.equal(restarted.ledger.entries, 1);
  assert.equal(restarted.githubActions, null);
  assert.equal(restarted.ci, null);
});
