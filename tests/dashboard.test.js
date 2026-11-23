import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditEngineRegistry } from "../src/audit-engines/index.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { createQaEngineRegistry } from "../src/engine-registry/index.js";
import { createDashboardPhase4Execution } from "../src/dashboard/phase4-execution.js";
import { createDashboardPhase4Catalog } from "../src/dashboard/phase4-catalog.js";
import { getQaEngineActionType, QA_ENGINE_EXECUTION_PERMISSION } from "../src/engine-registry/orchestrator.js";

async function startTestDashboard(t, options = {}) {
  const storageDirectory = options.storageDirectory ??
    await mkdtemp(join(tmpdir(), "jb-qa-control-center-"));
  const server = createDashboardServer({
    storageDirectory,
    registry: options.registry ?? createAuditEngineRegistry(),
    ...(Object.hasOwn(options, "phase4Registry") ? { phase4Registry: options.phase4Registry } : {}),
    ...(Object.hasOwn(options, "phase4Execution") ? { phase4Execution: options.phase4Execution } : {})
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = "http://127.0.0.1:" + address.port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (!options.storageDirectory) await rm(storageDirectory, { recursive: true, force: true });
  });
  return { server, origin, storageDirectory };
}

async function postRun(origin, payload, headers = {}) {
  return fetch(origin + "/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": origin, ...headers },
    body: JSON.stringify(payload)
  });
}

const passingReport = {
  scoring: { passed: true, score: 100 },
  summary: { findings: 0, rulesExecuted: 1, rulesWithErrors: 0 },
  diagnostics: []
};

function createPhase4EchoFixture({ requestApproval = async () => ({ approved: true, approvalId: "human-approval-1" }), policyOverrides = {}, run = async (input) => ({ echoed: input.value }), ledger } = {}) {
  let runnerCalls = 0;
  const registry = createQaEngineRegistry();
  registry.register({
    id: "jb.test.echo",
    name: "Dashboard Echo Engine",
    version: "1.0.0",
    category: "testing",
    targetType: "payload",
    executionMode: "in-process",
    capabilities: ["echo"],
    description: "A deterministic dashboard integration fixture",
    run: async (input) => {
      runnerCalls += 1;
      return run(input);
    }
  });
  registry.seal();
  const policy = {
    id: "dashboard-phase4-test-policy",
    grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
    rules: [{
      type: getQaEngineActionType("jb.test.echo"),
      maxRisk: "high",
      requireApproval: true
    }],
    limits: {
      maxActions: 1,
      maxExecutionMs: 5000,
      maxActionMs: 3000,
      approvalTimeoutMs: 2000,
      maxInputBytes: 4096,
      maxOutputBytes: 4096
    },
    ...policyOverrides
  };
  const execution = createDashboardPhase4Execution({
    registry, policy, requestApproval,
    ...(ledger === undefined ? {} : { ledger })
  });
  return { registry, execution, get runnerCalls() { return runnerCalls; } };
}

test("Dashboard Phase 4 catalog keeps API network origins inert unless the host explicitly allowlists exact origins", () => {
  const safeDefault = createDashboardPhase4Catalog();
  assert.equal(safeDefault.isSealed(), true);
  assert.equal(safeDefault.has("jb.api-testing-engine"), true);
  const configured = createDashboardPhase4Catalog({
    apiAllowedOrigins: ["https://api.example.test"]
  });
  assert.equal(configured.isSealed(), true);
  assert.equal(configured.has("jb.api-testing-engine"), true);
  assert.throws(
    () => createDashboardPhase4Catalog({ apiAllowedOrigins: ["https://api.example.test/path"] }),
    /exact HTTP\(S\) origins/
  );
  assert.throws(
    () => createDashboardPhase4Catalog({ apiAllowedOrigins: ["*"] }),
    /invalid URL/
  );
});

