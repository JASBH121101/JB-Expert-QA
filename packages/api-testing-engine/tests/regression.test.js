import test from "node:test";
import { createServer } from "node:http";
import { createApiRequestEngine } from "../src/index.js";
import assert from "node:assert/strict";
import {
  API_REGRESSION_BASELINE_SCHEMA,
  API_REGRESSION_ENGINE_ID,
  ApiRegressionError,
  createApiRegressionEngine
} from "../src/regression.js";

function response(overrides = {}) {
  return {
    method: "GET",
    url: "https://api.example.test/v1/users",
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store", date: "Mon, 01 Jan 2024 00:00:00 GMT" },
    jsonParsed: true,
    json: { data: { id: 7, name: "Ada", active: true }, meta: { requestId: "abc" } },
    durationMs: 120,
    ...overrides
  };
}

const engine = () => createApiRegressionEngine();

test("exports a versioned dependency-free regression engine", () => {
  const api = engine();
  assert.equal(api.engineId, API_REGRESSION_ENGINE_ID);
  assert.equal(typeof api.createBaseline, "function");
  assert.equal(typeof api.compare, "function");
  assert.equal(typeof api.compile, "function");
});

test("creates immutable baselines without retaining response bodies or values", () => {
  const baseline = engine().createBaseline(response({ bodyText: "raw response body" }), {
    baselineId: "users-api-v1", capturedAt: "2026-01-01T00:00:00.000Z", valuePaths: ["$.data.id"]
  });
  assert.equal(baseline.schema, API_REGRESSION_BASELINE_SCHEMA);
  assert.equal(baseline.baselineId, "users-api-v1");
  assert.equal(Object.isFrozen(baseline), true);
  assert.equal(JSON.stringify(baseline).includes("Ada"), false);
  assert.equal(JSON.stringify(baseline).includes("raw response body"), false);
  assert.match(baseline.json.valueHashes[0].valueHash, /^[a-f0-9]{64}$/u);
});

test("passes stable responses and ignores unselected volatile headers and JSON paths", () => {
  const api = engine();
  const baseline = api.createBaseline(response(), { ignoredJsonPaths: ["$.meta.requestId"] });
  const report = api.compare(baseline, response({
    headers: { "content-type": "application/json", "cache-control": "no-store", date: "Tue, 02 Jan 2024 00:00:00 GMT" },
    json: { meta: { requestId: "def" }, data: { name: "Grace", id: 9, active: false } }
  }));
  assert.equal(report.status, "passed");
  assert.equal(report.failedCount, 0);
  assert.equal(report.checks.find((item) => item.id === "json:shape").status, "passed");
});

test("detects HTTP status and endpoint regressions", () => {
  const api = engine();
  const baseline = api.createBaseline(response());
  const report = api.compare(baseline, response({ status: 503, url: "https://api.example.test/v2/users" }));
  assert.equal(report.status, "regression");
  assert.equal(report.checks.find((item) => item.id === "status").code, "HTTP_STATUS_CHANGED");
  assert.equal(report.checks.find((item) => item.id === "endpoint").status, "failed");
});

test("detects selected response header changes without storing raw values", () => {
  const api = engine();
  const baseline = api.createBaseline(response(), { headerNames: ["content-type", "cache-control"] });
  assert.equal(JSON.stringify(baseline).includes("no-store"), false);
  const report = api.compare(baseline, response({ headers: { "content-type": "text/plain", "cache-control": "public" } }));
  assert.equal(report.checks.find((item) => item.id === "header:content-type").status, "failed");
  assert.equal(report.checks.find((item) => item.id === "header:cache-control").status, "failed");
});

test("detects removed, added and changed JSON structure and types", () => {
  const api = engine();
  const baseline = api.createBaseline(response());
  const report = api.compare(baseline, response({ json: { data: { id: "7", name: "Ada" }, extra: true } }));
  const shape = report.checks.find((item) => item.id === "json:shape");
  assert.equal(shape.status, "failed");
  assert.ok(shape.details.addedCount > 0);
  assert.ok(shape.details.removedCount > 0);
});

test("detects explicitly selected JSON value changes without exposing values", () => {
  const api = engine();
  const baseline = api.createBaseline(response(), { valuePaths: ["$.data.id"] });
  const report = api.compare(baseline, response({ json: { data: { id: 8, name: "Ada", active: true }, meta: { requestId: "abc" } } }));
  const check = report.checks.find((item) => item.id === "json:value:$.data.id");
  assert.equal(check.status, "failed");
  assert.equal(JSON.stringify(report).includes('"actualValue"'), false);
  assert.equal(JSON.stringify(report).includes('"id":8'), false);
});

