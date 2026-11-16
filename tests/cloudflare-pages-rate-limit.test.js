import test from "node:test";
import assert from "node:assert/strict";
import { createCloudflarePagesRateLimit } from "@jb/security-guard/cloudflare-pages-rate-limit";
import {
  createCloudflareWorkerRateLimit,
  createCloudflareWorkerRateLimitService
} from "@jb/security-guard/cloudflare-worker-rate-limit";

const TEST_SECRET = "jb-security-guard-test-secret-32-bytes-minimum";

function createServiceBinding(service) {
  return { fetch(request) { return service.fetch(request); } };
}

test("Pages adapter delegates to a private Worker and returns an enforced 429", async () => {
  const keys = [];
  const limiter = createCloudflareWorkerRateLimit({
    binding: { async limit({ key }) { keys.push(key); return { success: false }; } },
    identitySecret: TEST_SECRET,
    mode: "enforce",
    periodSeconds: 10
  });
  const service = createCloudflareWorkerRateLimitService({ limiter });
  const pages = createCloudflarePagesRateLimit({
    serviceBinding: createServiceBinding(service)
  });

  const decision = await pages.check({ identity: "trusted-account-123", scope: "login" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.exceeded, true);
  assert.equal(decision.enforced, true);
  assert.equal(decision.unavailable, false);
  assert.equal(decision.response.status, 429);
  assert.equal(decision.response.headers.get("cache-control"), "no-store");
  assert.equal(decision.response.headers.get("retry-after"), "10");
  assert.equal(keys.length, 1);
  assert.equal(keys[0].length, 64);
  assert.equal(keys[0].includes("trusted-account-123"), false);
});

test("Pages adapter forwards only the normalized trusted identity, policy and scope", async () => {
  let captured;
  const pages = createCloudflarePagesRateLimit({
    serviceBinding: {
      async fetch(request) {
        captured = {
          url: request.url,
          method: request.method,
          headers: request.headers,
          body: await request.json()
        };
        return new Response(JSON.stringify({
          allowed: true, exceeded: false, enforced: false, unavailable: false,
          policy: "general", scope: "catalog-read", status: null, retryAfterSeconds: null
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
  });

  const decision = await pages.check({
    identity: " trusted-user ", scope: "catalog-read", policy: "general"
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.response, null);
  assert.equal(captured.method, "POST");
  assert.equal(new URL(captured.url).pathname, "/__jb/security-guard/rate-limit");
  assert.equal(captured.headers.get("cache-control"), "no-store");
  assert.deepEqual(captured.body, {
    identity: "trusted-user", scope: "catalog-read", policy: "general"
  });
});

test("Pages adapter fails closed with a generic 503 when its service binding is unavailable", async () => {
  const events = [];
  const pages = createCloudflarePagesRateLimit({
    serviceBinding: { async fetch() { throw new Error("private service infrastructure detail"); } },
    onEvent(event) { events.push(event); }
  });

  const decision = await pages.check({ identity: "sensitive-account", scope: "login" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.unavailable, true);
  assert.equal(decision.response.status, 503);
  assert.equal(decision.response.headers.get("cache-control"), "no-store");
  assert.equal(JSON.stringify(events).includes("sensitive-account"), false);
  assert.equal(JSON.stringify(events).includes("infrastructure detail"), false);
  assert.equal(events[0].action, "cloudflare-pages-rate-limit-unavailable");
  assert.equal(events[0].severity, "critical");
});

test("Pages adapter can explicitly fail open when the private service is unavailable", async () => {
  const pages = createCloudflarePagesRateLimit({
    serviceBinding: { async fetch() { throw new Error("offline"); } },
    failureMode: "open"
  });
  const decision = await pages.check({ identity: "trusted-user", scope: "catalog-read" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.unavailable, true);
  assert.equal(decision.response, null);
});

test("Pages adapter rejects malformed service responses using its configured failure mode", async () => {
  const pages = createCloudflarePagesRateLimit({
    serviceBinding: {
      async fetch() {
        return new Response(JSON.stringify({
          allowed: false, exceeded: true, enforced: true, unavailable: false,
          policy: null, scope: "login", status: 302, retryAfterSeconds: null
        }), { status: 200 });
      }
    }
  });
  const decision = await pages.check({ identity: "trusted-user", scope: "login" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.unavailable, true);
  assert.equal(decision.response.status, 503);
});

test("Worker service exposes only the configured POST route and rejects oversized bodies", async () => {
  const service = createCloudflareWorkerRateLimitService({
    limiter: {
      async check() {
        return {
          allowed: true, exceeded: false, enforced: false, unavailable: false,
          policy: null, scope: "request", response: null
        };
      }
    },
    path: "/internal/check",
    maxBodyBytes: 256
  });

  const wrongPath = await service.fetch(new Request("https://internal.invalid/other", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  }));
  assert.equal(wrongPath.status, 404);

  const wrongMethod = await service.fetch(new Request("https://internal.invalid/internal/check", {
    method: "GET"
  }));
  assert.equal(wrongMethod.status, 405);

  const wrongContentType = await service.fetch(new Request("https://internal.invalid/internal/check", {
    method: "POST", body: "{}"
  }));
  assert.equal(wrongContentType.status, 415);

  const tooLarge = await service.fetch(new Request("https://internal.invalid/internal/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: "x".repeat(400), scope: "login" })
  }));
  assert.equal(tooLarge.status, 413);
});

test("Worker service returns 503 for malformed internal adapter decisions", async () => {
  const service = createCloudflareWorkerRateLimitService({
    limiter: {
      async check() {
        return {
          allowed: false,
          exceeded: false,
          enforced: false,
          unavailable: false,
          policy: null,
          scope: "login",
          response: null
        };
      }
    }
  });

  const response = await service.fetch(new Request(
    "https://internal.invalid/__jb/security-guard/rate-limit",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "trusted-account", scope: "login" })
    }
  ));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "rate_limit_service_unavailable"
  });
});

test("Worker service keeps rate-limit responses compact and never returns caller identity", async () => {
  const limiter = createCloudflareWorkerRateLimit({
    binding: { async limit() { return { success: false }; } },
    identitySecret: TEST_SECRET,
    mode: "enforce"
  });
  const service = createCloudflareWorkerRateLimitService({ limiter });
  const response = await service.fetch(new Request(
    "https://internal.invalid/__jb/security-guard/rate-limit",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "private-caller-identity", scope: "catalog-write" })
    }
  ));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.allowed, false);
  assert.equal(payload.status, 429);
  assert.equal(payload.retryAfterSeconds, 60);
  assert.equal(JSON.stringify(payload).includes("private-caller-identity"), false);
});

