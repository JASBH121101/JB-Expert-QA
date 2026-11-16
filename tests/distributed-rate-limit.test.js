import test from "node:test";
import assert from "node:assert/strict";
import { createDistributedRateLimit } from "@jb/security-guard";

const SECRET = "distributed-rate-limit-test-secret-at-least-32-bytes";

function createAtomicMemoryStore() {
  const buckets = new Map();
  return {
    buckets,
    async consumeLimit({ key, now, windowMs, maxRequests }) {
      let bucket = buckets.get(key);
      if (!bucket || now - bucket.startedAt >= windowMs) {
        bucket = { startedAt: now, count: 0 };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return {
        allowed: bucket.count <= maxRequests,
        count: bucket.count,
        retryAfterMs: Math.max(0, windowMs - (now - bucket.startedAt))
      };
    }
  };
}

function responseStub() {
  const headers = new Map();
  return {
    headers, statusCode: 200, headersSent: false, writableEnded: false,
    setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); },
    end(body) { this.body = body; this.writableEnded = true; },
    destroy() { this.destroyed = true; }
  };
}

async function invoke(middleware, request = {}) {
  const response = responseStub();
  let continued = 0;
  await middleware(request, response, () => { continued += 1; });
  return { response, continued };
}

test("shared atomic counter is enforced across independent middleware instances", async () => {
  const store = createAtomicMemoryStore();
  const options = { store, secret: SECRET, maxRequests: 3, keyGenerator: () => "client-a" };
  const workers = [createDistributedRateLimit(options), createDistributedRateLimit(options)];
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    invoke(workers[i % 2].middleware)
  ));
  assert.equal(results.filter((item) => item.continued === 1).length, 3);
  assert.equal(results.filter((item) => item.response.statusCode === 429).length, 7);
  assert.equal(workers[0].getStats().requests + workers[1].getStats().requests, 10);
});

test("limit response includes Retry-After and no-store", async () => {
  const limiter = createDistributedRateLimit({
    store: createAtomicMemoryStore(), secret: SECRET, maxRequests: 1,
    keyGenerator: () => "client-b", clock: () => 10_000
  });
  await invoke(limiter.middleware);
  const blocked = await invoke(limiter.middleware);
  assert.equal(blocked.response.statusCode, 429);
  assert.equal(blocked.response.headers.get("retry-after"), "60");
  assert.equal(blocked.response.headers.get("cache-control"), "no-store");
  assert.equal(blocked.continued, 0);
  assert.match(blocked.response.body, /rate_limit_exceeded/);
});

test("store outage fails closed by default without exposing backend errors", async () => {
  const events = [];
  const limiter = createDistributedRateLimit({
    store: { async consumeLimit() { throw new Error("private backend detail"); } },
    secret: SECRET, onEvent(event) { events.push(event); }
  });
  const result = await invoke(limiter.middleware);
  assert.equal(result.response.statusCode, 503);
  assert.equal(result.continued, 0);
  assert.equal(result.response.headers.get("retry-after"), "5");
  assert.equal(JSON.stringify(events).includes("private backend detail"), false);
  assert.equal(events[0].severity, "critical");
  assert.equal(limiter.getStats().storeErrors, 1);
});

test("fail-open is available only as an explicit configuration", async () => {
  const limiter = createDistributedRateLimit({
    store: { async consumeLimit() { throw new Error("unavailable"); } },
    secret: SECRET, failClosed: false
  });
  const result = await invoke(limiter.middleware);
  assert.equal(result.continued, 1);
  assert.equal(result.response.writableEnded, false);
});

test("events and store keys never contain raw client identifiers", async () => {
  const store = createAtomicMemoryStore();
  const events = [];
  const limiter = createDistributedRateLimit({
    store, secret: SECRET, maxRequests: 1,
    keyGenerator: () => "203.0.113.77", onEvent(event) { events.push(event); }
  });
  await invoke(limiter.middleware);
  await invoke(limiter.middleware);
  assert.equal([...store.buckets.keys()][0].includes("203.0.113.77"), false);
  assert.equal(JSON.stringify(events).includes("203.0.113.77"), false);
  assert.equal(events.length, 1);
});

test("configuration rejects weak or missing secrets, missing stores and unknown options", () => {
  assert.throws(() => createDistributedRateLimit({ store: createAtomicMemoryStore() }), /at least 32 bytes/);
  assert.throws(() => createDistributedRateLimit({ store: {} }), /consumeLimit/);
  assert.throws(() => createDistributedRateLimit({
    store: createAtomicMemoryStore(), secret: "weak"
  }), /at least 32 bytes/);
  assert.throws(() => createDistributedRateLimit({
    store: createAtomicMemoryStore(), secret: SECRET, unexpected: true
  }), /Unknown distributed rate-limit option/);
});

