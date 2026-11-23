import test from "node:test";
import assert from "node:assert/strict";
import {
  createApiTestingEngineAdapter,
  registerApiTestingEngine,
  ApiTestingAdapterError,
  API_TESTING_ADAPTER_ID,
  API_TESTING_ADAPTER_OPERATIONS
} from "../src/engine-registry/adapters/api-testing.js";
import { createQaEngineRegistry } from "../src/engine-registry/index.js";

function fakeFetch(body = { ok: true }, headers = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", ...headers }
      });
    }
  };
}

function adapterOptions(overrides = {}) {
  return {
    allowedOrigins: ["https://api.adapter.test"],
    fetchImpl: fakeFetch().fetchImpl,
    ...overrides
  };
}

function response(overrides = {}) {
  return {
    engineId: "jb.api-testing-engine",
    method: "GET",
    url: "https://api.adapter.test/health",
    responseUrl: "https://api.adapter.test/health",
    status: 200,
    statusText: "OK",
    ok: true,
    redirected: false,
    headers: Object.freeze({ "content-type": "application/json" }),
    bodyText: "{\"ok\":true}",
    bytesReceived: 11,
    durationMs: 4,
    jsonParsed: true,
    json: { ok: true },
    ...overrides
  };
}

test("adapter publishes a central-registry-compatible API manifest", () => {
  const adapter = createApiTestingEngineAdapter(adapterOptions());
  assert.equal(adapter.id, API_TESTING_ADAPTER_ID);
  assert.equal(adapter.category, "api");
  assert.equal(adapter.targetType, "payload");
  assert.equal(adapter.executionMode, "in-process");
  assert.deepEqual(adapter.capabilities, [
    "api-request", "assertions", "contracts", "passive-security",
    "workflows", "regression", "rate-limit-observation"
  ]);
  assert.ok(Object.isFrozen(adapter));
  assert.ok(Object.isFrozen(adapter.capabilities));
  assert.deepEqual(API_TESTING_ADAPTER_OPERATIONS, [
    "request", "assertions", "contract", "security",
    "workflow", "regression-baseline", "regression-compare", "rate-limit"
  ]);
});

test("registration adds metadata only and the central registry can discover the API adapter", () => {
  const registry = createQaEngineRegistry();
  const fixture = fakeFetch();
  const metadata = registerApiTestingEngine(registry, {
    allowedOrigins: ["https://api.adapter.test"],
    fetchImpl: fixture.fetchImpl
  });
  assert.equal(metadata.id, API_TESTING_ADAPTER_ID);
  assert.equal(registry.has(API_TESTING_ADAPTER_ID), true);
  assert.deepEqual(registry.find({ capability: "contracts" }).map((item) => item.id), [API_TESTING_ADAPTER_ID]);
  assert.equal(fixture.calls(), 0);
});

test("rejects duplicate registration and invalid registry instances", () => {
  const registry = createQaEngineRegistry();
  registerApiTestingEngine(registry, adapterOptions());
  assert.throws(
    () => registerApiTestingEngine(registry, adapterOptions()),
    (error) => error instanceof ApiTestingAdapterError && error.code === "DUPLICATE_ENGINE"
  );
  assert.throws(
    () => registerApiTestingEngine({}, adapterOptions()),
    (error) => error instanceof ApiTestingAdapterError && error.code === "INVALID_REGISTRY"
  );
});

