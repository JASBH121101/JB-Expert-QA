import test from "node:test";
import assert from "node:assert/strict";
import { createCloudflareWorkerRateLimit, createCloudflareWorkerRateLimitService } from "@jb/security-guard/cloudflare-worker-rate-limit";

const TEST_SECRET = "jb-security-guard-test-secret-32-bytes-minimum";

function createBinding(answers = [{ success: true }]) {
  const keys = [];
  let index = 0;
  return {
    keys,
    async limit(input) {
      keys.push(input.key);
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    }
  };
}

test("monitor mode records an exceeded limit without blocking", async () => {
  const events = [];
  const binding = createBinding([{ success: false }]);
  const limiter = createCloudflareWorkerRateLimit({
    binding,
    onEvent(event) { events.push(event); }
  });

  const result = await limiter.check({ identity: "opaque-user-123", scope: "catalog-read" });
  assert.equal(result.allowed, true);
  assert.equal(result.exceeded, true);
  assert.equal(result.enforced, false);
  assert.equal(result.response, null);
  assert.equal(events[0].action, "cloudflare-rate-limit-exceeded");
  assert.equal(JSON.stringify(events).includes("opaque-user-123"), false);
  assert.equal(binding.keys[0].includes("opaque-user-123"), false);
  assert.equal(binding.keys[0].length, 64);
});

test("enforce mode returns 429 with no-store and Retry-After", async () => {
  const limiter = createCloudflareWorkerRateLimit({
    binding: createBinding([{ success: false }]),
    identitySecret: TEST_SECRET,
    mode: "enforce",
    periodSeconds: 60
  });

  const result = await limiter.check({ identity: "opaque-account-1", scope: "login" });
  assert.equal(result.allowed, false);
  assert.equal(result.enforced, true);
  assert.equal(result.response.status, 429);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.response.headers.get("retry-after"), "60");
  assert.equal((await result.response.json()).error, "rate_limit_exceeded");
});

test("policy map uses independent bindings and route scopes", async () => {
  const general = createBinding([{ success: false }]);
  const auth = createBinding([{ success: false }]);
  const limiter = createCloudflareWorkerRateLimit({
    identitySecret: TEST_SECRET,
    policies: {
      general: { binding: general, mode: "monitor", periodSeconds: 60 },
      auth: { binding: auth, mode: "enforce", periodSeconds: 10 }
    }
  });

  const normal = await limiter.check({
    policy: "general", identity: "opaque-user", scope: "catalog-read"
  });
  const login = await limiter.check({
    policy: "auth", identity: "opaque-user", scope: "login"
  });

  assert.equal(normal.allowed, true);
  assert.equal(normal.response, null);
  assert.equal(login.allowed, false);
  assert.equal(login.response.status, 429);
  assert.equal(login.response.headers.get("retry-after"), "10");
  assert.notEqual(general.keys[0], auth.keys[0]);
  assert.deepEqual(limiter.getPolicies(), ["general", "auth"]);
});

test("enforce mode fails closed with 503 when the binding is unavailable", async () => {
  const events = [];
  const limiter = createCloudflareWorkerRateLimit({
    binding: createBinding([new Error("private account or infrastructure detail")]),
    identitySecret: TEST_SECRET,
    mode: "enforce",
    onEvent(event) { events.push(event); }
  });

  const result = await limiter.check({
    identity: "sensitive-user-id", scope: "dgi-document"
  });
  assert.equal(result.allowed, false);
  assert.equal(result.unavailable, true);
  assert.equal(result.response.status, 503);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.response.headers.get("retry-after"), "5");
  assert.equal(JSON.stringify(events).includes("private account"), false);
  assert.equal(JSON.stringify(events).includes("sensitive-user-id"), false);
  assert.equal(events[0].severity, "critical");
});

test("fail-open behavior must be explicitly selected for an enforce policy", async () => {
  const limiter = createCloudflareWorkerRateLimit({
    binding: createBinding([new Error("unavailable")]),
    identitySecret: TEST_SECRET,
    mode: "enforce",
    failureMode: "open"
  });

  const result = await limiter.check({ identity: "opaque-user", scope: "catalog-read" });
  assert.equal(result.allowed, true);
  assert.equal(result.unavailable, true);
  assert.equal(result.enforced, false);
  assert.equal(result.response, null);
});

test("monitor mode defaults to fail-open on binding outage", async () => {
  const limiter = createCloudflareWorkerRateLimit({
    binding: createBinding([new Error("unavailable")])
  });
  const result = await limiter.check({ identity: "opaque-user" });
  assert.equal(result.allowed, true);
  assert.equal(result.unavailable, true);
  assert.equal(result.response, null);
});

test("invalid binding results fail closed for enforce policies", async () => {
  const limiter = createCloudflareWorkerRateLimit({
    binding: createBinding([{ success: "yes" }]),
    identitySecret: TEST_SECRET,
    mode: "enforce"
  });
  const result = await limiter.check({ identity: "opaque-user" });
  assert.equal(result.allowed, false);
  assert.equal(result.unavailable, true);
  assert.equal(result.response.status, 503);
});

