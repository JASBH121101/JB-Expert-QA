import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { createPostgresRateLimitStore } from "@jb/security-guard/postgres-rate-limit-store";

const connectionString = process.env.QA_DATABASE_URL;
if (!connectionString) throw new Error("QA_DATABASE_URL is required for the isolated PostgreSQL integration test");

const pool = new Pool({ connectionString, max: 20 });
const store = createPostgresRateLimitStore({
  query: (sql, values) => pool.query(sql, values)
});
const namespace = "guard-ci-" + randomBytes(8).toString("hex");
const concurrentKey = namespace + ":" + randomBytes(32).toString("hex");
const expiryKey = namespace + ":" + randomBytes(32).toString("hex");

try {
  await store.initialize();

  const concurrent = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    store.consumeLimit({
      key: concurrentKey,
      now: 1_000_000 + index,
      windowMs: 60_000,
      maxRequests: 17
    })
  ));
  assert.equal(concurrent.filter((item) => item.allowed).length, 17);
  assert.equal(concurrent.filter((item) => !item.allowed).length, 83);
  assert.equal(Math.max(...concurrent.map((item) => item.count)), 100);
  assert.ok(concurrent.every((item) => item.retryAfterMs >= 0 && item.retryAfterMs <= 60_000));

  const firstWindow = await store.consumeLimit({
    key: expiryKey, now: 10, windowMs: 1000, maxRequests: 1
  });
  const blocked = await store.consumeLimit({
    key: expiryKey, now: 11, windowMs: 1000, maxRequests: 1
  });
  assert.equal(firstWindow.allowed, true);
  assert.equal(blocked.allowed, false);
  await new Promise((resolve) => setTimeout(resolve, 1150));
  const afterRollover = await store.consumeLimit({
    key: expiryKey, now: 12, windowMs: 1000, maxRequests: 1
  });
  assert.equal(afterRollover.allowed, true);
  assert.equal(afterRollover.count, 1);

  console.log("PASS: PostgreSQL atomic upsert enforced concurrent quota and database-clock window rollover.");
} finally {
  await pool.query(
    "DELETE FROM jb_security_guard_rate_limits WHERE counter_key = ANY($1::text[])",
    [[concurrentKey, expiryKey]]
  ).catch(() => {});
  await pool.end();
}