test("Phase 4 execution is disabled by default and POST cannot bypass missing host configuration", async (t) => {
  const { origin } = await startTestDashboard(t);
  const status = await fetch(origin + "/api/phase4/execution");
  assert.equal(status.status, 200);
  const configuration = await status.json();
  assert.equal(configuration.enabled, false);
  assert.equal(configuration.approvalRequired, true);
  assert.equal(configuration.allowedEngineIds.length, 0);
  assert.equal(configuration.permission, "qa:engine-execute");

  const response = await fetch(origin + "/api/phase4/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": origin },
    body: JSON.stringify({ engineId: "jb.test.echo", input: { value: "must-not-run" } })
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "phase4_execution_disabled");
});

test("Dashboard bridge rejects nested accessors, circular structures and oversized input before approval", async () => {
  let getterInvoked = false;
  let approvalCalls = 0;
  const fixture = createPhase4EchoFixture({
    requestApproval: async () => {
      approvalCalls += 1;
      return { approved: true, approvalId: "should-not-be-requested" };
    }
  });
  const accessorInput = { value: "safe" };
  Object.defineProperty(accessorInput, "extra", {
    enumerable: true,
    get() {
      getterInvoked = true;
      return "unsafe";
    }
  });
  await assert.rejects(
    fixture.execution.executeEngine("jb.test.echo", accessorInput),
    (error) => error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(getterInvoked, false);

  const circularInput = { value: "safe" };
  circularInput.self = circularInput;
  await assert.rejects(
    fixture.execution.executeEngine("jb.test.echo", circularInput),
    (error) => error.code === "INVALID_INPUT"
  );

  await assert.rejects(
    fixture.execution.executeEngine("jb.test.echo", { value: "x".repeat(17000) }),
    (error) => error.code === "INPUT_TOO_LARGE"
  );
  assert.equal(approvalCalls, 0);
  assert.equal(fixture.runnerCalls, 0);
});

test("Dashboard creates a policy-gated request and executes only after external approval", async (t) => {
  const approvals = [];
  const fixture = createPhase4EchoFixture({
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true, approvalId: "external-human-approval-1" };
    }
  });
  const { origin } = await startTestDashboard(t, {
    phase4Registry: fixture.registry,
    phase4Execution: fixture.execution
  });

  const statusResponse = await fetch(origin + "/api/phase4/execution");
  const status = await statusResponse.json();
  assert.equal(status.enabled, true);
  assert.equal(status.policyId, "dashboard-phase4-test-policy");
  assert.deepEqual(status.allowedEngineIds, ["jb.test.echo"]);
  assert.equal(status.approvalRequired, true);

  const catalog = await fetch(origin + "/api/phase4/engines");
  const catalogData = await catalog.json();
  assert.equal(catalogData.executionEnabled, true);

  const response = await fetch(origin + "/api/phase4/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": origin },
    body: JSON.stringify({ engineId: "jb.test.echo", input: { value: "approved-input", url: "https://example.test/private/path?token=review-secret" } })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "succeeded");
  assert.equal(result.actions[0].status, "succeeded");
  assert.deepEqual(result.actions[0].output, { echoed: "approved-input" });
  assert.equal(result.ledgerIntegrity, true);
  assert.equal(fixture.runnerCalls, 1);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].actionType, getQaEngineActionType("jb.test.echo"));
  assert.equal(approvals[0].risk, "high");
  assert.equal(approvals[0].permissions.includes(QA_ENGINE_EXECUTION_PERMISSION), true);
  assert.equal(approvals[0].input, undefined);
  assert.equal(typeof approvals[0].inputDigest, "string");
  assert.deepEqual(approvals[0].reviewContext.target, {
    kind: "url", origin: "https://example.test", path: "/private/path"
  });
  assert.equal(JSON.stringify(approvals).includes("review-secret"), false);
  assert.equal(JSON.stringify(approvals).includes("approved-input"), false);
});

