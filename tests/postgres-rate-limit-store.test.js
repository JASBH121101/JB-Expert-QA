import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresRateLimitStore } from "@jb/security-guard/postgres-rate-limit-store";
import { createCoreRateLimitCounterKey } from "@jb/security-guard/core-contract-v1";

const KEY = "jb-guard:api:" + "a".repeat(64);
const CORE_KEY = createCoreRateLimitCounterKey({
  tenantId: "tenant-demo", applicationId: "catalog-api", policyId: "public-api",
  scope: "catalog:list", identityType: "account", keyId: "k2026-01",
  identityKey: "b".repeat(64)
});

test("PostgreSQL rate-limit store initializes an indexed table without connecting on construction", async () => {
  const calls = [];
  const store = createPostgresRateLimitStore({
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [] };
    }
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(await store.initialize(), { initialized: true });
  assert.match(calls[0].sql, /CREATE TABLE IF NOT EXISTS jb_security_guard_rate_limits/);
  assert.match(calls[0].sql, /PRIMARY KEY/);
  assert.match(calls[0].sql, /last_seen_at/);
  assert.match(calls[1].sql, /CREATE INDEX IF NOT EXISTS/);
});

test("PostgreSQL consume uses a parameterized atomic UPSERT and database clock", async () => {
  let called;
  const store = createPostgresRateLimitStore({
    async query(sql, parameters) {
      called = { sql, parameters };
      return { rows: [{ count: "3", retry_after_ms: "42000" }] };
    }
  });
  const result = await store.consumeLimit({
    key: KEY, now: 100_000, windowMs: 60_000, maxRequests: 2
  });
  assert.deepEqual(called.parameters, [KEY, 60_000]);
  assert.match(called.sql, /ON CONFLICT \(counter_key\) DO UPDATE/);
  assert.match(called.sql, /statement_timestamp\(\)/);
  assert.match(called.sql, /request_count = CASE/);
  assert.equal(result.allowed, false);
  assert.equal(result.count, 3);
  assert.equal(result.retryAfterMs, 42_000);
  assert.ok(Object.isFrozen(result));
});

test("PostgreSQL store accepts generated Core v1 length-prefixed counter keys", async () => {
  let received;
  const store = createPostgresRateLimitStore({
    async query(sql, parameters) {
      received = { sql, parameters };
      return { rows: [{ count: "1", retry_after_ms: "1000" }] };
    }
  });
  const result = await store.consumeLimit({
    key: CORE_KEY, now: 1000, windowMs: 60_000, maxRequests: 10
  });
  assert.equal(result.allowed, true);
  assert.equal(received.parameters[0], CORE_KEY);
  assert.match(received.sql, /ON CONFLICT \(counter_key\) DO UPDATE/);
});

test("PostgreSQL store refuses raw identifiers and malformed counter requests", async () => {
  const store = createPostgresRateLimitStore({ async query() { return { rows: [{ count: 1, retry_after_ms: 1 }] }; } });
  await assert.rejects(() => store.consumeLimit({
    key: "customer-123", now: 1, windowMs: 1000, maxRequests: 10
  }), /HMAC counter key/);
  await assert.rejects(() => store.consumeLimit({
    key: KEY, now: 1, windowMs: 0, maxRequests: 10
  }), /windowMs/);
  await assert.rejects(() => store.consumeLimit({
    key: KEY, now: 1, windowMs: 1000, maxRequests: 0
  }), /maxRequests/);
});

test("PostgreSQL store validates returned counter rows and bounds retention cleanup", async () => {
  const queries = [];
  const store = createPostgresRateLimitStore({
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      if (sql.includes("DELETE FROM")) return { rows: [{ counter_key: KEY }] };
      return { rows: [{ count: "not-a-number", retry_after_ms: "500" }] };
    }
  });
  await assert.rejects(() => store.consumeLimit({
    key: KEY, now: 1, windowMs: 1000, maxRequests: 10
  }), /invalid counter row/);
  await assert.rejects(() => store.pruneExpired({ retentionMs: 60_000 }), /retentionMs/);
  assert.deepEqual(await store.pruneExpired({ retentionMs: 172_800_000, batchSize: 10 }), { deleted: 1 });
  assert.deepEqual(queries[1].parameters, [172_800_000, 10]);
  assert.match(queries[1].sql, /FOR UPDATE SKIP LOCKED/);
});

test("PostgreSQL store requires a parameterized query adapter", () => {
  assert.throws(() => createPostgresRateLimitStore(), /query must be/);
  assert.throws(() => createPostgresRateLimitStore({ query() {}, extra: true }), /Unknown PostgreSQL/);
});
