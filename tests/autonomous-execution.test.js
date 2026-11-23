import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryExecutionLedger,
  createJsonlExecutionLedger,
  digestExecutionValue,
  verifyExecutionLedger
} from "../src/agent/execution-ledger.js";
import { createAutonomousExecutionEngine } from "../src/agent/autonomous-execution.js";

function reportAction({ execute = async (input) => ({ saved: input.path }), risk = "low", permissions = ["reports:write"], timeoutMs = 1000, validateInput, validateOutput } = {}) {
  return {
    type: "report.write",
    risk,
    permissions,
    timeoutMs,
    getScope: (input) => input.path,
    validateInput: validateInput ?? ((input) => typeof input.path === "string"),
    validateOutput: validateOutput ?? ((output) => Boolean(output && typeof output.saved === "string")),
    execute: ({ input, signal, approvalId }) => execute(input, { signal, approvalId })
  };
}

function reportPolicy(overrides = {}) {
  return {
    id: "qa-reports-policy-v1",
    grantedPermissions: ["reports:write"],
    rules: [{
      type: "report.write",
      maxRisk: "low",
      scopes: ["reports/**"]
    }],
    limits: {
      maxActions: 5,
      maxExecutionMs: 5000,
      maxActionMs: 1000,
      approvalTimeoutMs: 500,
      maxInputBytes: 4096,
      maxOutputBytes: 4096
    },
    ...overrides
  };
}

function reportPlan(input = { path: "reports/result.json" }) {
  return {
    id: "plan-1",
    actions: [{ id: "write-report-1", type: "report.write", input }]
  };
}

test("a preauthorized low-risk action runs only through its registered policy rule", async () => {
  let calls = 0;
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({ execute: async (input) => { calls += 1; return { saved: input.path }; } })],
    policy: reportPolicy()
  });
  const result = await engine.execute(reportPlan());
  assert.equal(result.status, "succeeded");
  assert.equal(result.summary.succeeded, 1);
  assert.equal(result.actions[0].output.saved, "reports/result.json");
  assert.equal(calls, 1);
  assert.equal(engine.verifyLedger().valid, true);
});

test("the ledger records decisions and digests, never raw action input or output", async () => {
  const secret = "customer-private-report-body";
  const ledger = createInMemoryExecutionLedger();
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({ execute: async () => ({ saved: secret }) })],
    policy: reportPolicy(),
    ledger
  });
  await engine.execute(reportPlan({ path: "reports/" + secret }));
  const serialized = JSON.stringify(ledger.snapshot());
  assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /inputDigest/u);
  assert.match(serialized, /outputDigest/u);
  assert.equal(ledger.verify().valid, true);
});

test("unregistered or non-allowlisted action types are blocked without invoking a handler", async () => {
  let calls = 0;
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({ execute: async () => { calls += 1; return { saved: "never" }; } })],
    policy: reportPolicy()
  });
  const result = await engine.execute({
    actions: [{ id: "unknown-1", type: "shell.execute", input: { command: "echo unsafe" } }]
  });
  assert.equal(result.status, "blocked");
  assert.match(result.actions[0].reason, /not registered and explicitly allowlisted/u);
  assert.equal(calls, 0);
});

test("permissions must be preauthorized and cannot be granted by a plan or approval callback", async () => {
  let calls = 0;
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({ execute: async () => { calls += 1; return { saved: "no" }; } })],
    policy: reportPolicy({ grantedPermissions: [] }),
    requestApproval: async () => ({ approved: true, approvalId: "approved-1" })
  });
  const result = await engine.execute(reportPlan());
  assert.equal(result.status, "blocked");
  assert.match(result.actions[0].reason, /not preauthorized/u);
  assert.equal(calls, 0);
});

test("resource scope is validated before a handler can run", async () => {
  let calls = 0;
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({ execute: async () => { calls += 1; return { saved: "no" }; } })],
    policy: reportPolicy()
  });
  const result = await engine.execute(reportPlan({ path: "secrets/customer.json" }));
  assert.equal(result.status, "blocked");
  assert.match(result.actions[0].reason, /outside the policy scope/u);
  assert.equal(calls, 0);
});

test("path traversal returned by a scope resolver is denied", async () => {
  let calls = 0;
  const action = {
    ...reportAction({ execute: async () => { calls += 1; return { saved: "no" }; } }),
    getScope: () => "reports/../../secrets"
  };
  const engine = createAutonomousExecutionEngine({ actions: [action], policy: reportPolicy() });
  const result = await engine.execute(reportPlan());
  assert.equal(result.status, "blocked");
  assert.equal(calls, 0);
});

