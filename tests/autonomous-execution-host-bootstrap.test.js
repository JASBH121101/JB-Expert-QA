import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdtemp,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAutonomousExecutionHostBootstrap,
  bootstrapAutonomousExecutionHost,
  AutonomousExecutionHostBootstrapError
} from "../src/agent/autonomous-execution-host-bootstrap.js";
import { createPersistentExecutionJobQueue } from "../src/agent/execution-job-persistence.js";

const ENGINE_ID = "jb.test.echo";
const ACTION_TYPE = "qa.engine." + ENGINE_ID;
const PLAN = Object.freeze({
  id: "bootstrap-test-plan",
  actions: Object.freeze([Object.freeze({
    id: "bootstrap-test-action",
    type: ACTION_TYPE,
    input: Object.freeze({ value: "safe" })
  })])
});

function makeOrchestrator({
  ledger = () => ({ valid: true, entries: 0 }),
  policy = {},
  execute
} = {}) {
  let executions = 0;
  const orchestrator = Object.freeze({
    listEngines: () => Object.freeze([Object.freeze({
      id: ENGINE_ID,
      name: "Bootstrap Echo",
      version: "1.0.0"
    })]),
    getPolicy: () => Object.freeze({
      id: "bootstrap-test-policy",
      grantedPermissions: Object.freeze(["qa:engine-execute"]),
      allowedActions: Object.freeze([ACTION_TYPE]),
      limits: Object.freeze({
        maxActions: 4,
        maxExecutionMs: 30000,
        maxActionMs: 10000,
        approvalTimeoutMs: 5000,
        maxInputBytes: 4096,
        maxOutputBytes: 4096
      }),
      ...policy
    }),
    verifyLedger: ledger,
    execute: async (plan, options) => {
      executions += 1;
      if (execute) return execute(plan, options);
      return { status: "succeeded", executionId: options.executionId };
    }
  });
  return {
    orchestrator,
    getExecutions: () => executions
  };
}

