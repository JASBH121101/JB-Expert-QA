const SAFE_COUNTER_KEY = /^[A-Za-z0-9:_-]{1,96}:[a-f0-9]{64}$/;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS jb_security_guard_rate_limits (
  counter_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count bigint NOT NULL CHECK (request_count > 0),
  last_seen_at timestamptz NOT NULL
);
`;

const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS jb_security_guard_rate_limits_last_seen_idx ON jb_security_guard_rate_limits (last_seen_at)`;

const CONSUME_SQL = `
INSERT INTO jb_security_guard_rate_limits (
  counter_key, window_started_at, request_count, last_seen_at
)
VALUES ($1, statement_timestamp(), 1, statement_timestamp())
ON CONFLICT (counter_key) DO UPDATE SET
  window_started_at = CASE
    WHEN jb_security_guard_rate_limits.window_started_at
      + ($2 * INTERVAL '1 millisecond') <= EXCLUDED.last_seen_at
    THEN EXCLUDED.last_seen_at
    ELSE jb_security_guard_rate_limits.window_started_at
  END,
  request_count = CASE
    WHEN jb_security_guard_rate_limits.window_started_at
      + ($2 * INTERVAL '1 millisecond') <= EXCLUDED.last_seen_at
    THEN 1
    ELSE jb_security_guard_rate_limits.request_count + 1
  END,
  last_seen_at = EXCLUDED.last_seen_at
RETURNING
  request_count AS count,
  GREATEST(
    0,
    CEIL(EXTRACT(EPOCH FROM (
      window_started_at + ($2 * INTERVAL '1 millisecond') - last_seen_at
    )) * 1000)
  ) AS retry_after_ms
`;

const PRUNE_SQL = `
WITH expired AS (
  SELECT counter_key
  FROM jb_security_guard_rate_limits
  WHERE last_seen_at < statement_timestamp() - ($1 * INTERVAL '1 millisecond')
  ORDER BY last_seen_at
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
DELETE FROM jb_security_guard_rate_limits AS current
USING expired
WHERE current.counter_key = expired.counter_key
RETURNING current.counter_key
`;

function assertRecord(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(name + " must be an object");
  }
}

function safeInteger(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(name + " must be an integer from " + minimum + " to " + maximum);
  }
  return value;
}

/**
 * PostgreSQL-backed atomic fixed-window store.
 *
 * The supplied query function must have the node-postgres shape:
 * query(sqlText, parameterValues) -> Promise<{ rows: Array }>.
 * Use a Pool/client query wrapper; this module does not connect to a database.
 */
export function createPostgresRateLimitStore(options = {}) {
  assertRecord(options, "options");
  for (const key of Object.keys(options)) {
    if (key !== "query") throw new TypeError("Unknown PostgreSQL rate-limit store option: " + key);
  }
  const query = options.query;
  if (typeof query !== "function") {
    throw new TypeError("query must be a parameterized PostgreSQL query function");
  }

  async function initialize() {
    await query(CREATE_TABLE_SQL, []);
    await query(CREATE_INDEX_SQL, []);
    return Object.freeze({ initialized: true });
  }

  async function consumeLimit(input) {
    assertRecord(input, "consumeLimit input");
    for (const key of Object.keys(input)) {
      if (!["key", "now", "windowMs", "maxRequests"].includes(key)) {
        throw new TypeError("Unknown consumeLimit field: " + key);
      }
    }
    if (typeof input.key !== "string" || !SAFE_COUNTER_KEY.test(input.key)) {
      throw new TypeError("key must be a namespaced HMAC counter key; raw identities are not accepted");
    }
    safeInteger(input.now, "now", 0);
    const windowMs = safeInteger(input.windowMs, "windowMs", 1, 86_400_000);
    safeInteger(input.maxRequests, "maxRequests", 1, 1_000_000);

    const result = await query(CONSUME_SQL, [input.key, windowMs]);
    if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) {
      throw new TypeError("PostgreSQL rate-limit query must return exactly one row");
    }
    const count = Number(result.rows[0].count);
    const retryAfterMs = Number(result.rows[0].retry_after_ms);
    if (!Number.isSafeInteger(count) || count < 1 ||
        !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > windowMs) {
      throw new TypeError("PostgreSQL rate-limit query returned an invalid counter row");
    }
    return Object.freeze({
      allowed: count <= input.maxRequests,
      count,
      retryAfterMs
    });
  }

  async function pruneExpired(options = {}) {
    assertRecord(options, "prune options");
    for (const key of Object.keys(options)) {
      if (!["retentionMs", "batchSize"].includes(key)) {
        throw new TypeError("Unknown prune option: " + key);
      }
    }
    const retentionMs = safeInteger(options.retentionMs ?? 172_800_000,
      "retentionMs", 86_400_000, 31_536_000_000);
    const batchSize = safeInteger(options.batchSize ?? 1000, "batchSize", 1, 10_000);
    const result = await query(PRUNE_SQL, [retentionMs, batchSize]);
    if (!result || !Array.isArray(result.rows)) {
      throw new TypeError("PostgreSQL prune query must return rows");
    }
    return Object.freeze({ deleted: result.rows.length });
  }

  return Object.freeze({ initialize, consumeLimit, pruneExpired });
}