test("policy risk ceilings block a registered action whose risk exceeds the rule", async () => {
  let calls = 0;
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({ risk: "medium", execute: async () => { calls += 1; return { saved: "no" }; } })],
    policy: reportPolicy()
  });
  const result = await engine.execute(reportPlan());
  assert.equal(result.status, "blocked");
  assert.match(result.actions[0].reason, /risk exceeds/u);
  assert.equal(calls, 0);
});

test("medium-risk actions require explicit approval even when policy permits them", async () => {
  let calls = 0;
  const action = reportAction({ risk: "medium", execute: async (input) => { calls += 1; return { saved: input.path }; } });
  const engine = createAutonomousExecutionEngine({
    actions: [action],
    policy: reportPolicy({ rules: [{ type: "report.write", maxRisk: "medium", scopes: ["reports/**"] }] })
  });
  const result = await engine.execute(reportPlan());
  assert.equal(result.status, "blocked");
  assert.match(result.actions[0].reason, /requires explicit approval/u);
  assert.equal(calls, 0);
});

test("approved medium-risk actions execute with an approval receipt", async () => {
  let calls = 0;
  let approvalRequest;
  const action = reportAction({
    risk: "medium",
    execute: async (input, context) => {
      calls += 1;
      return { saved: input.path, approvalId: context.approvalId };
    }
  });
  const engine = createAutonomousExecutionEngine({
    actions: [action],
    policy: reportPolicy({ rules: [{ type: "report.write", maxRisk: "medium", scopes: ["reports/**"] }] }),
    requestApproval: async (request) => {
      approvalRequest = request;
      return { approved: true, approvalId: "approval-2026-01" };
    }
  });
  const result = await engine.execute(reportPlan());
  assert.equal(result.status, "succeeded");
  assert.equal(calls, 1);
  assert.equal(approvalRequest.actionType, "report.write");
  assert.equal("input" in approvalRequest, false);
  assert.equal(result.actions[0].output.approvalId, "approval-2026-01");
});

test("high-risk actions always require approval, even if a rule disables the extra gate", async () => {
  let calls = 0;
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({ risk: "high", execute: async () => { calls += 1; return { saved: "no" }; } })],
    policy: reportPolicy({ rules: [{ type: "report.write", maxRisk: "high", scopes: ["reports/**"], requireApproval: false }] })
  });
  const result = await engine.execute(reportPlan());
  assert.equal(result.status, "blocked");
  assert.equal(calls, 0);
});

test("approval denial and malformed approval receipts fail closed", async (t) => {
  for (const [name, approval] of [
    ["denied", async () => ({ approved: false })],
    ["malformed", async () => ({ approved: true, approvalId: "" })]
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const engine = createAutonomousExecutionEngine({
        actions: [reportAction({ risk: "medium", execute: async () => { calls += 1; return { saved: "no" }; } })],
        policy: reportPolicy({ rules: [{ type: "report.write", maxRisk: "medium", scopes: ["reports/**"] }] }),
        requestApproval: approval
      });
      const result = await engine.execute(reportPlan());
      assert.equal(result.status, "blocked");
      assert.equal(calls, 0);
    });
  }
});

test("input validators must explicitly return true before approval or execution", async () => {
  let calls = 0;
  let approvals = 0;
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({
      risk: "medium",
      validateInput: () => false,
      execute: async () => { calls += 1; return { saved: "no" }; }
    })],
    policy: reportPolicy({ rules: [{ type: "report.write", maxRisk: "medium", scopes: ["reports/**"] }] }),
    requestApproval: async () => { approvals += 1; return { approved: true, approvalId: "receipt-1" }; }
  });
  const result = await engine.execute(reportPlan());
  assert.equal(result.status, "blocked");
  assert.match(result.actions[0].reason, /input validation failed/u);
  assert.equal(approvals, 0);
  assert.equal(calls, 0);
});

