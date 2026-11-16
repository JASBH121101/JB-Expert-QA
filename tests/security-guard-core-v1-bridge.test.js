import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRateLimitCheckV1,
  validateRateLimitDecisionV1,
  toRateLimitDecisionV1
} from "@jb/security-guard/core-contract-v1";

const context = {
  requestId: "5f4c1f7e-0f5c-4f5c-8f6a-6f7b6e1f4c21",
  tenantId: "tenant-demo",
  applicationId: "catalog-api",
  policyId: "catalog-read",
  scope: "product-list"
};

const identity = {
  type: "account_ip",
  key: "a".repeat(64),
  keyId: "identity-key-2026-01"
};

test("Core v1 check contract accepts an opaque server-derived identity", () => {
  const value = validateRateLimitCheckV1({
    schema: "jb.security.rate-limit.check/v1",
    ...context,
    identity
  });
  assert.equal(value.identity.key, identity.key);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.identity), true);
});

test("Core v1 check contract rejects raw identifiers and unknown fields", () => {
  for (const value of [
    { schema: "jb.security.rate-limit.check/v1", ...context, identity: { ...identity, key: "192.0.2.1" } },
    { schema: "jb.security.rate-limit.check/v1", ...context, identity: { ...identity, rawIp: "192.0.2.1" } },
    { schema: "jb.security.rate-limit.check/v1", ...context, identity: { ...identity, type: "browser" } },
    { schema: "jb.security.rate-limit.check/v1", ...context, identity, rawAccountId: "user-1" },
    { schema: "jb.security.rate-limit.check/v2", ...context, identity }
  ]) {
    assert.throws(() => validateRateLimitCheckV1(value));
  }
});

test("Core v1 decision contract accepts monitor-mode exceeded decisions", () => {
  const value = validateRateLimitDecisionV1({
    schema: "jb.security.rate-limit.decision/v1",
    ...context,
    allowed: true,
    exceeded: true,
    enforced: false,
    unavailable: false,
    status: null,
    retryAfterSeconds: null
  });
  assert.equal(value.exceeded, true);
  assert.equal(value.allowed, true);
});

test("Core v1 decision contract enforces coherent 429 and 503 semantics", () => {
  const blocked = {
    schema: "jb.security.rate-limit.decision/v1",
    ...context,
    allowed: false,
    exceeded: true,
    enforced: true,
    unavailable: false,
    status: 429,
    retryAfterSeconds: 10
  };
  assert.equal(validateRateLimitDecisionV1(blocked).status, 429);
  assert.equal(validateRateLimitDecisionV1({
    ...blocked,
    exceeded: false,
    unavailable: true,
    status: 503
  }).status, 503);
  assert.throws(() => validateRateLimitDecisionV1({ ...blocked, enforced: false }));
  assert.throws(() => validateRateLimitDecisionV1({ ...blocked, status: 503 }));
  assert.throws(() => validateRateLimitDecisionV1({ ...blocked, extra: "not-allowed" }));
});

test("adapter bridge adds trusted context without changing legacy APIs", () => {
  const result = toRateLimitDecisionV1(context, {
    allowed: false,
    exceeded: true,
    enforced: true,
    unavailable: false,
    status: 429,
    retryAfterSeconds: 15
  });
  assert.deepEqual(result, {
    schema: "jb.security.rate-limit.decision/v1",
    ...context,
    allowed: false,
    exceeded: true,
    enforced: true,
    unavailable: false,
    status: 429,
    retryAfterSeconds: 15
  });
});

test("adapter bridge rejects incomplete or contradictory decisions", () => {
  assert.throws(() => toRateLimitDecisionV1(context, {
    allowed: false, exceeded: false, enforced: false, unavailable: false,
    status: 429, retryAfterSeconds: 3
  }));
  assert.throws(() => toRateLimitDecisionV1({ ...context, tenantId: "../tenant" }, {
    allowed: true, exceeded: false, enforced: false, unavailable: false,
    status: null, retryAfterSeconds: null
  }));
});