test("Pages adapter rejects missing bindings and unsafe options", () => {
  assert.throws(() => createCloudflarePagesRateLimit({}), /Service Binding/);
  assert.throws(() => createCloudflarePagesRateLimit({
    serviceBinding: { fetch() {} }, failureMode: "sometimes"
  }), /failureMode/);
  assert.throws(() => createCloudflarePagesRateLimit({
    serviceBinding: { fetch() {} }, extra: true
  }), /Unknown Cloudflare Pages/);
  assert.throws(() => createCloudflarePagesRateLimit({
    serviceBinding: { fetch() {} }, path: "relative/path"
  }), /safe absolute service route/);
});

test("Pages adapter rejects malformed identities before calling the service", async () => {
  let calls = 0;
  const pages = createCloudflarePagesRateLimit({
    serviceBinding: {
      async fetch() {
        calls += 1;
        return new Response("{}");
      }
    }
  });
  await assert.rejects(pages.check({ identity: "", scope: "login" }), /identity/);
  await assert.rejects(pages.check({ identity: "trusted", scope: "../login" }), /scope/);
  await assert.rejects(pages.check({ identity: "trusted", policy: "invalid policy" }), /policy/);
  await assert.rejects(pages.check({ identity: "trusted", extra: true }), /Unknown rate-limit check input/);
  assert.equal(calls, 0);
});


