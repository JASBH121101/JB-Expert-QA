import test from "node:test";
import assert from "node:assert/strict";
import { createUniversalRateLimitService } from "@jb/security-guard/universal-rate-limit-service";

const CLIENT_SECRET = "jb-test-client-secret-with-more-than-32-bytes";

function createAtomicStore() {
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

function makeService(store, overrides = {}) {
  return createUniversalRateLimitService({
    store,
    clients: {
      "test-app": {
        secret: CLIENT_SECRET,
        policies: {
          general: {
            windowMs: 60_000,
            maxRequests: 2,
            scopes: ["catalog-read", "catalog-write"]
          }
        }
      }
    },
    ...overrides
  });
}

function request(service, body, options = {}) {
  const headers = new Headers({
    "content-type": "application/json",
    "x-jb-client-id": options.clientId ?? "test-app"
  });
  if (options.authorization !== null) {
    headers.set("authorization", options.authorization ?? "Bearer " + CLIENT_SECRET);
  }
  return service.fetch(new Request("https://guard.example/__jb/security-guard/v1/check", {
    method: options.method ?? "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(body)
  }));
}

test("valid server-to-server request is allowed and the raw identity is not used as a counter key", async () => {
  const store = createAtomicStore();
  const service = makeService(store);
  const response = await request(service, {
    identity: "customer-123",
    scope: "catalog-read",
    policy: "general"
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    allowed: true, policy: "general", scope: "catalog-read"
  });
  assert.equal([...store.buckets.keys()].some((key) => key.includes("customer-123")), false);
});

test("rate limit is shared across independent service instances using the same atomic store", async () => {
  const store = createAtomicStore();
  const first = makeService(store);
  const second = makeService(store);
  const payload = { identity: "account-77", scope: "catalog-read", policy: "general" };
  assert.equal((await request(first, payload)).status, 200);
  assert.equal((await request(second, payload)).status, 200);
  const blocked = await request(first, payload);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "60");
  assert.equal(blocked.headers.get("cache-control"), "no-store");
  assert.deepEqual(await blocked.json(), {
    error: "rate_limit_exceeded",
    message: "Too many requests. Try again later."
  });
});

test("client credentials are required and compared without exposing details", async () => {
  const store = createAtomicStore();
  const service = makeService(store);
  const missing = await request(service, {
    identity: "customer-1", scope: "catalog-read", policy: "general"
  }, { authorization: null });
  const wrong = await request(service, {
    identity: "customer-1", scope: "catalog-read", policy: "general"
  }, { authorization: "Bearer " + "x".repeat(CLIENT_SECRET.length) });
  const unknown = await request(service, {
    identity: "customer-1", scope: "catalog-read", policy: "general"
  }, { clientId: "unknown-app" });
  for (const response of [missing, wrong, unknown]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }
  assert.equal(store.buckets.size, 0);
});

test("unknown policies, scopes, extra body fields and malformed input are rejected", async () => {
  const service = makeService(createAtomicStore());
  assert.equal((await request(service, {
    identity: "customer-1", scope: "not-allowed", policy: "general"
  })).status, 400);
  assert.equal((await request(service, {
    identity: "customer-1", scope: "catalog-read", policy: "missing"
  })).status, 400);
  assert.equal((await request(service, {
    identity: "customer-1", scope: "catalog-read", policy: "general", extra: true
  })).status, 400);
  assert.equal((await request(service, {}, { rawBody: "{" })).status, 400);
});

test("service enforces method, content type, path and body-size boundaries", async () => {
  const service = makeService(createAtomicStore(), { maxBodyBytes: 256 });
  const payload = { identity: "customer-1", scope: "catalog-read", policy: "general" };
  assert.equal((await request(service, payload, { method: "GET" })).status, 405);
  const wrongType = await service.fetch(new Request(
    "https://guard.example/__jb/security-guard/v1/check",
    { method: "POST", headers: {
      "content-type": "text/plain", "x-jb-client-id": "test-app",
      authorization: "Bearer " + CLIENT_SECRET
    }, body: JSON.stringify(payload) }
  ));
  assert.equal(wrongType.status, 415);
  const tooLarge = await request(service, {
    identity: "x".repeat(400), scope: "catalog-read", policy: "general"
  });
  assert.equal(tooLarge.status, 413);
  const notFound = await service.fetch(new Request(
    "https://guard.example/other", { method: "POST" }
  ));
  assert.equal(notFound.status, 404);
});

test("shared-store outage fails closed with a generic 503", async () => {
  const service = makeService({
    async consumeLimit() { throw new Error("private redis hostname and credentials"); }
  });
  const response = await request(service, {
    identity: "customer-1", scope: "catalog-read", policy: "general"
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  const body = await response.text();
  assert.match(body, /security_rate_limit_unavailable/);
  assert.equal(body.includes("private redis"), false);
});

test("configuration rejects invalid clients, weak secrets, policies and scopes", () => {
  const store = createAtomicStore();
  assert.throws(() => createUniversalRateLimitService({ store }), /clients/);
  assert.throws(() => makeService(store, {
    clients: { "test-app": { secret: "weak", policies: { general: {} } } }
  }), /32-512 bytes/);
  assert.throws(() => makeService(store, {
    clients: { "test-app": { secret: CLIENT_SECRET, policies: { general: { windowMs: 0 } } } }
  }), /windowMs/);
  assert.throws(() => makeService(store, {
    clients: { "test-app": { secret: CLIENT_SECRET, policies: { general: { scopes: ["bad scope"] } } } }
  }), /Scope/);
});

test("API exposes only registered client and policy names", () => {
  const service = makeService(createAtomicStore());
  assert.deepEqual(service.getClients(), ["test-app"]);
  assert.deepEqual(service.getPolicies("test-app"), ["general"]);
  assert.deepEqual(service.getPolicies("unknown-app"), []);
});
