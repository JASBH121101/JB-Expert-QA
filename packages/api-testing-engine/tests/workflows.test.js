import test from "node:test";
import assert from "node:assert/strict";
import {
  API_WORKFLOW_TESTING_ENGINE_ID,
  ApiWorkflowError,
  createApiWorkflowTestingEngine
} from "../src/index.js";

function response(overrides = {}) {
  return {
    engineId: "jb.api-testing-engine",
    method: "GET",
    url: "https://api.example.test/resource",
    status: 200,
    statusText: "OK",
    ok: true,
    redirected: false,
    responseUrl: "https://api.example.test/resource",
    headers: { "content-type": "application/json" },
    bodyText: JSON.stringify({ data: { id: 7, active: true } }),
    bytesReceived: 35,
    durationMs: 2,
    json: { data: { id: 7, active: true } },
    jsonParsed: true,
    jsonParseError: null,
    ...overrides
  };
}

function workflow(steps, overrides = {}) {
  return {
    schema: "jb.api-workflow/v1",
    workflowId: "users.flow",
    version: "1.0.0",
    steps,
    ...overrides
  };
}

function createEngine(request, assertions) {
  return createApiWorkflowTestingEngine({
    requestEngine: { request },
    ...(assertions ? { assertionsEngine: assertions } : {})
  });
}

test("engine identity and a single-step workflow produce a safe passing report", async () => {
  let calls = 0;
  const engine = createEngine(async () => {
    calls += 1;
    return response();
  });
  const report = await engine.run(workflow([{
    id: "get-user",
    request: { method: "GET", url: "https://api.example.test/users/7" }
  }]));

  assert.equal(engine.engineId, API_WORKFLOW_TESTING_ENGINE_ID);
  assert.equal(report.engineId, API_WORKFLOW_TESTING_ENGINE_ID);
  assert.equal(report.workflowId, "users.flow");
  assert.equal(report.status, "passed");
  assert.equal(report.passed, true);
  assert.equal(report.totalSteps, 1);
  assert.equal(report.completedSteps, 1);
  assert.equal(report.results[0].status, "passed");
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(report).includes("bodyText"), false);
});

test("fails an unasserted non-2xx response but allows an explicitly asserted negative status", async () => {
  const engine = createEngine(async () => response({ status: 404, ok: false }));
  const defaultReport = await engine.run(workflow([{
    id: "not-found",
    request: { method: "GET", url: "https://api.example.test/missing" }
  }]));
  assert.equal(defaultReport.status, "failed");
  assert.equal(defaultReport.results[0].error.code, "HTTP_STATUS_NOT_OK");

  const expectedNegative = await engine.run(workflow([{
    id: "expected-404",
    request: { method: "GET", url: "https://api.example.test/missing" },
    assertions: [{ type: "status", expected: 404 }]
  }]));
  assert.equal(expectedNegative.status, "passed");
  assert.equal(expectedNegative.results[0].assertions.failedCount, 0);
});

test("transfers captured variables and previous response paths into later requests", async () => {
  const calls = [];
  const engine = createEngine(async (request) => {
    calls.push(request);
    if (request.url.endsWith("/login")) {
      return response({
        method: "POST",
        url: request.url,
        json: { access_token: "Bearer private-token", user: { id: "user-42" } }
      });
    }
    return response({
      method: "POST",
      url: request.url,
      json: { data: { id: "user-42", active: true } }
    });
  });

  const report = await engine.run(workflow([
    {
      id: "login",
      request: {
        method: "POST",
        url: "https://api.example.test/login",
        json: { username: "demo" }
      },
      capture: {
        auth: "$.json.access_token",
        userId: "$.json.user.id"
      }
    },
    {
      id: "profile",
      request: {
        method: "POST",
        url: "https://api.example.test/profile",
        headers: { authorization: { "$var": "auth" } },
        json: { userId: { "$ref": "login", path: "$.json.user.id" } }
      }
    }
  ]));

  assert.equal(report.status, "passed");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.authorization, "Bearer private-token");
  assert.deepEqual(calls[1].json, { userId: "user-42" });
  assert.deepEqual(report.results[0].captureNames, ["auth", "userId"]);
  assert.equal(JSON.stringify(report).includes("private-token"), false);
  assert.equal(JSON.stringify(report).includes("user-42"), false);
});