test("Pages and Worker Service Binding exchange Core v1 HMAC contracts end to end", async () => {
  const bindingKeys = [];
  const workerEvents = [];
  const pagesEvents = [];
  const limiter = createCloudflareWorkerRateLimit({
    binding: {
      async limit({ key }) {
        bindingKeys.push(key);
        return { success: false };
      }
    },
    identitySecret: TEST_SECRET,
    mode: "enforce",
    periodSeconds: 10
  });
  const service = createCloudflareWorkerRateLimitService({
    limiter,
    onCoreEvent(event) { workerEvents.push(event); }
  });
  let serviceEnvelope;
  const pages = createCloudflarePagesRateLimit({
    serviceBinding: {
      async fetch(request) {
        serviceEnvelope = await request.clone().json();
        return service.fetch(request);
      }
    },
    core: {
      tenantId: "tenant-demo",
      applicationId: "catalog-api",
      identityType: "account",
      identityKeyId: "pages-identity-2026",
      identitySecret: TEST_SECRET,
      requestIdGenerator: () => "5f4c1f7e-0f5c-4f5c-8f6a-6f7b6e1f4c21"
    },
    onCoreEvent(event) { pagesEvents.push(event); }
  });

  const result = await pages.check({
    identity: "private-account-identifier",
    scope: "login"
  });

  assert.equal(serviceEnvelope.schema, "jb.security.rate-limit.check/v1");
  assert.equal(serviceEnvelope.tenantId, "tenant-demo");
  assert.equal(serviceEnvelope.applicationId, "catalog-api");
  assert.equal(serviceEnvelope.identity.type, "account");
  assert.equal(serviceEnvelope.identity.key.length, 64);
  assert.equal(serviceEnvelope.identity.keyId, "pages-identity-2026");
  assert.equal(JSON.stringify(serviceEnvelope).includes("private-account-identifier"), false);
  assert.equal(result.allowed, false);
  assert.equal(result.response.status, 429);
  assert.equal(result.core.check.requestId, serviceEnvelope.requestId);
  assert.equal(result.core.decision.schema, "jb.security.rate-limit.decision/v1");
  assert.equal(result.core.decision.status, 429);
  assert.equal(result.core.event.schema, "jb.security.event/v1");
  assert.equal(result.core.event.action, "blocked");
  assert.equal(workerEvents.length, 1);
  assert.equal(pagesEvents.length, 1);
  assert.equal(bindingKeys.length, 1);
  assert.equal(bindingKeys[0].length, 64);
  assert.equal(bindingKeys[0].includes("private-account-identifier"), false);
});

test("Pages Core mode builds a validated 503 contract when the private Worker is unavailable", async () => {
  const events = [];
  const pages = createCloudflarePagesRateLimit({
    serviceBinding: { async fetch() { throw new Error("private worker unavailable"); } },
    core: {
      tenantId: "tenant-demo",
      applicationId: "catalog-api",
      identityType: "account_ip",
      identityKeyId: "pages-key-2026",
      identitySecret: TEST_SECRET,
      requestIdGenerator: () => "5f4c1f7e-0f5c-4f5c-8f6a-6f7b6e1f4c21"
    },
    onCoreEvent(event) { events.push(event); }
  });

  const result = await pages.check({
    identity: "trusted-account-and-client",
    scope: "login"
  });
  assert.equal(result.allowed, false);
  assert.equal(result.response.status, 503);
  assert.equal(result.core.decision.unavailable, true);
  assert.equal(result.core.decision.status, 503);
  assert.equal(result.core.event.outcome, "unavailable");
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify({ result: result.core, events }).includes("trusted-account-and-client"), false);
});

test("Pages Core mode validates required key material and supported identity types", () => {
  assert.throws(() => createCloudflarePagesRateLimit({
    serviceBinding: { fetch() {} },
    core: {
      tenantId: "tenant-demo",
      applicationId: "catalog-api",
      identityType: "account",
      identityKeyId: "pages-key-2026"
    }
  }), /identitySecret/);
  assert.throws(() => createCloudflarePagesRateLimit({
    serviceBinding: { fetch() {} },
    core: {
      tenantId: "tenant-demo",
      applicationId: "catalog-api",
      identityType: "browser",
      identityKeyId: "pages-key-2026",
      identitySecret: TEST_SECRET
    }
  }), /identityType/);
});