test("configuration rejects unknown options, unsafe scopes and missing policies", async () => {
  assert.throws(() => createCloudflareWorkerRateLimit({ binding: {} }), /Cloudflare Rate Limiting binding/);
  assert.throws(() => createCloudflareWorkerRateLimit({
    binding: createBinding(), mode: "strict"
  }), /mode/);
  assert.throws(() => createCloudflareWorkerRateLimit({
    binding: createBinding(), periodSeconds: 30
  }), /periodSeconds/);
  assert.throws(() => createCloudflareWorkerRateLimit({
    binding: createBinding(), failureMode: "sometimes"
  }), /failureMode/);
  assert.throws(() => createCloudflareWorkerRateLimit({
    binding: createBinding(), extra: true
  }), /Unknown Cloudflare/);
  assert.throws(() => createCloudflareWorkerRateLimit({
    binding: createBinding(), policies: {}
  }), /exactly one/);

  const limiter = createCloudflareWorkerRateLimit({
    policies: { general: { binding: createBinding() }, auth: { binding: createBinding() } }
  });
  await assert.rejects(limiter.check({ identity: "opaque" }), /policy/);
  await assert.rejects(limiter.check({ policy: "general", identity: "" }), /identity/);
  await assert.rejects(limiter.check({ policy: "general", identity: "opaque", scope: "../bad" }), /scope/);
  await assert.rejects(limiter.check({ policy: "missing", identity: "opaque" }), /policy/);
  await assert.rejects(limiter.check({ identity: "opaque", extra: true }), /Unknown rate-limit check input/);
});

test("telemetry callback failures cannot interrupt request handling", async () => {
  const limiter = createCloudflareWorkerRateLimit({
    binding: createBinding([{ success: false }]),
    mode: "monitor",
    onEvent() { throw new Error("telemetry failure"); }
  });

  const result = await limiter.check({ identity: "opaque-user" });
  assert.equal(result.allowed, true);
  assert.equal(result.exceeded, true);
});

test("enforce mode requires a stable keyed identity secret", () => {
  assert.throws(() => createCloudflareWorkerRateLimit({
    binding: createBinding(), mode: "enforce"
  }), /identitySecret is required/);
  assert.throws(() => createCloudflareWorkerRateLimit({
    binding: createBinding(), mode: "enforce", identitySecret: "too-short"
  }), /at least 32 bytes/);
});

test("HMAC identity keys are secret-dependent and never expose the supplied identity", async () => {
  const first = createBinding();
  const second = createBinding();
  const one = createCloudflareWorkerRateLimit({
    binding: first, identitySecret: TEST_SECRET
  });
  const two = createCloudflareWorkerRateLimit({
    binding: second, identitySecret: "another-distinct-32-byte-test-secret"
  });
  await one.check({ identity: "low-entropy-user-7", scope: "catalog-read" });
  await two.check({ identity: "low-entropy-user-7", scope: "catalog-read" });
  assert.equal(first.keys[0].length, 64);
  assert.notEqual(first.keys[0], second.keys[0]);
  assert.equal(first.keys[0].includes("low-entropy-user-7"), false);
});

test("Worker adapter uses only Web APIs and generates route-scoped opaque keys", async () => {
  const binding = createBinding([{ success: true }, { success: true }]);
  const limiter = createCloudflareWorkerRateLimit({ binding });
  await limiter.check({ identity: "same-opaque-user", scope: "catalog-read" });
  await limiter.check({ identity: "same-opaque-user", scope: "catalog-write" });

  assert.notEqual(binding.keys[0], binding.keys[1]);
  assert.equal(binding.keys.every((key) => !key.includes("same-opaque-user")), true);
});


test("Worker Service Binding validates Core v1 wire identities before counting", async () => {
  let calls = 0;
  const service = createCloudflareWorkerRateLimitService({
    limiter: {
      async check(input) {
        calls += 1;
        assert.equal(input.identity.length, 64);
        return {
          allowed: true, exceeded: false, enforced: false, unavailable: false,
          policy: "default", scope: "login", response: null
        };
      }
    }
  });

  const invalid = await service.fetch(new Request(
    "https://internal.invalid/__jb/security-guard/rate-limit",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: "jb.security.rate-limit.check/v1",
        requestId: "5f4c1f7e-0f5c-4f5c-8f6a-6f7b6e1f4c21",
        tenantId: "tenant-demo",
        applicationId: "catalog-api",
        policyId: "default",
        scope: "login",
        identity: { type: "account", key: "192.0.2.10", keyId: "key-2026" }
      })
    }
  ));
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
});

test("Worker Service Binding returns Core v1 decisions and sanitized events for valid contracts", async () => {
  const events = [];
  const limiter = createCloudflareWorkerRateLimit({
    binding: { async limit() { return { success: false }; } },
    identitySecret: TEST_SECRET,
    mode: "enforce",
    periodSeconds: 10
  });
  const service = createCloudflareWorkerRateLimitService({
    limiter,
    onCoreEvent(event) { events.push(event); }
  });
  const response = await service.fetch(new Request(
    "https://internal.invalid/__jb/security-guard/rate-limit",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: "jb.security.rate-limit.check/v1",
        requestId: "5f4c1f7e-0f5c-4f5c-8f6a-6f7b6e1f4c21",
        tenantId: "tenant-demo",
        applicationId: "catalog-api",
        policyId: "default",
        scope: "login",
        identity: {
          type: "account",
          key: "a".repeat(64),
          keyId: "pages-key-2026"
        }
      })
    }
  ));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.coreDecision.schema, "jb.security.rate-limit.decision/v1");
  assert.equal(payload.coreDecision.status, 429);
  assert.equal(payload.coreEvent.schema, "jb.security.event/v1");
  assert.equal(events.length, 1);
});