test("Phase 4 audit endpoint exposes redacted evidence and verifies the ledger chain", async (t) => {
  const fixture = createPhase4EchoFixture();
  const { origin } = await startTestDashboard(t, {
    phase4Registry: fixture.registry,
    phase4Execution: fixture.execution
  });
  const run = await fetch(origin + "/api/phase4/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": origin },
    body: JSON.stringify({
      engineId: "jb.test.echo",
      input: { value: "private-audit-input", url: "https://example.test/private?token=never-expose-this" }
    })
  });
  assert.equal(run.status, 200);

  const response = await fetch(origin + "/api/phase4/audit?limit=100");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const audit = await response.json();
  assert.equal(audit.enabled, true);
  assert.equal(audit.integrity.valid, true);
  assert.equal(audit.integrity.entries, audit.records.length);
  assert.equal(audit.pagination.total, audit.records.length);
  assert.ok(audit.records.some((record) => record.event === "action.approval-requested" && record.approvalOutcome === "requested"));
  assert.ok(audit.records.some((record) => record.event === "action.approved" && record.approvalOutcome === "approved"));
  assert.ok(audit.records.some((record) => record.event === "action.succeeded" && /^[a-f0-9]{64}$/u.test(record.outputDigest)));
  assert.ok(audit.records.every((record) => !Object.hasOwn(record, "approvalId")));
  const serialized = JSON.stringify(audit);
  for (const secret of ["private-audit-input", "never-expose-this", "human-approval-1", "echoed"]) {
    assert.equal(serialized.includes(secret), false, "audit endpoint leaked " + secret);
  }
  assert.ok(audit.records.every((record) => !Object.hasOwn(record, "input") && !Object.hasOwn(record, "output")));
});

test("Phase 4 audit pagination is bounded, stable and rejects invalid cursors", async (t) => {
  const fixture = createPhase4EchoFixture();
  const { origin } = await startTestDashboard(t, {
    phase4Registry: fixture.registry,
    phase4Execution: fixture.execution
  });
  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(origin + "/api/phase4/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": origin },
      body: JSON.stringify({ engineId: "jb.test.echo", input: { value: "run-" + index } })
    });
    assert.equal(response.status, 200);
  }
  const first = await fetch(origin + "/api/phase4/audit?limit=3");
  const pageOne = await first.json();
  assert.equal(pageOne.records.length, 3);
  assert.equal(pageOne.pagination.hasMore, true);
  assert.ok(Number.isSafeInteger(pageOne.pagination.nextBeforeSequence));
  const second = await fetch(origin + "/api/phase4/audit?limit=3&before=" + pageOne.pagination.nextBeforeSequence);
  const pageTwo = await second.json();
  assert.equal(pageTwo.records.length, 3);
  assert.ok(pageTwo.records.at(-1).sequence < pageOne.records[0].sequence);
  const invalid = await fetch(origin + "/api/phase4/audit?limit=101");
  assert.equal(invalid.status, 400);
  const repeated = await fetch(origin + "/api/phase4/audit?limit=2&limit=3");
  assert.equal(repeated.status, 400);
});

test("Phase 4 audit reports an invalid hash chain without suppressing redacted evidence", async (t) => {
  let corrupted = false;
  const { createInMemoryExecutionLedger } = await import("../src/agent/execution-ledger.js");
  const baseLedger = createInMemoryExecutionLedger();
  const ledger = {
    append: (...args) => baseLedger.append(...args),
    snapshot: () => baseLedger.snapshot(),
    canAppend: (...args) => baseLedger.canAppend(...args),
    verify: () => corrupted
      ? { valid: false, entries: baseLedger.snapshot().length, reason: "hash-mismatch" }
      : baseLedger.verify()
  };
  const fixture = createPhase4EchoFixture({ ledger });
  const { origin } = await startTestDashboard(t, {
    phase4Registry: fixture.registry,
    phase4Execution: fixture.execution
  });
  const run = await fetch(origin + "/api/phase4/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": origin },
    body: JSON.stringify({ engineId: "jb.test.echo", input: { value: "verified-before-tamper" } })
  });
  assert.equal(run.status, 200);
  corrupted = true;
  const response = await fetch(origin + "/api/phase4/audit");
  const audit = await response.json();
  assert.equal(audit.integrity.valid, false);
  assert.equal(audit.integrity.reason, "hash-mismatch");
  assert.ok(audit.records.length > 0);
});

test("Phase 4 audit remains unavailable while policy-gated execution is disabled", async (t) => {
  const { origin } = await startTestDashboard(t);
  const response = await fetch(origin + "/api/phase4/audit");
  assert.equal(response.status, 200);
  const audit = await response.json();
  assert.equal(audit.enabled, false);
  assert.equal(audit.approvalRequired, true);
  assert.deepEqual(audit.records, []);
});

