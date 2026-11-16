import test from "node:test";
import assert from "node:assert/strict";
import { createSecurityGuard, createDistributedAuthProtection } from "@jb/security-guard";

const SECRET = "security-guard-auth-core-test-secret-at-least-32-bytes";
const CORE = {
  tenantId: "tenant-demo",
  applicationId: "catalog-api",
  accountKeyId: "account-hmac-2026-01",
  clientKeyId: "client-hmac-2026-01"
};
const request = (account = "private-user@example.test", ip = "192.0.2.88") => ({
  account,
  socket: { remoteAddress: ip }
});

function responseStub() {
  const headers = new Map();
  return {
    headers,
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); },
    end(body) { this.body = body; this.writableEnded = true; },
    destroy() { this.destroyed = true; }
  };
}

async function invoke(middleware, req) {
  const response = responseStub();
  let nextCount = 0;
  await middleware(req, response, () => { nextCount += 1; });
  return { response, nextCount };
}

function atomicStore() {
  const records = new Map();
  return {
    records,
    async recordFailure({ key, scope, now, windowMs, resetAfterMs, maxFailures, lockoutMs, maxLockoutMs }) {
      let entry = records.get(key);
      if (!entry || now - entry.lastFailureAt >= resetAfterMs) {
        entry = { scope, windowStartedAt: now, lastFailureAt: now, failures: 0, lockouts: 0, blockedUntil: 0 };
        records.set(key, entry);
      }
      if (entry.blockedUntil > now) {
        return { blocked: true, retryAfterMs: entry.blockedUntil - now, triggered: false };
      }
      if (now - entry.windowStartedAt >= windowMs) {
        entry.windowStartedAt = now;
        entry.failures = 0;
      }
      entry.lastFailureAt = now;
      entry.failures += 1;
      let triggered = false;
      if (entry.failures >= maxFailures) {
        entry.lockouts += 1;
        const duration = Math.min(lockoutMs * (2 ** Math.min(entry.lockouts - 1, 10)), maxLockoutMs);
        entry.blockedUntil = now + duration;
        entry.windowStartedAt = now;
        entry.failures = 0;
        triggered = true;
      }
      return {
        blocked: entry.blockedUntil > now,
        retryAfterMs: Math.max(0, entry.blockedUntil - now),
        triggered
      };
    },
    async getStatus({ keys, now, resetAfterMs }) {
      const active = [];
      for (const { scope, key } of keys) {
        const entry = records.get(key);
        if (entry && now - entry.lastFailureAt < resetAfterMs && entry.blockedUntil > now) {
          active.push({ scope, retryAfterMs: entry.blockedUntil - now });
        }
      }
      return {
        blocked: active.length > 0,
        retryAfterMs: Math.max(0, ...active.map((item) => item.retryAfterMs)),
        scopes: active.map((item) => item.scope)
      };
    },
    async clearFailures({ keys }) {
      for (const { key } of keys) records.delete(key);
    }
  };
}

const fastPolicies = {
  ip: { maxFailures: 100, lockoutMs: 1000, maxLockoutMs: 8000 },
  accountIp: { maxFailures: 1, lockoutMs: 1000, maxLockoutMs: 8000 },
  account: { maxFailures: 100, lockoutMs: 1000, maxLockoutMs: 8000 }
};

