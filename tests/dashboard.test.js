import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditEngineRegistry } from "../src/audit-engines/index.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { createQaEngineRegistry } from "../src/engine-registry/index.js";

async function startTestDashboard(t, options = {}) {
  const storageDirectory = options.storageDirectory ??
    await mkdtemp(join(tmpdir(), "jb-qa-control-center-"));
  const server = createDashboardServer({
    storageDirectory,
    registry: options.registry ?? createAuditEngineRegistry()
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

test("dashboard serves the local UI, engine registry and restrictive browser headers", async (t) => {
  const { origin, server } = await startTestDashboard(t);
  assert.equal(server.address().address, "127.0.0.1");
  const page = await fetch(origin + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const pageHtml = await page.text();
  assert.match(pageHtml, /QA Control Center/);
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