test("Dashboard never runs an engine after external approval is denied", async (t) => {
  const fixture = createPhase4EchoFixture({
    requestApproval: async () => ({ approved: false })
  });
  const { origin } = await startTestDashboard(t, {
    phase4Registry: fixture.registry,
    phase4Execution: fixture.execution
  });
  const response = await fetch(origin + "/api/phase4/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": origin },
    body: JSON.stringify({ engineId: "jb.test.echo", input: { value: "denied-input" } })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "blocked");
  assert.equal(result.actions[0].status, "blocked");
  assert.equal(fixture.runnerCalls, 0);
  assert.equal(result.ledgerIntegrity, true);
});

test("Dashboard rejects engine IDs outside the exact host allowlist and policy override fields", async (t) => {
  const fixture = createPhase4EchoFixture();
  const { origin } = await startTestDashboard(t, {
    phase4Registry: fixture.registry,
    phase4Execution: fixture.execution
  });
  const denied = await fetch(origin + "/api/phase4/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": origin },
    body: JSON.stringify({ engineId: "jb.other.engine", input: {} })
  });
  assert.equal(denied.status, 403);
  assert.equal(fixture.runnerCalls, 0);

  const override = await fetch(origin + "/api/phase4/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": origin },
    body: JSON.stringify({
      engineId: "jb.test.echo",
      input: { value: "not-used" },
      policy: { grantedPermissions: ["qa:engine-execute"] },
      approvalReceipt: { approved: true }
    })
  });
  assert.equal(override.status, 400);
  assert.equal(fixture.runnerCalls, 0);
});

test("Dashboard execution rejects cross-origin requests before approval or runner invocation", async (t) => {
  let approvalCalls = 0;
  const fixture = createPhase4EchoFixture({
    requestApproval: async () => { approvalCalls += 1; return { approved: true, approvalId: "never-used" }; }
  });
  const { origin } = await startTestDashboard(t, {
    phase4Registry: fixture.registry,
    phase4Execution: fixture.execution
  });
  const response = await fetch(origin + "/api/phase4/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://outside.example" },
    body: JSON.stringify({ engineId: "jb.test.echo", input: {} })
  });
  assert.equal(response.status, 403);
  assert.equal(approvalCalls, 0);
  assert.equal(fixture.runnerCalls, 0);
});

test("Dashboard execution bridge rejects missing permission, missing approval, weak risk and unsealed registry", () => {
  const registry = createQaEngineRegistry();
  registry.register({
    id: "jb.test.echo",
    name: "Echo",
    version: "1.0.0",
    category: "testing",
    targetType: "payload",
    executionMode: "in-process",
    capabilities: ["echo"],
    run: async () => ({ ok: true })
  });
  const rule = { type: getQaEngineActionType("jb.test.echo"), maxRisk: "high", requireApproval: true };
  assert.throws(
    () => createDashboardPhase4Execution({ registry, policy: { id: "test-policy", grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION], rules: [rule] }, requestApproval: async () => ({ approved: true, approvalId: "x" }) }),
    (error) => error.code === "REGISTRY_NOT_SEALED"
  );
  registry.seal();

  assert.throws(
    () => createDashboardPhase4Execution({ registry, policy: { id: "test-policy", grantedPermissions: [], rules: [rule] }, requestApproval: async () => ({ approved: true, approvalId: "x" }) }),
    (error) => error.code === "MISSING_EXECUTION_PERMISSION"
  );
  assert.throws(
    () => createDashboardPhase4Execution({ registry, policy: { id: "test-policy", grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION], rules: [rule] } }),
    (error) => error.code === "APPROVAL_PROVIDER_REQUIRED"
  );
  assert.throws(
    () => createDashboardPhase4Execution({ registry, policy: { id: "test-policy", grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION], rules: [{ ...rule, maxRisk: "low" }] }, requestApproval: async () => ({ approved: true, approvalId: "x" }) }),
    (error) => error.code === "RISK_CEILING_REQUIRED"
  );
  assert.throws(
    () => createDashboardPhase4Execution({ registry, policy: { id: "test-policy", grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION], rules: [{ ...rule, type: "qa.engine.jb.not-registered" }] }, requestApproval: async () => ({ approved: true, approvalId: "x" }) }),
    (error) => error.code === "INVALID_ALLOWLIST"
  );
  assert.throws(
    () => createDashboardPhase4Execution({
      registry,
      policy: { id: "test-policy", grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION, "reports:write"], rules: [rule] },
      requestApproval: async () => ({ approved: true, approvalId: "x" })
    }),
    (error) => error.code === "MISSING_EXECUTION_PERMISSION"
  );
  assert.throws(
    () => createDashboardPhase4Execution({
      registry,
      policy: {
        id: "test-policy",
        grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
        rules: [{ type: rule.type, maxRisk: "high" }]
      },
      requestApproval: async () => ({ approved: true, approvalId: "x" })
    }),
    (error) => error.code === "APPROVAL_REQUIRED"
  );
});