test("resolves array indexes in previous response references", async () => {
  const calls = [];
  const engine = createEngine(async (request) => {
    calls.push(request);
    return calls.length === 1
      ? response({ json: { data: { ids: ["a-1", "b-2"] } } })
      : response();
  });
  const report = await engine.run(workflow([
    {
      id: "list",
      request: { method: "GET", url: "https://api.example.test/users" }
    },
    {
      id: "detail",
      request: {
        method: "POST",
        url: "https://api.example.test/detail",
        json: { userId: { "$ref": "list", path: "$.json.data.ids[1]" } }
      }
    }
  ]));
  assert.equal(report.status, "passed");
  assert.deepEqual(calls[1].json, { userId: "b-2" });
});

test("conditions execute only when previous status and JSON value match", async () => {
  let calls = 0;
  const engine = createEngine(async () => {
    calls += 1;
    return response({ json: { data: { active: true } } });
  });
  const report = await engine.run(workflow([
    { id: "check", request: { method: "GET", url: "https://api.example.test/check" } },
    {
      id: "active-only",
      when: { stepId: "check", status: [200, 299], path: "$.json.data.active", equals: true },
      request: { method: "GET", url: "https://api.example.test/active" }
    },
    {
      id: "not-created",
      when: { stepId: "check", path: "$.json.data.missing", exists: true },
      request: { method: "GET", url: "https://api.example.test/missing" }
    }
  ]));
  assert.equal(report.status, "passed");
  assert.equal(calls, 2);
  assert.equal(report.results[1].status, "passed");
  assert.equal(report.results[2].status, "skipped");
  assert.equal(report.results[2].reason, "condition-not-met");
});

test("a condition is skipped when its dependency failed", async () => {
  const engine = createEngine(async () => {
    throw Object.assign(new Error("network down"), { code: "NETWORK_ERROR", name: "ApiTestingError" });
  });
  const report = await engine.run(workflow([
    { id: "first", request: { method: "GET", url: "https://api.example.test/first" } },
    {
      id: "second",
      when: { stepId: "first", status: 200 },
      request: { method: "GET", url: "https://api.example.test/second" }
    }
  ], { stopOnFailure: false }));
  assert.equal(report.status, "failed");
  assert.equal(report.results[0].status, "failed");
  assert.equal(report.results[1].status, "skipped");
  assert.equal(report.results[1].reason, "dependency-not-passed");
});

test("stopOnFailure skips remaining steps after an assertion failure", async () => {
  let calls = 0;
  const engine = createEngine(async () => {
    calls += 1;
    return response();
  });
  const report = await engine.run(workflow([
    {
      id: "assert-fails",
      request: { method: "GET", url: "https://api.example.test/first" },
      assertions: [{ type: "status", expected: 201 }]
    },
    {
      id: "never-runs",
      request: { method: "GET", url: "https://api.example.test/second" }
    }
  ]));
  assert.equal(report.status, "failed");
  assert.equal(report.failedSteps, 1);
  assert.equal(report.results[0].assertions.failedCount, 1);
  assert.equal(report.results[1].status, "skipped");
  assert.equal(report.results[1].reason, "stopped-after-failure");
  assert.equal(calls, 1);
});

test("stopOnFailure false continues after a step failure", async () => {
  let calls = 0;
  const engine = createEngine(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("network issue"), { code: "NETWORK_ERROR", name: "ApiTestingError" });
    return response();
  });
  const report = await engine.run(workflow([
    { id: "first", request: { method: "GET", url: "https://api.example.test/first" } },
    { id: "second", request: { method: "GET", url: "https://api.example.test/second" } }
  ], { stopOnFailure: false }));
  assert.equal(report.status, "failed");
  assert.equal(report.failedSteps, 1);
  assert.equal(report.completedSteps, 1);
  assert.equal(calls, 2);
});

test("a missing capture path fails the step and stops by default", async () => {
  let calls = 0;
  const engine = createEngine(async () => {
    calls += 1;
    return response();
  });
  const report = await engine.run(workflow([
    {
      id: "capture",
      request: { method: "GET", url: "https://api.example.test/user" },
      capture: { missing: "$.json.no_such_value" }
    },
    { id: "next", request: { method: "GET", url: "https://api.example.test/next" } }
  ]));
  assert.equal(report.status, "failed");
  assert.equal(report.results[0].error.code, "CAPTURE_NOT_FOUND");
  assert.equal(report.results[1].reason, "stopped-after-failure");
  assert.equal(calls, 1);
});