test("detects latency increase only when an explicit threshold is configured", () => {
  const api = engine();
  const baseline = api.createBaseline(response({ durationMs: 100 }));
  const unconfigured = api.compare(baseline, response({ durationMs: 900 }));
  assert.equal(unconfigured.checks.find((item) => item.id === "latency").status, "skipped");
  const configured = api.compare(baseline, response({ durationMs: 900 }), { maxLatencyIncreaseMs: 500 });
  assert.equal(configured.checks.find((item) => item.id === "latency").status, "failed");
});

test("supports percentage latency thresholds and reports improvements within policy", () => {
  const api = engine();
  const baseline = api.createBaseline(response({ durationMs: 100 }));
  const slow = api.compare(baseline, response({ durationMs: 250 }), { maxLatencyIncreasePercent: 100 });
  const faster = api.compare(baseline, response({ durationMs: 50 }), { maxLatencyIncreasePercent: 100 });
  assert.equal(slow.checks.find((item) => item.id === "latency").status, "failed");
  assert.equal(faster.checks.find((item) => item.id === "latency").status, "passed");
});

test("reports JSON parse-state changes", () => {
  const api = engine();
  const baseline = api.createBaseline(response());
  const report = api.compare(baseline, response({ jsonParsed: false, json: null }));
  assert.equal(report.checks.find((item) => item.id === "json:parse").code, "JSON_PARSE_STATE_CHANGED");
});

test("compiles reusable immutable baselines without shared mutable state", () => {
  const api = engine();
  const baseline = api.createBaseline(response());
  const compiled = api.compile(baseline);
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(compiled.baselineId, "default");
  assert.equal(compiled.compare(response()).status, "passed");
  assert.equal(compiled.compare(response({ status: 500 })).status, "regression");
  assert.equal(Object.isFrozen(baseline), true);
});

test("rejects sensitive paths and headers, unknown options and malformed responses", () => {
  const api = engine();
  assert.throws(() => api.createBaseline(response(), { valuePaths: ["$.data.password"] }), /sensitive property/u);
  assert.throws(() => api.createBaseline(response(), { headerNames: ["authorization"] }), /Sensitive response headers/u);
  assert.throws(() => api.createBaseline(response(), { autoUpdate: true }), /unsupported field/u);
  assert.throws(() => api.createBaseline(response({ status: 700 })), /valid HTTP status/u);
});

test("rejects getters and unsafe JSON values without invoking accessors", () => {
  const api = engine();
  const input = response();
  let invoked = false;
  Object.defineProperty(input.json.data, "secret", { enumerable: true, get() { invoked = true; return "value"; } });
  assert.throws(() => api.createBaseline(input), /getters or setters/u);
  assert.equal(invoked, false);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => api.createBaseline(response({ json: cyclic })), /circular data/u);
});

test("rejects unsupported or tampered baseline versions and shape data", () => {
  const api = engine();
  const baseline = api.createBaseline(response());
  assert.throws(() => api.compare({ ...baseline, schema: "jb.api-regression-baseline/v9" }, response()),
    (error) => error instanceof ApiRegressionError && error.code === "UNSUPPORTED_BASELINE");
  assert.throws(() => api.compare({ ...baseline, extra: true }, response()), /unsupported|not supported/u);
});

test("ignores query credential parameters through the request engine's sanitized URL and stores only a digest", () => {
  const api = engine();
  const baseline = api.createBaseline(response({ url: "https://api.example.test/v1/users?access_token=%5BREDACTED%5D" }));
  assert.equal(JSON.stringify(baseline).includes("access_token"), false);
  assert.match(baseline.request.endpointHash, /^[a-f0-9]{64}$/u);
});

test("handles sensitive field names in JSON structure without retaining their values", () => {
  const api = engine();
  const baseline = api.createBaseline(response({ json: { user: { password: "secret-1", access_token: "token-1" } } }));
  const report = api.compare(baseline, response({ json: { user: { password: "secret-2", access_token: "token-2" } } }));
  assert.equal(report.status, "passed");
  assert.equal(JSON.stringify(baseline).includes("secret-1"), false);
  assert.equal(JSON.stringify(report).includes("password"), false);
});

test("integrates with the Request Engine using ephemeral loopback HTTP responses", async (t) => {
  let payload = { data: { id: 9, active: true } };
  const server = createServer((_request, outgoing) => {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  const origin = "http://127.0.0.1:" + address.port;
  const requests = createApiRequestEngine({ allowedOrigins: [origin] });
  const regression = engine();
  const first = await requests.request({ method: "GET", url: origin + "/v1/resource" });
  const baseline = regression.createBaseline(first, { valuePaths: ["$.data.active"] });

  payload = { data: { id: 9, active: false } };
  const second = await requests.request({ method: "GET", url: origin + "/v1/resource" });
  const report = regression.compare(baseline, second);

  assert.equal(report.status, "regression");
  assert.equal(report.checks.find((item) => item.id === "json:shape").status, "passed");
  assert.equal(report.checks.find((item) => item.id === "json:value:$.data.active").status, "failed");
});