test("Dashboard refuses an execution bridge created for a different registry", () => {
  const fixture = createPhase4EchoFixture();
  const otherRegistry = createQaEngineRegistry();
  otherRegistry.register({
    id: "jb.test.other",
    name: "Other",
    version: "1.0.0",
    category: "testing",
    targetType: "payload",
    executionMode: "in-process",
    capabilities: ["other"],
    run: async () => ({ ok: true })
  });
  otherRegistry.seal();
  assert.throws(
    () => createDashboardServer({
      phase4Registry: otherRegistry,
      phase4Execution: fixture.execution
    }),
    /same sealed phase4Registry/
  );
});

test("dashboard serves the local UI, engine registry and restrictive browser headers", async (t) => {
  const { origin, server } = await startTestDashboard(t);
  assert.equal(server.address().address, "127.0.0.1");
  const page = await fetch(origin + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const pageHtml = await page.text();
  assert.match(pageHtml, /QA Control Center/);
  assert.match(pageHtml, /Policy-gated engine runner/);
  assert.match(pageHtml, /Request approved execution/);
  assert.match(pageHtml, /Execution Audit &amp; Evidence/);
  assert.match(pageHtml, /Refresh evidence/);
  assert.match(pageHtml, /Top recurring findings/);
  assert.match(pageHtml, /analytics-assessment/);

  const script = await fetch(origin + "/assets/app.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);

  const engines = await fetch(origin + "/api/engines");
  const data = await engines.json();
  assert.equal(data.engines.length, 7);
  assert.ok(data.engines.some((engine) => engine.id === "visual"));
});

test("Control Center exposes Phase 4 registry metadata without executing engines", async (t) => {
  let runnerCalls = 0;
  const phase4Registry = createQaEngineRegistry({
    adapters: [{
      id: "jb.visual-qa-engine",
      name: "Visual QA Engine",
      version: "1.0.0",
      category: "visual",
      targetType: "url",
      executionMode: "browser",
      capabilities: ["viewport-audit", "screenshot-capture"],
      description: "Read-only visual observations",
      run: async () => { runnerCalls += 1; return { passed: true }; }
    }]
  });
  phase4Registry.seal();
  const { origin } = await startTestDashboard(t, { phase4Registry });

  const response = await fetch(origin + "/api/phase4/engines");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();
  assert.equal(data.executionEnabled, false);
  assert.equal(data.approvalRequired, true);
  assert.equal(data.engines.length, 1);
  assert.deepEqual(data.engines[0], {
    id: "jb.visual-qa-engine",
    name: "Visual QA Engine",
    version: "1.0.0",
    category: "visual",
    targetType: "url",
    executionMode: "browser",
    capabilities: ["viewport-audit", "screenshot-capture"],
    description: "Read-only visual observations"
  });
  assert.equal(runnerCalls, 0);
  const page = await fetch(origin + "/");
  assert.match(await page.text(), /Autonomous engine catalog/);
  const js = await fetch(origin + "/assets/app.js");
  assert.match(await js.text(), /refreshPhase4Engines/);
});

test("Control Center includes built-in Phase 4 engine catalog by default", async (t) => {
  const { origin } = await startTestDashboard(t);
  const response = await fetch(origin + "/api/phase4/engines");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.executionEnabled, false);
  assert.equal(data.approvalRequired, true);
  assert.equal(data.engines.length, 8);
  const ids = data.engines.map((engine) => engine.id);
  assert.deepEqual(ids, [
    "jb.api-testing-engine",
    "jb.static-qa-engine",
    "jb.static-security-qa-engine",
    "jb.runtime-security-qa-engine",
    "jb.accessibility-qa-engine",
    "jb.performance-qa-engine",
    "jb.visual-qa-engine",
    "jb.report-certification-engine"
  ]);
  assert.ok(data.engines.every((engine) => !Object.hasOwn(engine, "run")));
});

test("dashboard rejects untrusted host headers, cross-origin requests and malformed targets", async (t) => {
  const { origin } = await startTestDashboard(t);
  const wrongOrigin = await postRun(origin, {
    engineId: "static",
    target: { path: "./" }
  }, { Origin: "https://outside.example" });
  assert.equal(wrongOrigin.status, 403);

  const wrongHost = await new Promise((resolve, reject) => {
    const address = new URL(origin);
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: Number(address.port),
      path: "/api/engines",
      headers: { Host: "outside.example" }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
  assert.equal(wrongHost, 421);

  const extraField = await postRun(origin, {
    engineId: "static",
    target: { path: "./", url: "https://example.com" }
  });
  assert.equal(extraField.status, 400);

  const wrongTargetType = await postRun(origin, {
    engineId: "static",
    target: { url: "https://example.com" }
  });
  assert.equal(wrongTargetType.status, 400);

  const unregisteredEngine = await postRun(origin, {
    engineId: "shell",
    target: { path: "./" }
  });
  assert.equal(unregisteredEngine.status, 400);
});

test("dashboard caps request bodies and requires JSON for audit execution", async (t) => {
  const storageDirectory = await mkdtemp(join(tmpdir(), "jb-qa-control-center-limit-"));
  const server = createDashboardServer({ storageDirectory, maximumBodyBytes: 1024 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(storageDirectory, { recursive: true, force: true });
  });

  const wrongType = await fetch(origin + "/api/runs", {
    method: "POST",
    headers: { "Origin": origin, "Content-Type": "text/plain" },
    body: "not json"
  });
  assert.equal(wrongType.status, 415);

  const oversized = await fetch(origin + "/api/runs", {
    method: "POST",
    headers: { "Origin": origin, "Content-Type": "application/json" },
    body: JSON.stringify({ engineId: "static", target: { path: "x".repeat(1800) } })
  });
  assert.equal(oversized.status, 413);
});

test("dashboard stores local history, compares repeated runs and exports an internal certificate", async (t) => {
  let iteration = 0;
  const registry = createAuditEngineRegistry({
    adapters: {
      static: async () => {
        iteration += 1;
        const diagnostics = [{
          id: "STATIC-BASE",
          ruleId: "static.base",
          title: "Baseline observation",
          description: "Stable finding",
          severity: "low",
          location: "src/index.js"
        }];
        if (iteration > 1) {
          diagnostics.push({
            id: "STATIC-NEW",
            ruleId: "static.new",
            title: "New observation",
            description: "Added after the previous run",
            severity: "medium",
            location: "src/app.js"
          });
        }
        return {
          scoring: { passed: true, score: iteration === 1 ? 94 : 89 },
          summary: { findings: diagnostics.length, rulesExecuted: 12, rulesWithErrors: 0 },
          diagnostics
        };
      }
    }
  });
  const { origin, storageDirectory } = await startTestDashboard(t, { registry });
  const firstResponse = await postRun(origin, { engineId: "static", target: { path: "./sample-project" } });
  assert.equal(firstResponse.status, 201);
  const first = (await firstResponse.json()).record;
  assert.equal(first.outcome, "passed_with_observations");
  assert.equal(first.findingsCount, 1);
  assert.equal(first.comparison, null);

  const secondResponse = await postRun(origin, { engineId: "static", target: { path: "./sample-project" } });
  assert.equal(secondResponse.status, 201);
  const second = (await secondResponse.json()).record;
  assert.equal(second.findingsCount, 2);
  assert.equal(second.comparison.previousRunId, first.id);
  assert.equal(second.comparison.scoreDelta, -5);
  assert.equal(second.comparison.findingsDelta, 1);
  assert.equal(second.comparison.newFindingsCount, 1);
  assert.equal(second.comparison.resolvedFindingsCount, 0);

  const historyResponse = await fetch(origin + "/api/history");
  const history = await historyResponse.json();
  assert.equal(history.count, 2);
  assert.equal(history.history[0].id, second.id);

  const detail = await fetch(origin + "/api/history/" + second.id);
  const detailData = await detail.json();
  assert.equal(detailData.record.findings.length, 2);

  const certificateResponse = await fetch(origin + "/api/certificates/" + second.id);
  assert.equal(certificateResponse.status, 200);
  assert.match(certificateResponse.headers.get("content-disposition"), /attachment/);
  const certificate = await certificateResponse.text();
  assert.match(certificate, /Internal QA Certification Report/i);
  assert.match(certificate, /New observation/);
  assert.match(certificate, /not independent third-party certification/i);

  const persisted = JSON.parse(await readFile(join(storageDirectory, "history.json"), "utf8"));
  assert.equal(persisted.length, 2);
  assert.ok(persisted.every((entry) => !Object.hasOwn(entry, "report")));
});

test("dashboard prevents overlapping audit execution", async (t) => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const registry = createAuditEngineRegistry({
    adapters: {
      static: async () => {
        started();
        await releasePromise;
        return passingReport;
      }
    }
  });
  const { origin } = await startTestDashboard(t, { registry });
  const first = postRun(origin, { engineId: "static", target: { path: "./" } });
  await startedPromise;
  const second = await postRun(origin, { engineId: "static", target: { path: "./" } });
  assert.equal(second.status, 409);
  release();
  const completed = await first;
  assert.equal(completed.status, 201);
});

test("dashboard rate-limits repeated local audit requests and serves only known assets", async (t) => {
  const registry = createAuditEngineRegistry({ adapters: { static: async () => passingReport } });
  const { origin } = await startTestDashboard(t, { registry });
  for (let index = 0; index < 15; index += 1) {
    const response = await postRun(origin, { engineId: "static", target: { path: "./" } });
    assert.equal(response.status, 201);
  }
  const limited = await postRun(origin, { engineId: "static", target: { path: "./" } });
  assert.equal(limited.status, 429);
  const missing = await fetch(origin + "/assets/../../package.json");
  assert.equal(missing.status, 404);
});


test("dashboard exposes consolidated analytics and downloads a scoped Markdown report", async (t) => {
  let cycle = 0;
  const registry = createAuditEngineRegistry({
    adapters: {
      static: async () => {
        cycle += 1;
        const findings = cycle === 1
          ? [{ id: "S-1", ruleId: "static.rule", title: "One finding", severity: "high", location: "src/a.js" }]
          : [];
        return {
          scoring: { passed: true, score: cycle === 1 ? 82 : 98 },
          summary: { findings: findings.length, rulesExecuted: 8, rulesWithErrors: 0 },
          diagnostics: findings
        };
      }
    }
  });
  const { origin } = await startTestDashboard(t, { registry });
  await postRun(origin, { engineId: "static", target: { path: "./sample-project" } });
  await postRun(origin, { engineId: "static", target: { path: "./sample-project" } });

  const analyticsResponse = await fetch(origin + "/api/analytics");
  assert.equal(analyticsResponse.status, 200);
  const analytics = await analyticsResponse.json();
  assert.equal(analytics.retainedHistoryCount, 2);
  assert.equal(analytics.currentSnapshotCount, 1);
  assert.equal(analytics.averageCurrentScore, 98);
  assert.equal(analytics.severityCounts.high, 0);
  assert.equal(analytics.usedEngineCount, 1);

  const reportResponse = await fetch(origin + "/api/reports/consolidated");
  assert.equal(reportResponse.status, 200);
  assert.match(reportResponse.headers.get("content-disposition"), /attachment/);
  const report = await reportResponse.text();
  assert.match(report, /Consolidated QA Intelligence Report/);
  assert.match(report, /Engine coverage means/);
  assert.match(report, /not a third-party certification/i);
});