test("request errors preserve only known codes and never expose arbitrary error messages", async () => {
  const knownCodeEngine = createEngine(async () => {
    throw Object.assign(new Error("sensitive-token-should-not-appear"), {
      name: "ApiTestingError",
      code: "NETWORK_ERROR"
    });
  });
  const knownCodeReport = await knownCodeEngine.run(workflow([
    { id: "failed-known", request: { method: "GET", url: "https://api.example.test/fail" } }
  ]));
  assert.equal(knownCodeReport.status, "failed");
  assert.equal(knownCodeReport.results[0].error.code, "NETWORK_ERROR");
  assert.equal(knownCodeReport.results[0].error.message, "Request Engine rejected or failed this step.");
  assert.equal(JSON.stringify(knownCodeReport).includes("sensitive-token"), false);

  const unknownCodeEngine = createEngine(async () => {
    throw Object.assign(new Error("credential-value-must-not-leak"), {
      name: "ApiTestingError",
      code: "credential-value-must-not-leak"
    });
  });
  const unknownCodeReport = await unknownCodeEngine.run(workflow([
    { id: "failed-unknown", request: { method: "GET", url: "https://api.example.test/fail" } }
  ]));
  assert.equal(unknownCodeReport.results[0].error.code, "STEP_EXECUTION_FAILED");
  assert.equal(JSON.stringify(unknownCodeReport).includes("credential-value"), false);
});

test("an already-aborted signal cancels all steps without making a request", async () => {
  let calls = 0;
  const engine = createEngine(async () => {
    calls += 1;
    return response();
  });
  const controller = new AbortController();
  controller.abort();
  const report = await engine.run(workflow([
    { id: "one", request: { method: "GET", url: "https://api.example.test/one" } },
    { id: "two", request: { method: "GET", url: "https://api.example.test/two" } }
  ]), { signal: controller.signal });
  assert.equal(report.status, "cancelled");
  assert.equal(report.skippedSteps, 2);
  assert.equal(calls, 0);
});

test("propagates AbortSignal to an in-flight request and reports cancellation", async () => {
  const engine = createEngine((request, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "ApiTestingError", code: "REQUEST_ABORTED" }));
    }, { once: true });
  }));
  const controller = new AbortController();
  const promise = engine.run(workflow([
    { id: "waiting", request: { method: "GET", url: "https://api.example.test/wait" } },
    { id: "later", request: { method: "GET", url: "https://api.example.test/later" } }
  ]), { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  const report = await promise;
  assert.equal(report.status, "cancelled");
  assert.equal(report.results[0].error.code, "REQUEST_ABORTED");
  assert.equal(report.results[1].reason, "cancelled");
});

test("rejects forward references, unknown variables and unsafe JSON paths", () => {
  const engine = createEngine(async () => response());
  assert.throws(() => engine.compile(workflow([
    {
      id: "first",
      request: {
        method: "POST",
        url: "https://api.example.test/first",
        json: { id: { "$ref": "later", path: "$.json.id" } }
      }
    },
    { id: "later", request: { method: "GET", url: "https://api.example.test/later" } }
  ])), (error) => error instanceof ApiWorkflowError && error.code === "FORWARD_REFERENCE");

  assert.throws(() => engine.compile(workflow([{
    id: "first",
    request: {
      method: "POST",
      url: "https://api.example.test/first",
      json: { token: { "$var": "not-captured" } }
    }
  }])), (error) => error instanceof ApiWorkflowError && error.code === "UNKNOWN_VARIABLE");

  assert.throws(() => engine.compile(workflow([{
    id: "first",
    request: { method: "GET", url: "https://api.example.test/first" },
    capture: { bad: "$.json.__proto__.x" }
  }])), /forbidden property/u);
});

test("rejects unsupported request fields and simultaneous body and json definitions", () => {
  const engine = createEngine(async () => response());
  assert.throws(() => engine.compile(workflow([{
    id: "first",
    request: { method: "GET", url: "https://api.example.test/first", followRedirects: true }
  }])), /unsupported field/u);

  assert.throws(() => engine.compile(workflow([{
    id: "first",
    request: { method: "POST", url: "https://api.example.test/first", json: {}, body: "raw" }
  }])), /both json and body/u);

  assert.throws(() => engine.compile(workflow([{
    id: "first",
    request: { method: "GET", url: "https://api.example.test/first", body: "not-allowed" }
  }])), /cannot contain a body/u);
});

