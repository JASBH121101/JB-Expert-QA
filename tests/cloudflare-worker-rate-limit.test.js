import test from "node:test";
import assert from "node:assert/strict";
import { createCloudflareWorkerRateLimit } from "@jb/security-guard/cloudflare-worker-rate-limit";

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
  await assert.rejects(limiter.check({ identity: "" }), /identity/);
  await assert.rejects(limiter.check({ identity: "opaque", scope: "../bad" }), /scope/);
  await assert.rejects(limiter.check({ identity: "opaque", policy: "missing" }), /policy/);
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

test("Worker adapter uses only Web APIs and generates route-scoped opaque keys", async () => {
  const binding = createBinding([{ success: true }, { success: true }]);
  const limiter = createCloudflareWorkerRateLimit({ binding });
  await limiter.check({ identity: "same-opaque-user", scope: "catalog-read" });
  await limiter.check({ identity: "same-opaque-user", scope: "catalog-write" });

  assert.notEqual(binding.keys[0], binding.keys[1]);
  assert.equal(binding.keys.every((key) => !key.includes("same-opaque-user")), true);
});