test("output validation failures are recorded and stop the plan", async () => {
  let secondCalls = 0;
  const first = reportAction({ validateOutput: () => false, execute: async () => ({ saved: "bad" }) });
  const second = {
    type: "report.notify",
    risk: "low",
    permissions: [],
    execute: async () => { secondCalls += 1; return { notified: true }; }
  };
  const engine = createAutonomousExecutionEngine({
    actions: [first, second],
    policy: {
      id: "qa-output-policy",
      grantedPermissions: ["reports:write"],
      rules: [
        { type: "report.write", maxRisk: "low", scopes: ["reports/**"] },
        { type: "report.notify", maxRisk: "low" }
      ],
      limits: { maxActions: 3 }
    }
  });
  const result = await engine.execute({
    actions: [
      { id: "write-1", type: "report.write", input: { path: "reports/out.json" } },
      { id: "notify-1", type: "report.notify", input: {} }
    ]
  });
  assert.equal(result.status, "failed");
  assert.equal(result.actions[0].status, "failed");
  assert.equal(secondCalls, 0);
});

test("failed handlers stop subsequent actions by default", async () => {
  let secondCalls = 0;
  const first = { type: "report.fail", risk: "low", execute: async () => { throw new Error("token=secret-value"); } };
  const second = { type: "report.next", risk: "low", execute: async () => { secondCalls += 1; return { ok: true }; } };
  const engine = createAutonomousExecutionEngine({
    actions: [first, second],
    policy: { rules: [{ type: "report.fail" }, { type: "report.next" }] }
  });
  const result = await engine.execute({
    actions: [
      { id: "fail-1", type: "report.fail", input: {} },
      { id: "next-1", type: "report.next", input: {} }
    ]
  });
  assert.equal(result.status, "failed");
  assert.equal(result.actions[0].status, "failed");
  assert.equal(secondCalls, 0);
  assert.equal(JSON.stringify(engine.getLedger()).includes("secret-value"), false);
});

test("action timeouts abort the handler and record a timed-out state", async () => {
  let aborted = false;
  const action = reportAction({
    timeoutMs: 20,
    execute: async (_input, { signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve({ saved: "cancelled" });
      }, { once: true });
    })
  });
  const engine = createAutonomousExecutionEngine({ actions: [action], policy: reportPolicy() });
  const result = await engine.execute(reportPlan());
  assert.equal(result.status, "timed-out");
  assert.equal(result.actions[0].status, "timed-out");
  assert.equal(aborted, true);
});

test("audit write latency cannot let a handler start after the total execution deadline", async () => {
  let calls = 0;
  const backing = createInMemoryExecutionLedger();
  const delayedLedger = {
    append: async (entry) => {
      if (entry.event === "action.started") {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      return backing.append(entry);
    },
    canAppend: (count) => backing.canAppend(count),
    verify: () => backing.verify(),
    snapshot: () => backing.snapshot()
  };
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({
      execute: async () => { calls += 1; return { saved: "reports/too-late.json" }; }
    })],
    policy: reportPolicy({
      limits: {
        maxActions: 5,
        maxExecutionMs: 500,
        maxActionMs: 1000,
        approvalTimeoutMs: 500,
        maxInputBytes: 4096,
        maxOutputBytes: 4096
      }
    }),
    ledger: delayedLedger
  });
  const result = await engine.execute(reportPlan());
  assert.equal(result.status, "timed-out");
  assert.equal(result.actions[0].status, "timed-out");
  assert.equal(calls, 0);
});

test("an external AbortSignal cancels an in-flight action", async () => {
  const controller = new AbortController();
  const action = reportAction({
    execute: async (_input, { signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ saved: "cancelled" }), { once: true });
      controller.abort();
    })
  });
  const engine = createAutonomousExecutionEngine({ actions: [action], policy: reportPolicy() });
  const result = await engine.execute(reportPlan(), { signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.equal(result.actions[0].status, "cancelled");
});

test("execution ids cannot be replayed by the same engine or an existing ledger", async () => {
  const ledger = createInMemoryExecutionLedger();
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction()],
    policy: reportPolicy(),
    ledger
  });
  await engine.execute(reportPlan(), { executionId: "execution-fixed-1" });
  await assert.rejects(
    engine.execute(reportPlan(), { executionId: "execution-fixed-1" }),
    /already been used/u
  );
});

test("plans cannot self-assign risk, permission or approval metadata", async () => {
  let calls = 0;
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({ execute: async () => { calls += 1; return { saved: "no" }; } })],
    policy: reportPolicy()
  });
  await assert.rejects(
    engine.execute({ actions: [{ id: "spoof-1", type: "report.write", risk: "low", approved: true, input: {} }] }),
    /unsupported or caller-controlled/u
  );
  assert.equal(calls, 0);
});