async function withTempDir(callback) {
  const directory = await mkdtemp(join(tmpdir(), "jbqa-bootstrap-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for bootstrap host state");
}

function options(orchestrator, storageDirectory, signalSource = new EventEmitter(), extra = {}) {
  return {
    orchestrator,
    storageDirectory,
    signalSource,
    enabled: true,
    hostOptions: { pollIntervalMs: 50, ...extra.hostOptions },
    ...(extra.onDiagnostic ? { onDiagnostic: extra.onDiagnostic } : {}),
    ...(extra.signals ? { signals: extra.signals } : {})
  };
}

test("bootstrap construction is inert and preflight is read-only apart from its private storage probe", async () => {
  await withTempDir(async storageDirectory => {
    const { orchestrator, getExecutions } = makeOrchestrator();
    const signalSource = new EventEmitter();
    const bootstrap = createAutonomousExecutionHostBootstrap(options(orchestrator, storageDirectory, signalSource));

    assert.equal(bootstrap.getLiveness().alive, true);
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    assert.equal(getExecutions(), 0);

    const report = await bootstrap.preflight();
    assert.equal(report.passed, true);
    assert.equal(report.engineCount, 1);
    assert.equal(report.allowedEngineCount, 1);
    assert.equal(report.policyId, "bootstrap-test-policy");
    assert.deepEqual(report.checks.map(item => item.status), [
      "passed", "passed", "passed", "passed"
    ]);
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    assert.equal(getExecutions(), 0);
  });
});

test("bootstrap starts only after preflight, owns both persistent locks and reports readiness", async () => {
  await withTempDir(async storageDirectory => {
    const { orchestrator, getExecutions } = makeOrchestrator();
    const signalSource = new EventEmitter();
    const diagnostics = [];
    const bootstrap = createAutonomousExecutionHostBootstrap(
      options(orchestrator, storageDirectory, signalSource, {
        onDiagnostic: event => diagnostics.push(event)
      })
    );

    const started = await bootstrap.start();
    assert.equal(started.state, "running");
    assert.equal(started.host.queuePersistenceEnabled, true);
    assert.equal(started.host.eventJournalPersistenceEnabled, true);
    assert.equal((await bootstrap.getReadiness()).ready, true);
    assert.equal(bootstrap.getLiveness().status, "alive");
    assert.equal(signalSource.listenerCount("SIGINT"), 1);
    assert.equal(signalSource.listenerCount("SIGTERM"), 1);
    assert.equal(getExecutions(), 0);

    const diagnostic = await bootstrap.getDiagnostics();
    assert.equal(diagnostic.readiness.ready, true);
    assert.equal(diagnostic.ledger.verified, true);
    assert.equal(diagnostic.queue.queued, 0);
    assert.ok(diagnostics.some(item => item.event === "preflight_passed"));
    assert.ok(diagnostics.some(item => item.event === "host_started"));
    assert.equal(JSON.stringify(diagnostic).includes(storageDirectory), false);

    const stopped = await bootstrap.stop();
    assert.equal(stopped.state, "closed");
    assert.equal(stopped.readiness.ready, false);
    assert.equal(bootstrap.getLiveness().status, "not_alive");
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    assert.equal(getExecutions(), 0);
    await bootstrap.stop();
    assert.throws(() => bootstrap.start(),
      error => error instanceof AutonomousExecutionHostBootstrapError && error.code === "BOOTSTRAP_TERMINAL");
  });
});

test("diagnostics expose bounded event metadata but never job IDs, payloads, paths or event messages", async () => {
  await withTempDir(async storageDirectory => {
    const { orchestrator } = makeOrchestrator();
    const bootstrap = createAutonomousExecutionHostBootstrap(options(orchestrator, storageDirectory));
    await bootstrap.start();
    try {
      const privateJobId = "private-customer-job-reference";
      const privatePayload = "customer-secret-payload";
      bootstrap.enqueue({
        id: "diagnostic-plan",
        actions: [{
          id: "diagnostic-action",
          type: ACTION_TYPE,
          input: { value: privatePayload }
        }]
      }, { id: privateJobId });

      const diagnostic = await bootstrap.getDiagnostics();
      const rendered = JSON.stringify(diagnostic);
      assert.equal(rendered.includes(privateJobId), false);
      assert.equal(rendered.includes(privatePayload), false);
      assert.equal(rendered.includes(storageDirectory), false);
      assert.ok(Array.isArray(diagnostic.recentEvents));
      assert.ok(diagnostic.recentEvents.every(event =>
        Object.keys(event).every(key => [
          "sequence", "timestamp", "eventType", "severity", "code", "stage"
        ].includes(key))
      ));
      assert.equal("message" in (diagnostic.recentEvents[0] ?? {}), false);
    } finally {
      await bootstrap.stop();
    }
  });
});

test("invalid policy permission fails preflight without installing signal handlers or creating host locks", async () => {
  await withTempDir(async storageDirectory => {
    const { orchestrator } = makeOrchestrator({
      policy: { grantedPermissions: [] }
    });
    const signalSource = new EventEmitter();
    const bootstrap = createAutonomousExecutionHostBootstrap(options(orchestrator, storageDirectory, signalSource));

    const report = await bootstrap.preflight();
    assert.equal(report.passed, false);
    assert.ok(report.failures.includes("POLICY_PERMISSION_MISSING"));
    await assert.rejects(
      () => bootstrap.start(),
      error => error instanceof AutonomousExecutionHostBootstrapError &&
        error.code === "POLICY_PERMISSION_MISSING"
    );
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    assert.equal(bootstrap.getLiveness().status, "not_alive");
  });
});

test("invalid execution ledger is rejected before persistent host resources are acquired", async () => {
  await withTempDir(async storageDirectory => {
    const { orchestrator } = makeOrchestrator({
      ledger: () => ({ valid: false, entries: 12, message: "private ledger details" })
    });
    const signalSource = new EventEmitter();
    const seen = [];
    const bootstrap = createAutonomousExecutionHostBootstrap(
      options(orchestrator, storageDirectory, signalSource, {
        onDiagnostic: item => seen.push(item)
      })
    );

    await assert.rejects(() => bootstrap.start(),
      error => error.code === "EXECUTION_LEDGER_INVALID");
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    const diagnosticText = JSON.stringify(seen);
    assert.equal(diagnosticText.includes("private ledger details"), false);
    assert.equal(diagnosticText.includes("message"), false);
  });
});

test("bootstrap rejects accessor-backed engine metadata without invoking the getter", async () => {
  await withTempDir(async storageDirectory => {
    let getterCalled = false;
    const engine = {};
    Object.defineProperty(engine, "id", {
      enumerable: true,
      get() {
        getterCalled = true;
        return ENGINE_ID;
      }
    });
    const { orchestrator } = makeOrchestrator();
    const unsafeOrchestrator = Object.freeze({
      ...orchestrator,
      listEngines: () => [engine]
    });
    const bootstrap = createAutonomousExecutionHostBootstrap(options(unsafeOrchestrator, storageDirectory));

    const report = await bootstrap.preflight();
    assert.equal(report.passed, false);
    assert.ok(report.failures.includes("INVALID_PREFLIGHT_DATA"));
    assert.equal(getterCalled, false);
  });
});

test("bootstrap rejects broad POSIX storage permissions rather than silently chmodding them", async t => {
  if (process.platform === "win32") {
    t.skip("POSIX directory mode checks are not available on Windows");
    return;
  }
  await withTempDir(async storageDirectory => {
    await chmod(storageDirectory, 0o755);
    const { orchestrator } = makeOrchestrator();
    const bootstrap = createAutonomousExecutionHostBootstrap(options(orchestrator, storageDirectory));
    const report = await bootstrap.preflight();
    assert.equal(report.passed, false);
    assert.ok(report.failures.includes("STORAGE_PERMISSIONS_UNSAFE"));
    const stat = await (await import("node:fs/promises")).stat(storageDirectory);
    assert.equal(stat.mode & 0o777, 0o755);
  });
});

test("bootstrap fails closed when another process owns the durable queue lock", async () => {
  await withTempDir(async storageDirectory => {
    const lockPath = join(storageDirectory, "execution-jobs.json.lock");
    const foreignQueue = createPersistentExecutionJobQueue({
      filePath: join(storageDirectory, "execution-jobs.json")
    });
    const { orchestrator } = makeOrchestrator();
    const signalSource = new EventEmitter();
    const bootstrap = createAutonomousExecutionHostBootstrap(options(orchestrator, storageDirectory, signalSource));

    await assert.rejects(() => bootstrap.start(),
      error => error instanceof AutonomousExecutionHostBootstrapError && error.code === "STORE_LOCKED");
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    assert.equal(bootstrap.getLiveness().status, "not_alive");
    foreignQueue.close();
    assert.equal(lockPath.endsWith(".lock"), true);
  });
});

test("interrupted jobs remain quarantined until an explicit operator recovery call", async () => {
  await withTempDir(async storageDirectory => {
    const filePath = join(storageDirectory, "execution-jobs.json");
    const crashedQueue = createPersistentExecutionJobQueue({ filePath });
    crashedQueue.enqueue(PLAN, { id: "operator-recovery-job" });
    assert.equal(crashedQueue.claimNext().state, "running");
    crashedQueue.close();

    const { orchestrator, getExecutions } = makeOrchestrator();
    const bootstrap = createAutonomousExecutionHostBootstrap(options(orchestrator, storageDirectory, new EventEmitter()));
    await bootstrap.start();
    try {
      assert.equal(bootstrap.getJob("operator-recovery-job").state, "interrupted");
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(bootstrap.getJob("operator-recovery-job").state, "interrupted");
      assert.equal(getExecutions(), 0);

      bootstrap.recoverInterrupted("operator-recovery-job");
      await waitFor(() => bootstrap.getJob("operator-recovery-job")?.state === "completed");
      assert.equal(getExecutions(), 1);
      assert.ok((await bootstrap.getDiagnostics()).recentDiagnostics.some(item =>
        item.event === "manual_interrupted_job_recovery"
      ));
    } finally {
      await bootstrap.stop();
    }
  });
});

test("application convenience entrypoint starts explicitly and rejects missing enabled opt-in", async () => {
  await withTempDir(async storageDirectory => {
    const { orchestrator } = makeOrchestrator();
    const bootstrap = await bootstrapAutonomousExecutionHost(options(orchestrator, storageDirectory));
    try {
      assert.equal(bootstrap.getLiveness().status, "alive");
      assert.equal((await bootstrap.getReadiness()).ready, true);
    } finally {
      await bootstrap.stop();
    }

    assert.throws(
      () => createAutonomousExecutionHostBootstrap({
        orchestrator,
        storageDirectory,
        signalSource: new EventEmitter()
      }),
      error => error.code === "BOOTSTRAP_NOT_ENABLED"
    );
  });
});
