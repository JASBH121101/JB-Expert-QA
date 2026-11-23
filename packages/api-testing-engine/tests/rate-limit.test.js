import test from "node:test";
import assert from "node:assert/strict";
import {
  API_RATE_LIMIT_REPORT_SCHEMA,
  API_RATE_LIMIT_TEST_SCHEMA,
  ApiRateLimitError,
  createApiRateLimitTestingEngine
} from "../src/rate-limit.js";

function probe(overrides = {}) {
  return {
    schema: API_RATE_LIMIT_TEST_SCHEMA,
    probeId: "users-read",
    version: "1.0.0",
    request: { method: "GET", url: "https://api.example.test/v1/users" },
    samples: 2,
    intervalMs: 100,
    ...overrides
  };
}

function response(status = 200, headers = {}, extra = {}) {
  return {
    status,
    headers,
    durationMs: 12,
    bytesReceived: 24,
    ...extra
  };
}

function engine(handler, options = {}) {
  let calls = 0;
  const requestEngine = {
    async request(request, requestOptions) {
      calls += 1;
      return handler(request, requestOptions, calls);
    }
  };
  return {
    subject: createApiRateLimitTestingEngine({
      requestEngine,
      activeTesting: true,
      ...options
    }),
    get calls() { return calls; }
  };
}

test("requires an existing Request Engine and an explicit active-testing switch", () => {
  assert.throws(() => createApiRateLimitTestingEngine(), /requestEngine/u);
  assert.throws(() => createApiRateLimitTestingEngine({ requestEngine: {} }), /request\(\)/u);
  const requestEngine = { request: async () => response() };
  const disabled = createApiRateLimitTestingEngine({ requestEngine });
  assert.equal(disabled.activeTesting, false);
  assert.throws(
    () => disabled.run(probe()),
    (error) => error instanceof TypeError
  );
});

test("requires active-testing opt-in before sending any request", async () => {
  let calls = 0;
  const subject = createApiRateLimitTestingEngine({
    requestEngine: { request: async () => { calls += 1; return response(); } }
  });
  await assert.rejects(
    subject.run(probe()),
    (error) => error instanceof ApiRateLimitError && error.code === "ACTIVE_TESTING_DISABLED"
  );
  assert.equal(calls, 0);
});

test("rejects unsupported schemas, fields, methods, unsafe URLs and credential query keys", async () => {
  const subject = engine(async () => response()).subject;
  assert.throws(() => subject.run({ ...probe(), schema: "other" }), /schema/u);
  assert.throws(() => subject.run({ ...probe(), shell: "no" }), /unsupported field/u);
  assert.throws(() => subject.run(probe({ request: { method: "POST", url: "https://api.example.test/" } })), /GET, HEAD and OPTIONS/u);
  assert.throws(() => subject.run(probe({ request: { method: "GET", url: "https://user:pass@api.example.test/" } })), /credentials/u);
  assert.throws(() => subject.run(probe({ request: { method: "GET", url: "https://api.example.test/?access_token=secret" } })), /Credential-like query/u);
  assert.throws(() => subject.run(probe({ request: { method: "GET", url: "https://api.example.test/#fragment" } })), /fragments/u);
});

test("enforces bounded sample counts and intervals", async () => {
  const subject = engine(async () => response()).subject;
  assert.throws(() => subject.run(probe({ samples: 1 })), /between 2 and 20/u);
  assert.throws(() => subject.run(probe({ samples: 21 })), /between 2 and 20/u);
  assert.throws(() => subject.run(probe({ intervalMs: 99 })), /between 100 and 10000/u);
  assert.throws(() => subject.run(probe({ intervalMs: 10001 })), /between 100 and 10000/u);
});

test("rejects unsafe request headers and accessors without invoking them", async () => {
  const subject = engine(async () => response()).subject;
  assert.throws(() => subject.run(probe({
    request: { method: "GET", url: "https://api.example.test/", headers: { "x-test": 42 } }
  })), /safe string values/u);
  let called = false;
  const headers = {};
  Object.defineProperty(headers, "x-test", { enumerable: true, get() { called = true; return "bad"; } });
  assert.throws(() => subject.run(probe({
    request: { method: "GET", url: "https://api.example.test/", headers }
  })), /cannot contain accessors/u);
  assert.equal(called, false);
});

test("runs small probes sequentially and reports a completed observation without leaking URL paths", async () => {
  let active = 0;
  let peak = 0;
  const fake = engine(async (request) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    assert.equal(request.method, "GET");
    return response(200, { "content-type": "application/json" });
  });
  const report = await fake.subject.run(probe({
    request: { method: "GET", url: "https://api.example.test/private/customer-123" }
  }));
  assert.equal(report.schema, API_RATE_LIMIT_REPORT_SCHEMA);
  assert.equal(report.status, "completed");
  assert.equal(report.sentRequests, 2);
  assert.equal(report.samples.length, 2);
  assert.equal(peak, 1);
  assert.equal(report.request.origin, "https://api.example.test");
  assert.equal(JSON.stringify(report).includes("customer-123"), false);
});

