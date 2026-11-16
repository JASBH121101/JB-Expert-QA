import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  createCoreRateLimitCounterKey,
  deriveCoreIdentityKey,
  normalizeCoreRateLimitCheckRequest,
  normalizeCoreRateLimitDecision,
  normalizeCoreRateLimitPolicy
} from "@jb/security-guard/core-contract-v1";

const request = () => ({
  schema: "jb.security.rate-limit.check/v1",
  requestId: "b37a5d9e-40c4-4d3b-bf9c-62d79ecf9f3a",
  tenantId: "tenant-demo",
  applicationId: "catalog-api",
  policyId: "public-api",
  scope: "catalog:list",
  identity: {
    type: "anonymous",
    key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    keyId: "k2026-01"
  }
});

const decision = (overrides = {}) => ({
  schema: "jb.security.rate-limit.decision/v1",
  requestId: "b37a5d9e-40c4-4d3b-bf9c-62d79ecf9f3a",
  tenantId: "tenant-demo",
  applicationId: "catalog-api",
  policyId: "public-api",
  scope: "catalog:list",
  allowed: false,
  exceeded: true,
  enforced: true,
  unavailable: false,
  status: 429,
  retryAfterSeconds: 15,
  ...overrides
});

const policy = () => ({
  schema: "jb.security.policy.rate-limit/v1",
  id: "catalog-public",
  tenantId: "tenant-demo",
  applicationId: "catalog-api",
  version: 1,
  enabled: true,
  mode: "enforce",
  failureMode: "closed",
  limits: [
    { id: "catalog-list-ip", identityType: "ip", scope: "catalog:list", windowSeconds: 60, maxRequests: 60 },
    { id: "catalog-read-anonymous", identityType: "anonymous", scope: "catalog:read", windowSeconds: 60, maxRequests: 100 }
  ]
});

test("Core v1 HMAC identity derivation matches the language-neutral known-answer vector", async () => {
  const fixtureUrl = new URL("../packages/security-guard-core/tests/fixtures/identity-key-derivation.v1.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const secret = Uint8Array.from(fixture.secretHex.match(/../g), (part) => Number.parseInt(part, 16));
  const actual = await deriveCoreIdentityKey({
    secret,
    keyId: fixture.keyId,
    tenantId: fixture.tenantId,
    applicationId: fixture.applicationId,
    identityType: fixture.identityType,
    canonicalIdentity: fixture.canonicalIdentity,
    cryptoApi: webcrypto
  });
  assert.equal(actual, fixture.expectedKey);
});

test("Core v1 HMAC refuses short secrets and noncanonical identity values", async () => {
  const base = {
    secret: new Uint8Array(31),
    keyId: "k2026-01",
    tenantId: "tenant-demo",
    applicationId: "catalog-api",
    identityType: "account",
    canonicalIdentity: "user-123",
    cryptoApi: webcrypto
  };
  await assert.rejects(() => deriveCoreIdentityKey(base), /at least 32 bytes/);
  await assert.rejects(() => deriveCoreIdentityKey({ ...base, secret: new Uint8Array(32), canonicalIdentity: "user\0123" }), /without NUL/);
  await assert.rejects(() => deriveCoreIdentityKey({ ...base, secret: new Uint8Array(32), canonicalIdentity: "\ud800" }), /valid, stable Unicode/);
});

test("Core v1 HMAC binds identity keys to tenant, application, and identity type", async () => {
  const secret = Uint8Array.from({ length: 32 }, (_, index) => index);
  const base = {
    secret, keyId: "k2026-01", tenantId: "tenant-demo",
    applicationId: "catalog-api", identityType: "account",
    canonicalIdentity: "user-123", cryptoApi: webcrypto
  };
  const key = await deriveCoreIdentityKey(base);
  const differentTenant = await deriveCoreIdentityKey({ ...base, tenantId: "tenant-other" });
  const differentApp = await deriveCoreIdentityKey({ ...base, applicationId: "admin-api" });
  const differentType = await deriveCoreIdentityKey({ ...base, identityType: "session" });
  assert.equal(key, "c1f6faa9f5d251b0447a6e47a0310ccd54706aa4a5e239e8bcf4e3f14e26863e");
  assert.notEqual(key, differentTenant);
  assert.notEqual(key, differentApp);
  assert.notEqual(key, differentType);
});

test("Core v1 rate-limit request validates opaque identities and freezes normalized values", () => {
  const normalized = normalizeCoreRateLimitCheckRequest(request());
  assert.equal(normalized.identity.type, "anonymous");
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.identity));
});

