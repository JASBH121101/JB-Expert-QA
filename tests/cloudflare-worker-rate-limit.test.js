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

test("monitor mode records an exceeded limit without blocking the request", async () => {
  const events = [];
  const binding = createBinding([{ success: false }]);
  const limiter = createCloudflareWorkerRateLimit({
    binding,
    onEvent(event) { events.push(event); }
  });
  const result = await limiter.check({ identity: "user-123", scope: "account" });
  assert.equal(result.allowed, true);
  assert.equal(result.exceeded, true);
  assert.equal(result.enforced, false);
  assert.equal(result.response, null);
  assert.equal(events[0].action, "cloudflare-rate-limit-exceeded");
  assert.equal(JSON.stringify(events).includes("user-123"), false);
  assert.equal(binding.keys[0].includes("user-123"), false);
});

test("enforce mode returns a generic 429 response with no-store and Retry-After", async () => {
  const limiter = createCloudflareWorkerRateLimit({
    binding: createBinding([{ success: false }]),
    mode: "enforce",
    periodSeconds: 60
  });
  const result = await limiter.check({ identity: "account-1", scope: "account" });
  assert.equal(result.allowed, false);
  assert.equal(result.enforced, true);
  assert.equal(result.response.status, 429);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.response.headers.get("retry-after"), "60");
  assert.equal((await result.response.json()).error, "rate_limit_exceeded");
});

test("different scopes receive different opaque counter keys", async () => {
  const binding = createBinding([{ success: true }, { success: true }]);
  const limiter = createCloudflareWorkerRateLimit({ binding });
  await limiter.check({ identity: "same-actor", scope: "client" });
  await limiter.check({ identity: "same-actor", scope: "account" });
  assert.notEqual(binding.keys[0], binding.keys[1]);
  assert.equal(binding.keys.every((key) => !key.includes("same-actor")), true);
});

test("binding outages fail open and emit sanitized telemetry", async () => {
  const events = [];
  const limiter = createCloudflareWorkerRateLimit({
    binding: createBinding([new Error("private account or infrastructure detail")]),
    mode: "enforce",
    onEvent(event) { events.push(event); }
  });
  const result = await limiter.check({ identity: "sensitive-user-id", scope: "account" });
  assert.equal(result.allowed, true);
  assert.equal(result.unavailable, true);
  assert.equal(result.response, null);
  assert.equal(events[0].action, "cloudflare-rate-limit-unavailable");
  assert.equal(JSON.stringify(events).includes("private account"), false);
  assert.equal(JSON.stringify(events).includes("sensitive-user-id"), false);
});

test("configuration and identities are validated", async () => {
  assert.throws(() => createCloudflareWorkerRateLimit({ binding: {} }), /binding.limit/);
  assert.throws(() => createCloudflareWorkerRateLimit({
    binding: createBinding(), mode: "strict"
  }), /mode/);
  assert.throws(() => createCloudflareWorkerRateLimit({
    binding: createBinding(), periodSeconds: 30
  }), /periodSeconds/);
  assert.throws(() => createCloudflareWorkerRateLimit({
    binding: createBinding(), extra: true
  }), /Unknown Cloudflare/);
  const limiter = createCloudflareWorkerRateLimit({ binding: createBinding() });
  await assert.rejects(limiter.check({ identity: "" }), /identity/);
  await assert.rejects(limiter.check({ identity: "x", scope: "../bad" }), /scope/);
});

test("telemetry callback failures cannot interrupt request handling", async () => {
  const limiter = createCloudflareWorkerRateLimit({
    binding: createBinding([{ success: false }]),
    mode: "monitor",
    onEvent() { throw new Error("telemetry failure"); }
  });
  const result = await limiter.check({ identity: "user-2", scope: "account" });
  assert.equal(result.allowed, true);
  assert.equal(result.exceeded, true);
});