test("local auth protection emits Core v1 failure, deny decision and sanitized lockout event", () => {
  const attempts = [];
  const decisions = [];
  const events = [];
  const guard = createSecurityGuard({ mode: "balanced", rateLimit: { enabled: false } });
  const auth = guard.createAuthProtection({
    identityKeyGenerator: (req) => req.account,
    clientKeyGenerator: (req) => req.socket.remoteAddress,
    keySecret: SECRET,
    coreContract: CORE,
    policies: fastPolicies,
    onCoreAttempt: (attempt) => attempts.push(attempt),
    onCoreDecision: (value) => decisions.push(value),
    onCoreEvent: (event) => events.push(event)
  });

  const result = auth.recordFailure(request());
  assert.equal(result.throttled, true);
  assert.equal(result.enforced, true);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].schema, "jb.security.authentication.attempt/v1");
  assert.equal(attempts[0].operation, "login");
  assert.equal(attempts[0].outcome, "failure");
  assert.equal(attempts[0].account.key.length, 64);
  assert.equal(attempts[0].client.key.length, 64);
  assert.equal(attempts[0].account.keyId, CORE.accountKeyId);
  assert.equal(decisions[0].decision.outcome, "deny");
  assert.equal(decisions[0].decision.status, 429);
  assert.equal(events.length, 1);
  assert.equal(events[0].schema, "jb.security.event/v1");
  assert.equal(events[0].category, "authentication");
  assert.equal(events[0].action, "blocked");
  assert.equal(events[0].correlationId, attempts[0].attemptId);
  assert.equal(JSON.stringify({ attempts, decisions, events }).includes("private-user@example.test"), false);
  assert.equal(JSON.stringify({ attempts, decisions, events }).includes("192.0.2.88"), false);
});

test("local auth monitor mode records a monitor decision but never reports a denied login", () => {
  const decisions = [];
  const events = [];
  const guard = createSecurityGuard({ mode: "monitor", rateLimit: { enabled: false } });
  const auth = guard.createAuthProtection({
    identityKeyGenerator: (req) => req.account,
    clientKeyGenerator: (req) => req.socket.remoteAddress,
    keySecret: SECRET,
    coreContract: CORE,
    policies: fastPolicies,
    onCoreDecision: (value) => decisions.push(value),
    onCoreEvent: (event) => events.push(event)
  });

  const result = auth.recordFailure(request());
  assert.equal(result.throttled, true);
  assert.equal(result.enforced, false);
  assert.equal(decisions[0].decision.outcome, "monitor");
  assert.equal(decisions[0].decision.status, null);
  assert.equal(events[0].action, "observed");
  assert.equal(events[0].outcome, "observed");
});

test("local successful authentication emits a success attempt and allow decision", () => {
  const attempts = [];
  const decisions = [];
  const guard = createSecurityGuard({ mode: "balanced", rateLimit: { enabled: false } });
  const auth = guard.createAuthProtection({
    identityKeyGenerator: (req) => req.account,
    clientKeyGenerator: (req) => req.socket.remoteAddress,
    keySecret: SECRET,
    coreContract: { ...CORE, operation: "session_refresh" },
    onCoreAttempt: (attempt) => attempts.push(attempt),
    onCoreDecision: (value) => decisions.push(value)
  });

  auth.recordSuccess(request());
  assert.equal(attempts[0].operation, "session_refresh");
  assert.equal(attempts[0].outcome, "success");
  assert.equal(decisions[0].decision.outcome, "allow");
  assert.equal(decisions[0].decision.status, null);
});

test("local Core v1 mode requires a stable secret and valid key identifiers", () => {
  const guard = createSecurityGuard({ mode: "balanced", rateLimit: { enabled: false } });
  const base = { identityKeyGenerator: (req) => req.account };
  assert.throws(() => guard.createAuthProtection({
    ...base, coreContract: CORE
  }), /stable explicit keySecret/);
  assert.throws(() => guard.createAuthProtection({
    ...base, keySecret: "abcdefghijklmnopqrst", coreContract: CORE
  }), /at least 32 bytes/);
  assert.throws(() => guard.createAuthProtection({
    ...base, keySecret: SECRET,
    coreContract: { ...CORE, accountKeyId: "contains space" }
  }), /accountKeyId/);
});