test("Core v1 rate-limit request rejects unknown fields and raw identities", () => {
  const raw = request();
  raw.identity.rawIp = "203.0.113.8";
  assert.throws(() => normalizeCoreRateLimitCheckRequest(raw), /unsupported field/);
  assert.throws(() => normalizeCoreRateLimitCheckRequest({ ...request(), browserIdentity: "user-1" }), /unsupported field/);
});

test("Core v1 rate-limit decisions accept enforced 429 and 503 states", () => {
  assert.equal(normalizeCoreRateLimitDecision(decision()).status, 429);
  assert.equal(normalizeCoreRateLimitDecision(decision({
    allowed: false, exceeded: false, enforced: true, unavailable: true, status: 503, retryAfterSeconds: 5
  })).status, 503);
  assert.equal(normalizeCoreRateLimitDecision(decision({
    allowed: true, exceeded: true, enforced: false, unavailable: false, status: null, retryAfterSeconds: null
  })).exceeded, true);
});

test("Core v1 rate-limit decisions reject contradictory enforcement states", () => {
  assert.throws(() => normalizeCoreRateLimitDecision(decision({ unavailable: true })), /429 decision/);
  assert.throws(() => normalizeCoreRateLimitDecision(decision({ status: 503, unavailable: false })), /503 decision/);
  assert.throws(() => normalizeCoreRateLimitDecision(decision({ allowed: false, status: null })), /denied decision/);
  assert.throws(() => normalizeCoreRateLimitDecision(decision({ allowed: true, status: 429 })), /allowed decision/);
  assert.throws(() => normalizeCoreRateLimitDecision(decision({ allowed: true, unavailable: true })), /unavailable dependency/);
  assert.throws(() => normalizeCoreRateLimitDecision(decision({ allowed: true, enforced: true, exceeded: true, status: null, retryAfterSeconds: null })), /exceeded quota/);
});

test("Core v1 rate-limit policies enforce strict shapes, bounds, and unique IDs", () => {
  const normalized = normalizeCoreRateLimitPolicy(policy());
  assert.equal(normalized.limits.length, 2);
  assert.ok(Object.isFrozen(normalized.limits));
  assert.throws(() => normalizeCoreRateLimitPolicy({ ...policy(), owner: "browser" }), /unsupported field/);
  const duplicate = policy();
  duplicate.limits[1].id = duplicate.limits[0].id;
  assert.throws(() => normalizeCoreRateLimitPolicy(duplicate), /unique/);
});

test("Core v1 counter keys are length-prefixed and isolate tenant, policy, scope, and key version", () => {
  const base = {
    tenantId: "tenant-demo", applicationId: "catalog-api", policyId: "public-api",
    scope: "catalog:list", identityType: "account", keyId: "k2026-01",
    identityKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  };
  const key = createCoreRateLimitCounterKey(base);
  assert.ok(key.startsWith("15:jbsg-counter-v1"));
  assert.notEqual(key, createCoreRateLimitCounterKey({ ...base, tenantId: "tenant-other" }));
  assert.notEqual(key, createCoreRateLimitCounterKey({ ...base, policyId: "admin-api" }));
  assert.notEqual(key, createCoreRateLimitCounterKey({ ...base, scope: "catalog:read" }));
  assert.notEqual(key, createCoreRateLimitCounterKey({ ...base, keyId: "k2026-02" }));
  assert.notEqual(
    createCoreRateLimitCounterKey({ ...base, tenantId: "ab", applicationId: "c" }),
    createCoreRateLimitCounterKey({ ...base, tenantId: "a", applicationId: "bc" })
  );
});