test("maxActions is enforced before any handler can run", async () => {
  let calls = 0;
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({ execute: async () => { calls += 1; return { saved: "yes" }; } })],
    policy: reportPolicy({ limits: { maxActions: 1 } })
  });
  await assert.rejects(
    engine.execute({ actions: [
      { id: "one", type: "report.write", input: { path: "reports/one.json" } },
      { id: "two", type: "report.write", input: { path: "reports/two.json" } }
    ] }),
    /maxActions limit/u
  );
  assert.equal(calls, 0);
});

test("empty plans are rejected", async () => {
  const engine = createAutonomousExecutionEngine({ actions: [], policy: {} });
  await assert.rejects(engine.execute({ actions: [] }), /at least one action/u);
});

test("a corrupt ledger prevents all execution", async () => {
  let calls = 0;
  const ledger = {
    append: async () => {},
    canAppend: () => true,
    verify: async () => ({ valid: false }),
    snapshot: () => []
  };
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({ execute: async () => { calls += 1; return { saved: "no" }; } })],
    policy: reportPolicy(),
    ledger
  });
  await assert.rejects(engine.execute(reportPlan()), /ledger failed integrity/u);
  assert.equal(calls, 0);
});

test("one engine instance runs only one plan at a time", async () => {
  let releaseAction;
  let signalStarted;
  const actionStarted = new Promise((resolve) => { signalStarted = resolve; });
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({
      execute: async () => new Promise((resolve) => {
        releaseAction = () => resolve({ saved: "reports/done.json" });
        signalStarted();
      })
    })],
    policy: reportPolicy()
  });
  const first = engine.execute(reportPlan());
  await actionStarted;
  await assert.rejects(engine.execute(reportPlan()), /already running/u);
  releaseAction();
  const result = await first;
  assert.equal(result.status, "succeeded");
});

test("ledger capacity is checked before any handler can execute", async () => {
  let calls = 0;
  const ledger = createInMemoryExecutionLedger({ maxRecords: 5 });
  const engine = createAutonomousExecutionEngine({
    actions: [reportAction({ execute: async () => { calls += 1; return { saved: "reports/no.json" }; } })],
    policy: reportPolicy(),
    ledger
  });
  await assert.rejects(engine.execute(reportPlan()), /insufficient record capacity/u);
  assert.equal(calls, 0);
  assert.equal(ledger.snapshot().length, 0);
});

test("ledger hash chains detect modified, truncated and reordered records", () => {
  const a = { event: "execution.started", sequence: 1, previousHash: "GENESIS" };
  const first = { ...a, hash: digestExecutionValue(a) };
  const b = { event: "execution.completed", sequence: 2, previousHash: first.hash };
  const second = { ...b, hash: digestExecutionValue(b) };
  assert.equal(verifyExecutionLedger([first, second]).valid, true);
  assert.equal(verifyExecutionLedger([{ ...first, event: "tampered" }, second]).valid, false);
  assert.equal(verifyExecutionLedger([second]).valid, false);
  assert.equal(verifyExecutionLedger([first]).valid, true);
});

test("JSONL ledger persists, reloads and verifies its hash chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-execution-ledger-"));
  const path = join(root, ".jb-expert-qa", "execution.jsonl");
  try {
    const ledger = await createJsonlExecutionLedger(path);
    await ledger.append({ event: "execution.started", executionId: "persisted-1" });
    await ledger.append({ event: "execution.completed", executionId: "persisted-1", status: "succeeded" });
    assert.equal(ledger.verify().valid, true);
    await ledger.close();

    const reopened = await createJsonlExecutionLedger(path);
    assert.equal(reopened.snapshot().length, 2);
    assert.equal(reopened.verify().valid, true);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSONL ledger fails closed when an existing record is edited", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-execution-ledger-tamper-"));
  const path = join(root, "execution.jsonl");
  try {
    const ledger = await createJsonlExecutionLedger(path);
    await ledger.append({ event: "execution.started", executionId: "tamper-1" });
    await ledger.close();
    const current = await readFile(path, "utf8");
    await writeFile(path, current.replace("execution.started", "execution.forged"), "utf8");
    await assert.rejects(createJsonlExecutionLedger(path), /integrity verification failed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy limits and duplicate action registrations are validated", () => {
  assert.throws(() => createAutonomousExecutionEngine({
    actions: [reportAction(), reportAction()],
    policy: reportPolicy()
  }), /Duplicate action handler/u);
  assert.throws(() => createAutonomousExecutionEngine({
    actions: [reportAction()],
    policy: reportPolicy({ limits: { maxActions: 51 } })
  }), /cannot exceed 50/u);
});