test("request operation delegates to the Request Engine and respects the origin allowlist", async () => {
  const fixture = fakeFetch({ healthy: true });
  const adapter = createApiTestingEngineAdapter({
    allowedOrigins: ["https://api.adapter.test"],
    fetchImpl: fixture.fetchImpl
  });
  const result = await adapter.run({
    operation: "request",
    request: { method: "GET", url: "https://api.adapter.test/health" }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { healthy: true });
  assert.equal(fixture.calls(), 1);
  await assert.rejects(
    adapter.run({ operation: "request", request: { method: "GET", url: "https://not-allowed.test/" } }),
    (error) => error.code === "ORIGIN_NOT_ALLOWED"
  );
  assert.equal(fixture.calls(), 1);
});

test("assertions operation evaluates an existing response without making requests", async () => {
  const fixture = fakeFetch();
  const adapter = createApiTestingEngineAdapter({ allowedOrigins: ["https://api.adapter.test"], fetchImpl: fixture.fetchImpl });
  const report = await adapter.run({
    operation: "assertions",
    response: response(),
    assertions: [{ type: "status", expected: 200 }, { type: "json", path: "$.ok", expected: true }]
  });
  assert.equal(report.passed, true);
  assert.equal(report.total, 2);
  assert.equal(fixture.calls(), 0);
});

test("contract operation compiles a local versioned contract and validates a response", async () => {
  const adapter = createApiTestingEngineAdapter(adapterOptions());
  const report = await adapter.run({
    operation: "contract",
    contract: {
      schema: "jb.api-contract/v1",
      contractId: "health-api",
      version: "1.0.0",
      operations: [{
        operationId: "getHealth",
        method: "GET",
        path: "/health",
        responses: {
          "200": {
            body: {
              type: "object",
              required: ["ok"],
              additionalProperties: false,
              properties: { ok: { type: "boolean" } }
            }
          }
        }
      }]
    },
    response: response(),
    validationOptions: { operationId: "getHealth" }
  });
  assert.equal(report.passed, true);
});

test("security operation delegates to passive response analysis", async () => {
  const adapter = createApiTestingEngineAdapter(adapterOptions());
  const report = await adapter.run({ operation: "security", response: response(), policy: { sensitiveResponse: true } });
  assert.ok(report.checks.length > 0);
  assert.equal(report.engineId, "jb.api-security-testing-engine");
});

test("workflow operation runs a sequential declarative workflow", async () => {
  const fixture = fakeFetch({ ok: true });
  const adapter = createApiTestingEngineAdapter({
    allowedOrigins: ["https://api.adapter.test"],
    fetchImpl: fixture.fetchImpl
  });
  const report = await adapter.run({
    operation: "workflow",
    workflow: {
      schema: "jb.api-workflow/v1",
      workflowId: "health.check",
      version: "1.0.0",
      stopOnFailure: true,
      steps: [{
        id: "health",
        request: { method: "GET", url: "https://api.adapter.test/health" },
        assertions: [{ type: "status", expected: 200 }]
      }]
    }
  });
  assert.equal(report.status, "passed");
  assert.equal(report.totalSteps, 1);
  assert.equal(fixture.calls(), 1);
});

test("regression baseline and comparison operations delegate without issuing requests", async () => {
  const adapter = createApiTestingEngineAdapter(adapterOptions());
  const baseline = await adapter.run({
    operation: "regression-baseline",
    response: response(),
    baselineOptions: { baselineId: "health-api-baseline" }
  });
  const report = await adapter.run({ operation: "regression-compare", baseline, response: response() });
  assert.equal(report.status, "passed");
});

test("rate-limit operation remains disabled by default and requires host opt-in", async () => {
  const adapter = createApiTestingEngineAdapter(adapterOptions());
  const command = {
    operation: "rate-limit",
    probe: {
      schema: "jb.api-rate-limit-test/v1",
      probeId: "health-read",
      version: "1.0.0",
      request: { method: "GET", url: "https://api.adapter.test/health" },
      samples: 2,
      intervalMs: 100,
      stopOnThrottle: true
    }
  };
  await assert.rejects(adapter.run(command), (error) => error.code === "ACTIVE_TESTING_DISABLED");
});

test("explicit rate-limit opt-in stays sequential and uses only the configured test fixture", async () => {
  const fixture = fakeFetch({ ok: true }, { "ratelimit-limit": "10", "ratelimit-remaining": "9" });
  const adapter = createApiTestingEngineAdapter({
    allowedOrigins: ["https://api.adapter.test"],
    fetchImpl: fixture.fetchImpl,
    activeRateLimitTesting: true
  });
  const report = await adapter.run({
    operation: "rate-limit",
    probe: {
      schema: "jb.api-rate-limit-test/v1",
      probeId: "health-read",
      version: "1.0.0",
      request: { method: "GET", url: "https://api.adapter.test/health" },
      samples: 2,
      intervalMs: 100,
      stopOnThrottle: true
    }
  });
  assert.equal(report.status, "completed");
  assert.equal(report.sentRequests, 2);
  assert.equal(fixture.calls(), 2);
});

test("rejects unknown operations, fields, missing inputs and accessor-backed commands", async () => {
  const adapter = createApiTestingEngineAdapter(adapterOptions());
  await assert.rejects(adapter.run({ operation: "shell" }), (e) => e.code === "UNSUPPORTED_OPERATION");
  await assert.rejects(adapter.run({ operation: "request", request: {}, unexpected: true }), (e) => e.code === "UNSUPPORTED_FIELD");
  await assert.rejects(adapter.run({ operation: "request" }), (e) => e.code === "MISSING_FIELD");
  const input = { operation: "request", request: {} };
  Object.defineProperty(input, "extra", { enumerable: true, get() { throw new Error("must not run"); } });
  await assert.rejects(adapter.run(input), (e) => e.code === "UNSUPPORTED_FIELD");
});

test("AbortSignal is accepted only by network operations and is validated before delegation", async () => {
  const adapter = createApiTestingEngineAdapter(adapterOptions());
  const controller = new AbortController();
  await assert.rejects(
    adapter.run({ operation: "assertions", response: response(), assertions: [{ type: "status", expected: 200 }] }, { signal: controller.signal }),
    (e) => e.code === "UNSUPPORTED_OPTION"
  );
  await assert.rejects(
    adapter.run({ operation: "request", request: { method: "GET", url: "https://api.adapter.test/health" } }, { signal: "not-an-abort-signal" }),
    (e) => e.code === "INVALID_SIGNAL"
  );
});