test("detects HTTP 429, normalizes Retry-After and stops by default", async () => {
  const fake = engine(async (_request, _options, call) => call === 1
    ? response(200, { "ratelimit-limit": "10", "ratelimit-remaining": "1" })
    : response(429, { "retry-after": "3", "ratelimit-remaining": "0" }));
  const report = await fake.subject.run(probe({ samples: 5 }));
  assert.equal(report.status, "throttled");
  assert.equal(report.throttled, true);
  assert.equal(report.sentRequests, 2);
  assert.deepEqual(report.signals, [
    "http-429",
    "rate-limit-remaining-zero",
    "retry-after-observed"
  ]);
  assert.equal(report.summary.retryAfterSeconds, 3);
  assert.equal(report.checks.find((item) => item.id === "retry-after").status, "passed");
  assert.equal(fake.calls, 2);
});

test("detects remaining-zero without treating arbitrary response headers as rate-limit evidence", async () => {
  const fake = engine(async () => response(200, {
    "x-ratelimit-limit": "50",
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": "45",
    "x-debug-token": "must-not-appear"
  }));
  const report = await fake.subject.run(probe());
  assert.equal(report.status, "throttled");
  assert.deepEqual(report.signals, ["rate-limit-remaining-zero", "rate-limit-limit-observed"]);
  assert.equal(report.summary.lastLimit, 50);
  assert.equal(report.summary.lastResetSeconds, 45);
  assert.equal(JSON.stringify(report).includes("must-not-appear"), false);
});

test("continues after a throttle only when stopOnThrottle is explicitly disabled", async () => {
  const fake = engine(async (_request, _options, call) => call === 1
    ? response(429, { "retry-after": "1" })
    : response(200));
  const report = await fake.subject.run(probe({ samples: 3, stopOnThrottle: false }));
  assert.equal(report.status, "throttled");
  assert.equal(report.sentRequests, 3);
  assert.equal(fake.calls, 3);
});

test("supports HEAD and OPTIONS as read-only probe methods", async () => {
  for (const method of ["HEAD", "OPTIONS"]) {
    const fake = engine(async (request) => {
      assert.equal(request.method, method);
      return response();
    });
    const report = await fake.subject.run(probe({
      request: { method, url: "https://api.example.test/health" }
    }));
    assert.equal(report.status, "completed");
  }
});

test("an already-aborted signal sends no requests", async () => {
  const fake = engine(async () => response());
  const controller = new AbortController();
  controller.abort();
  const report = await fake.subject.run(probe(), { signal: controller.signal });
  assert.equal(report.status, "cancelled");
  assert.equal(report.error.code, "REQUEST_ABORTED");
  assert.equal(report.sentRequests, 0);
  assert.equal(fake.calls, 0);
});

test("cancellation during the pacing interval prevents the next request", async () => {
  const fake = engine(async () => response());
  const controller = new AbortController();
  const pending = fake.subject.run(probe({ intervalMs: 1000 }), { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const report = await pending;
  assert.equal(report.status, "cancelled");
  assert.equal(report.sentRequests, 1);
  assert.equal(fake.calls, 1);
});

test("propagates AbortSignal to an in-flight request", async () => {
  const fake = engine((_request, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("cancelled"), { code: "REQUEST_ABORTED" }));
    }, { once: true });
  }));
  const controller = new AbortController();
  const pending = fake.subject.run(probe(), { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  const report = await pending;
  assert.equal(report.status, "cancelled");
  assert.equal(report.error.code, "REQUEST_ABORTED");
});

test("converts request failures to sanitized report codes and stops the sequence", async () => {
  const fake = engine(async () => {
    throw Object.assign(new Error("Bearer very-secret-token"), { code: "NETWORK_ERROR" });
  });
  const report = await fake.subject.run(probe({ samples: 4 }));
  assert.equal(report.status, "failed");
  assert.equal(report.error.code, "NETWORK_ERROR");
  assert.equal(report.sentRequests, 0);
  assert.equal(JSON.stringify(report).includes("very-secret-token"), false);
});

test("rejects response header accessors without executing them", async () => {
  const headers = {};
  let called = false;
  Object.defineProperty(headers, "retry-after", {
    enumerable: true,
    get() { called = true; return "5"; }
  });
  const fake = engine(async () => response(429, headers));
  const report = await fake.subject.run(probe());
  assert.equal(report.status, "failed");
  assert.equal(report.error.code, "INVALID_RESPONSE");
  assert.equal(called, false);
});

test("accepts an HTTP-date Retry-After and reports only its normalized duration", async () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const fake = engine(async () => response(429, { "retry-after": future }));
  const report = await fake.subject.run(probe());
  assert.equal(report.status, "throttled");
  assert.ok(report.summary.retryAfterSeconds >= 0);
  assert.ok(report.summary.retryAfterSeconds <= 5);
  assert.equal(JSON.stringify(report).includes(future), false);
});
