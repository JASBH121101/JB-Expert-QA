import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRateLimitCheckInput,
  normalizeRateLimitServiceDecision,
  createRateLimitServicePayload
} from "@jb/security-guard/rate-limit-contract";

test("shared check contract normalizes identity and default scope consistently", () => {
  const value = normalizeRateLimitCheckInput({ identity: "  account-17  " });
  assert.deepEqual(value, { identity: "account-17", scope: "request" });
  assert.equal(Object.isFrozen(value), true);
});

test("shared check contract preserves an explicit policy and scope", () => {
  const value = normalizeRateLimitCheckInput({
    identity: "opaque-account", scope: "password-reset", policy: "auth"
  });
  assert.deepEqual(value, {
    identity: "opaque-account", scope: "password-reset", policy: "auth"
  });
});

test("shared check contract rejects untrusted or malformed identifiers", () => {
  for (const input of [
    null,
    [],
    { identity: " " },
    { identity: "x".repeat(513) },
    { identity: "valid", scope: "../bad" },
    { identity: "valid", policy: "bad policy" },
    { identity: "valid", unknown: true }
  ]) {
    assert.throws(() => normalizeRateLimitCheckInput(input));
  }
});

test("canonical service contract accepts allowed monitor decisions", () => {
  const decision = normalizeRateLimitServiceDecision({
    allowed: true, exceeded: true, enforced: false, unavailable: false,
    policy: "general", scope: "catalog-read", status: null, retryAfterSeconds: null
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.exceeded, true);
  assert.equal(Object.isFrozen(decision), true);
});

test("canonical service contract validates enforced 429 and unavailable 503 decisions", () => {
  const blocked = normalizeRateLimitServiceDecision({
    allowed: false, exceeded: true, enforced: true, unavailable: false,
    policy: "auth", scope: "login", status: 429, retryAfterSeconds: 10
  });
  const unavailable = normalizeRateLimitServiceDecision({
    allowed: false, exceeded: false, enforced: true, unavailable: true,
    policy: null, scope: "request", status: 503, retryAfterSeconds: 5
  });
  assert.equal(blocked.status, 429);
  assert.equal(unavailable.status, 503);
});

test("canonical service contract rejects inconsistent decision flags and response metadata", () => {
  const base = {
    allowed: false, exceeded: true, enforced: true, unavailable: false,
    policy: "auth", scope: "login", status: 429, retryAfterSeconds: 10
  };
  assert.throws(() => normalizeRateLimitServiceDecision({ ...base, allowed: true }));
  assert.throws(() => normalizeRateLimitServiceDecision({ ...base, enforced: false }));
  assert.throws(() => normalizeRateLimitServiceDecision({ ...base, status: 503 }));
  assert.throws(() => normalizeRateLimitServiceDecision({ ...base, retryAfterSeconds: 0 }));
  assert.throws(() => normalizeRateLimitServiceDecision({ ...base, extra: true }));
});

test("service payload converter maps adapter responses to the canonical wire shape", () => {
  const payload = createRateLimitServicePayload({
    allowed: false,
    exceeded: true,
    enforced: true,
    unavailable: false,
    policy: "auth",
    scope: "login",
    response: new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
      status: 429, headers: { "retry-after": "10" }
    })
  });
  assert.deepEqual(payload, {
    allowed: false,
    exceeded: true,
    enforced: true,
    unavailable: false,
    policy: "auth",
    scope: "login",
    status: 429,
    retryAfterSeconds: 10
  });
});