test("distributed auth protection emits Core v1 decisions across a shared store", async () => {
  const attempts = [];
  const decisions = [];
  const events = [];
  const guard = createDistributedAuthProtection({
    store: atomicStore(),
    secret: SECRET,
    identityKeyGenerator: (req) => req.account,
    clientKeyGenerator: (req) => req.socket.remoteAddress,
    mode: "balanced",
    policies: fastPolicies,
    coreContract: CORE,
    onCoreAttempt: (attempt) => attempts.push(attempt),
    onCoreDecision: (value) => decisions.push(value),
    onCoreEvent: (event) => events.push(event)
  });

  const result = await guard.recordFailure(request());
  assert.equal(result.throttled, true);
  assert.equal(result.enforced, true);
  assert.equal(attempts[0].outcome, "failure");
  assert.equal(decisions[0].decision.outcome, "deny");
  assert.equal(events[0].action, "blocked");
  assert.equal(JSON.stringify({ attempts, decisions, events }).includes("private-user@example.test"), false);
  assert.equal(JSON.stringify({ attempts, decisions, events }).includes("192.0.2.88"), false);

  await guard.recordSuccess(request());
  assert.equal(attempts[1].outcome, "success");
  assert.equal(decisions[1].decision.outcome, "allow");
});

test("distributed auth middleware emits an unavailable Core decision when the shared store fails", async () => {
  const attempts = [];
  const decisions = [];
  const events = [];
  const guard = createDistributedAuthProtection({
    store: {
      async recordFailure() { throw new Error("private store detail"); },
      async getStatus() { throw new Error("private store detail"); },
      async clearFailures() {}
    },
    secret: SECRET,
    identityKeyGenerator: (req) => req.account,
    mode: "balanced",
    coreContract: CORE,
    onCoreAttempt: (attempt) => attempts.push(attempt),
    onCoreDecision: (value) => decisions.push(value),
    onCoreEvent: (event) => events.push(event)
  });

  const result = await invoke(guard.middleware, request());
  assert.equal(result.response.statusCode, 503);
  assert.equal(result.nextCount, 0);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, "failure");
  assert.equal(decisions[0].decision.outcome, "unavailable");
  assert.equal(decisions[0].decision.status, 503);
  assert.equal(events[0].outcome, "unavailable");
  assert.equal(JSON.stringify({ attempts, decisions, events }).includes("private store detail"), false);
});

test("distributed auth middleware reports existing lockouts with a deny decision without flooding events", async () => {
  const attempts = [];
  const decisions = [];
  const events = [];
  const store = atomicStore();
  const guard = createDistributedAuthProtection({
    store,
    secret: SECRET,
    identityKeyGenerator: (req) => req.account,
    clientKeyGenerator: (req) => req.socket.remoteAddress,
    mode: "balanced",
    policies: fastPolicies,
    coreContract: CORE,
    onCoreAttempt: (attempt) => attempts.push(attempt),
    onCoreDecision: (value) => decisions.push(value),
    onCoreEvent: (event) => events.push(event)
  });

  await guard.recordFailure(request());
  const result = await invoke(guard.middleware, request());
  assert.equal(result.response.statusCode, 429);
  assert.equal(result.nextCount, 0);
  assert.equal(attempts.length, 2);
  assert.equal(decisions[1].decision.outcome, "deny");
  assert.equal(events.length, 1, "the lockout event is emitted once at threshold");
});

test("recovery abuse controls remain generic and independently rate limited", async () => {
  const { createAccountRecovery } = await import("@jb/security-guard");
  let deliveries = 0;
  const recovery = createAccountRecovery({
    secret: SECRET,
    requestPolicies: {
      ip: { maxRequests: 1, windowMs: 60_000 },
      account: { maxRequests: 100, windowMs: 60_000 },
      destination: { maxRequests: 100, windowMs: 60_000 }
    },
    smsProvider: { async send() { deliveries += 1; } }
  });
  const input = {
    accountId: "recovery-account",
    channel: "sms",
    destination: "+50588887777",
    contactVerified: true,
    request: request()
  };
  const first = await recovery.requestRecovery(input);
  const repeated = await recovery.requestRecovery(input);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([first.accepted, repeated.accepted], [true, true]);
  assert.equal(deliveries, 1);
});
