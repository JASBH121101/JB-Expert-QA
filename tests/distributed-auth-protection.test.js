import test from "node:test";
import assert from "node:assert/strict";
import { createDistributedAuthProtection } from "@jb/security-guard";

const SECRET = "distributed-auth-test-secret-at-least-32-bytes";

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
      if (entry.blockedUntil > now) return { blocked: true, retryAfterMs: entry.blockedUntil - now, triggered: false };
      if (now - entry.windowStartedAt >= windowMs) { entry.windowStartedAt = now; entry.failures = 0; }
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
      return { blocked: entry.blockedUntil > now, retryAfterMs: Math.max(0, entry.blockedUntil - now), triggered };
    },
    async getStatus({ keys, now, resetAfterMs }) {
      const active = [];
      for (const { scope, key } of keys) {
        const entry = records.get(key);
        if (entry && now - entry.lastFailureAt < resetAfterMs && entry.blockedUntil > now) {
          active.push({ scope, retryAfterMs: entry.blockedUntil - now });
        }
      }
      return { blocked: active.length > 0, retryAfterMs: Math.max(0, ...active.map(x => x.retryAfterMs)), scopes: active.map(x => x.scope) };
    },
    async clearFailures({ keys }) { for (const { key } of keys) records.delete(key); }
  };
}

function responseStub() {
  const headers = new Map();
  return { headers, statusCode: 200, headersSent: false, writableEnded: false,
    setHeader(k,v) { headers.set(k.toLowerCase(), String(v)); },
    end(body) { this.body = body; this.writableEnded = true; },
    destroy() { this.destroyed = true; } };
}
async function invoke(middleware, request) {
  const response = responseStub(); let nextCount = 0;
  await middleware(request, response, () => { nextCount += 1; });
  return { response, nextCount };
}
const req = (account="owner@example.test", ip="192.0.2.8") => ({ account, socket: { remoteAddress: ip } });

test("shared auth failures enforce account+IP policy across separate workers", async () => {
  const store = atomicStore();
  const options = { store, secret: SECRET, identityKeyGenerator: r => r.account, mode: "balanced",
    policies: { accountIp: { maxFailures: 2, lockoutMs: 30_000, maxLockoutMs: 60_000 } } };
  const a = createDistributedAuthProtection(options), b = createDistributedAuthProtection(options);
  await a.recordFailure(req()); await b.recordFailure(req());
  const status = await a.getStatus(req());
  assert.equal(status.blocked, true);
  assert.ok(status.scopes.includes("accountIp"));
  const blocked = await invoke(b.middleware, req());
  assert.equal(blocked.response.statusCode, 429);
  assert.equal(blocked.nextCount, 0);
});

test("successful login clears account scopes but preserves IP-wide failures", async () => {
  const store = atomicStore();
  const guard = createDistributedAuthProtection({ store, secret: SECRET,
    identityKeyGenerator: r => r.account, mode: "balanced",
    policies: { ip: { maxFailures: 2 }, accountIp: { maxFailures: 2 }, account: { maxFailures: 2 } } });
  await guard.recordFailure(req()); await guard.recordFailure(req());
  assert.equal((await guard.getStatus(req())).blocked, true);
  await guard.recordSuccess(req());
  const status = await guard.getStatus(req());
  assert.equal(status.blocked, true);
  assert.deepEqual(status.scopes, ["ip"]);
});

test("store outage fails closed on middleware with generic 503", async () => {
  const events = [];
  const guard = createDistributedAuthProtection({
    store: { async recordFailure(){throw Error("secret backend detail");}, async getStatus(){throw Error("secret backend detail");}, async clearFailures(){} },
    secret: SECRET, identityKeyGenerator: r => r.account, mode: "balanced", onEvent: e => events.push(e)
  });
  const result = await invoke(guard.middleware, req());
  assert.equal(result.response.statusCode, 503);
  assert.equal(result.nextCount, 0);
  assert.equal(JSON.stringify(events).includes("secret backend detail"), false);
  assert.equal(events[0].severity, "critical");
});

test("store keys and security events do not disclose raw account or IP", async () => {
  const store = atomicStore(), events = [];
  const guard = createDistributedAuthProtection({ store, secret: SECRET, identityKeyGenerator: r => r.account,
    clientKeyGenerator: r => r.socket.remoteAddress, onEvent: e => events.push(e),
    mode: "balanced", policies: { accountIp: { maxFailures: 1 } } });
  await guard.recordFailure(req());
  assert.equal([...store.records.keys()].some(k => k.includes("owner@example.test") || k.includes("192.0.2.8")), false);
  assert.equal(JSON.stringify(events).includes("owner@example.test"), false);
  assert.equal(JSON.stringify(events).includes("192.0.2.8"), false);
});

test("configuration rejects missing stable secrets and incomplete stores", () => {
  assert.throws(() => createDistributedAuthProtection({ store: atomicStore(), identityKeyGenerator: r => r.account }), /at least 32 bytes/);
  assert.throws(() => createDistributedAuthProtection({ store: {}, secret: SECRET, identityKeyGenerator: r => r.account }), /store.recordFailure/);
});