test("rejects unsupported methods, invalid IDs, duplicate IDs and invalid conditions", () => {
  const engine = createEngine(async () => response());
  assert.throws(() => engine.compile(workflow([{
    id: "first",
    request: { method: "TRACE", url: "https://api.example.test/first" }
  }])), /uppercase supported HTTP method/u);

  assert.throws(() => engine.compile(workflow([
    { id: "duplicate", request: { method: "GET", url: "https://api.example.test/one" } },
    { id: "duplicate", request: { method: "GET", url: "https://api.example.test/two" } }
  ])), /unique/u);

  assert.throws(() => engine.compile(workflow([
    { id: "one", request: { method: "GET", url: "https://api.example.test/one" } },
    {
      id: "two",
      when: { stepId: "one", status: [299, 200] },
      request: { method: "GET", url: "https://api.example.test/two" }
    }
  ])), /ordered status range/u);
});

test("rejects workflow accessors without invoking them", () => {
  let getterCalled = false;
  const input = workflow([{
    id: "one",
    request: { method: "GET", url: "https://api.example.test/one" }
  }]);
  Object.defineProperty(input, "title", {
    enumerable: true,
    get() { getterCalled = true; return "unsafe"; }
  });
  const engine = createEngine(async () => response());
  assert.throws(() => engine.compile(input), /getters or setters/u);
  assert.equal(getterCalled, false);
});

test("compiled workflows are reusable and do not retain variables between runs", async () => {
  let sequence = 0;
  const engine = createEngine(async () => {
    sequence += 1;
    return response({ json: { token: "token-" + sequence } });
  });
  const compiled = engine.compile(workflow([{
    id: "login",
    request: { method: "GET", url: "https://api.example.test/login" },
    capture: { token: "$.json.token" }
  }]));
  const first = await compiled.run();
  const second = await compiled.run();
  assert.equal(first.status, "passed");
  assert.equal(second.status, "passed");
  assert.equal(first.results[0].captureNames[0], "token");
  assert.equal(second.results[0].captureNames[0], "token");
  assert.equal(Object.hasOwn(compiled, "definition"), false);
});

test("does not evaluate template-like strings or execute dynamic code", async () => {
  let captured;
  const engine = createEngine(async (request) => {
    captured = request.json;
    return response();
  });
  const literal = "$" + "{process.env.SECRET}";
  const report = await engine.run(workflow([{
    id: "literal",
    request: {
      method: "POST",
      url: "https://api.example.test/literal",
      json: { value: "{{globalThis.process.exit(1)}}", other: literal }
    }
  }]));
  assert.equal(report.status, "passed");
  assert.deepEqual(captured, {
    value: "{{globalThis.process.exit(1)}}",
    other: "$" + "{process.env.SECRET}"
  });
});

test("rejects overlarge workflows and invalid options", async () => {
  const engine = createEngine(async () => response());
  const steps = Array.from({ length: 101 }, (_, index) => ({
    id: "step-" + index,
    request: { method: "GET", url: "https://api.example.test/" + index }
  }));
  assert.throws(() => engine.compile(workflow(steps)), /between 1 and 100/u);
  await assert.rejects(engine.run(workflow([
    { id: "one", request: { method: "GET", url: "https://api.example.test/one" } }
  ]), { retries: 10 }), /only support an AbortSignal/u);
});


test("failed assertion steps cannot publish captures or response references to later requests", async () => {
  const calls = [];
  const engine = createEngine(async (request) => {
    calls.push(request);
    return response({ json: { token: "untrusted-token", data: { id: 7 } } });
  });
  const report = await engine.run(workflow([
    {
      id: "failed-login",
      request: { method: "POST", url: "https://api.example.test/login" },
      capture: { auth: "$.json.token" },
      assertions: [{ type: "status", expected: 201 }]
    },
    {
      id: "dependent",
      request: {
        method: "POST",
        url: "https://api.example.test/profile",
        headers: { authorization: { "$var": "auth" } },
        json: { userId: { "$ref": "failed-login", path: "$.json.data.id" } }
      }
    }
  ], { stopOnFailure: false }));
  assert.equal(report.status, "failed");
  assert.equal(report.results[0].status, "failed");
  assert.equal(report.results[1].status, "failed");
  assert.equal(report.results[1].error.code, "VARIABLE_UNAVAILABLE");
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(report).includes("untrusted-token"), false);
});