test("invalid store results fail closed", async () => {
  const limiter = createDistributedRateLimit({
    store: { async consumeLimit() { return { allowed: "yes" }; } },
    secret: SECRET
  });
  const result = await invoke(limiter.middleware);
  assert.equal(result.response.statusCode, 503);
  assert.equal(result.continued, 0);
});


test("invalid injected clock fails closed with 503 instead of rejecting middleware", async () => {
  const limiter = createDistributedRateLimit({
    store: createAtomicMemoryStore(),
    secret: SECRET,
    clock: () => Number.NaN
  });
  const result = await invoke(limiter.middleware);
  assert.equal(result.response.statusCode, 503);
  assert.equal(result.continued, 0);
  assert.equal(limiter.getStats().storeErrors, 1);
});

test("a stalled distributed store fails closed after the configured timeout", async () => {
  const limiter = createDistributedRateLimit({
    store: { consumeLimit() { return new Promise(() => {}); } },
    secret: SECRET,
    storeTimeoutMs: 5
  });
  const started = Date.now();
  const result = await invoke(limiter.middleware);
  assert.equal(result.response.statusCode, 503);
  assert.equal(result.continued, 0);
  assert.equal(limiter.getStats().storeErrors, 1);
  assert.ok(Date.now() - started < 1000);
});

test("store timeout configuration is validated", () => {
  assert.throws(() => createDistributedRateLimit({
    store: createAtomicMemoryStore(), secret: SECRET, storeTimeoutMs: 0
  }), /storeTimeoutMs/);
  assert.throws(() => createDistributedRateLimit({
    store: createAtomicMemoryStore(), secret: SECRET, storeTimeoutMs: 60001
  }), /storeTimeoutMs/);
});


test("Node distributed limiter emits validated Core v1 request and decision contracts", async () => {
  const decisions = [];
  const events = [];
  const limiter = createDistributedRateLimit({
    store: createAtomicMemoryStore(),
    secret: SECRET,
    maxRequests: 1,
    keyGenerator: (request) => request.account,
    coreContract: {
      tenantId: "tenant-demo",
      applicationId: "catalog-api",
      policyId: "login-attempts",
      scope: "login",
      identityType: "account",
      identityKeyId: "identity-key-2026"
    },
    onCoreDecision(value) { decisions.push(value); },
    onCoreEvent(value) { events.push(value); }
  });

  const first = await invoke(limiter.middleware, { account: "private-user@example.test" });
  const second = await invoke(limiter.middleware, { account: "private-user@example.test" });

  assert.equal(first.continued, 1);
  assert.equal(second.response.statusCode, 429);
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].check.schema, "jb.security.rate-limit.check/v1");
  assert.equal(decisions[0].check.identity.type, "account");
  assert.equal(decisions[0].check.identity.key.length, 64);
  assert.equal(decisions[0].check.identity.keyId, "identity-key-2026");
  assert.equal(decisions[0].decision.allowed, true);
  assert.equal(decisions[1].decision.status, 429);
  assert.equal(decisions[1].decision.enforced, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].schema, "jb.security.event/v1");
  assert.equal(events[0].category, "rate_limit");
  assert.equal(events[0].action, "blocked");
  assert.equal(events[0].subjectKey, decisions[1].check.identity.key);
  assert.equal(JSON.stringify({ decisions, events }).includes("private-user@example.test"), false);
});

test("Node distributed limiter emits a Core v1 unavailable decision on store outage", async () => {
  const decisions = [];
  const events = [];
  const limiter = createDistributedRateLimit({
    store: { async consumeLimit() { throw new Error("private store failure"); } },
    secret: SECRET,
    keyGenerator: () => "sensitive-account",
    coreContract: {
      tenantId: "tenant-demo",
      applicationId: "catalog-api",
      policyId: "api-requests",
      identityType: "account",
      identityKeyId: "identity-key-2026"
    },
    onCoreDecision(value) { decisions.push(value); },
    onCoreEvent(value) { events.push(value); }
  });

  const result = await invoke(limiter.middleware);
  assert.equal(result.response.statusCode, 503);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision.unavailable, true);
  assert.equal(decisions[0].decision.status, 503);
  assert.equal(events[0].outcome, "unavailable");
  assert.equal(JSON.stringify({ decisions, events }).includes("sensitive-account"), false);
});

test("Node distributed Core v1 configuration rejects unsupported retry windows and identity types", () => {
  assert.throws(() => createDistributedRateLimit({
    store: createAtomicMemoryStore(),
    secret: SECRET,
    windowMs: 120_000,
    coreContract: {
      tenantId: "tenant-demo", applicationId: "catalog-api", policyId: "api-requests",
      identityType: "ip", identityKeyId: "key-2026"
    }
  }), /windowMs must be 60000 or less/);
  assert.throws(() => createDistributedRateLimit({
    store: createAtomicMemoryStore(),
    secret: SECRET,
    coreContract: {
      tenantId: "tenant-demo", applicationId: "catalog-api", policyId: "api-requests",
      identityType: "browser", identityKeyId: "key-2026"
    }
  }), /identityType/);
});
