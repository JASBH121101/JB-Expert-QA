import test from "node:test";
import assert from "node:assert/strict";
import {
  createAccountRecovery,
  createMemoryRecoveryStore,
  createSecurityGuard
} from "@jb/security-guard";

const SECRET = "test-recovery-secret-material-at-least-32-bytes";
const REQUEST = { socket: { remoteAddress: "192.0.2.10" } };

function makeRecovery(options = {}) {
  const events = [];
  const recovery = createAccountRecovery({
    secret: SECRET,
    onEvent(event) { events.push(event); },
    ...options
  });
  return { recovery, events };
}

async function flushDelivery() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("recovery is exposed through the Guard factory and validates the secret", () => {
  const guard = createSecurityGuard({ mode: "balanced", rateLimit: { enabled: false } });
  assert.equal(typeof guard.createAccountRecovery, "function");
  assert.throws(() => createAccountRecovery({ secret: "too-short" }), /at least 32 bytes/);
});

test("SMS recovery sends a six-digit OTP only to a verified phone and consumes it once", async () => {
  const deliveries = [];
  const { recovery, events } = makeRecovery({
    smsProvider: { async send(message) { deliveries.push(message); } }
  });
  const result = await recovery.requestRecovery({
    accountId: "user-42", channel: "sms", destination: "+50588887777",
    contactVerified: true, request: REQUEST
  });
  await flushDelivery();
  assert.equal(result.accepted, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].requestId, result.requestId);
  assert.match(deliveries[0].code, /^\d{6}$/);
  assert.equal(JSON.stringify(result).includes(deliveries[0].code), false);
  assert.equal(JSON.stringify(events).includes(deliveries[0].code), false);

  const verified = await recovery.verifyRecovery({
    requestId: result.requestId, credential: deliveries[0].code, request: REQUEST
  });
  assert.deepEqual(verified, { valid: true, accountId: "user-42", channel: "sms" });
  const replay = await recovery.verifyRecovery({
    requestId: result.requestId, credential: deliveries[0].code, request: REQUEST
  });
  assert.deepEqual(replay, { valid: false });
});

test("email recovery provides a high-entropy token and does not return it to the caller", async () => {
  const deliveries = [];
  const { recovery } = makeRecovery({
    emailProvider: { async send(message) { deliveries.push(message); } }
  });
  const result = await recovery.requestRecovery({
    accountId: "user-99", channel: "email", destination: "User@example.test",
    contactVerified: true, request: REQUEST
  });
  await flushDelivery();
  assert.equal(deliveries[0].to, "user@example.test");
  assert.equal(deliveries[0].token.length, 43);
  assert.equal(result.accepted, true);
  assert.equal(JSON.stringify(result).includes(deliveries[0].token), false);

  const verified = await recovery.verifyRecovery({
    requestId: result.requestId, credential: deliveries[0].token, request: REQUEST
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.accountId, "user-99");
});

test("unknown accounts and unverified destinations receive the same generic response without delivery", async () => {
  let sends = 0;
  const { recovery } = makeRecovery({
    smsProvider: { async send() { sends += 1; } }
  });
  const unknown = await recovery.requestRecovery({
    accountId: null, channel: "sms", destination: null,
    contactVerified: false, request: REQUEST
  });
  const unverified = await recovery.requestRecovery({
    accountId: "user-42", channel: "sms", destination: "+50588887777",
    contactVerified: false, request: { socket: { remoteAddress: "192.0.2.11" } }
  });
  assert.equal(unknown.accepted, true);
  assert.equal(unverified.accepted, true);
  assert.equal(sends, 0);
  assert.notEqual(unknown.requestId, unverified.requestId);
});

test("new recovery challenge invalidates the previous challenge for the same account and channel", async () => {
  const deliveries = [];
  const { recovery } = makeRecovery({
    emailProvider: { async send(message) { deliveries.push(message); } }
  });
  const first = await recovery.requestRecovery({
    accountId: "user-1", channel: "email", destination: "user@example.test",
    contactVerified: true, request: REQUEST
  });
  await flushDelivery();
  const second = await recovery.requestRecovery({
    accountId: "user-1", channel: "email", destination: "user@example.test",
    contactVerified: true, request: REQUEST
  });
  await flushDelivery();
  assert.equal((await recovery.verifyRecovery({
    requestId: first.requestId, credential: deliveries[0].token, request: REQUEST
  })).valid, false);
  assert.equal((await recovery.verifyRecovery({
    requestId: second.requestId, credential: deliveries[1].token, request: REQUEST
  })).valid, true);
});

test("wrong OTP attempts lock and consume a challenge after the configured maximum", async () => {
  const deliveries = [];
  const { recovery } = makeRecovery({
    maxAttempts: 2,
    smsProvider: { async send(message) { deliveries.push(message); } }
  });
  const issued = await recovery.requestRecovery({
    accountId: "user-2", channel: "sms", destination: "+50588887777",
    contactVerified: true, request: REQUEST
  });
  await flushDelivery();
  assert.deepEqual(await recovery.verifyRecovery({
    requestId: issued.requestId,
    credential: deliveries[0].code === "000000" ? "000001" : "000000",
    request: REQUEST
  }), { valid: false });
  assert.deepEqual(await recovery.verifyRecovery({
    requestId: issued.requestId, credential: "000000", request: REQUEST
  }), { valid: false });
  assert.deepEqual(await recovery.verifyRecovery({
    requestId: issued.requestId, credential: deliveries[0].code, request: REQUEST
  }), { valid: false });
});

test("expired challenges cannot be used", async () => {
  let now = 1_000_000;
  const deliveries = [];
  const { recovery } = makeRecovery({
    clock: () => now,
    smsTtlMs: 1000,
    smsProvider: { async send(message) { deliveries.push(message); } }
  });
  const issued = await recovery.requestRecovery({
    accountId: "user-3", channel: "sms", destination: "+50588887777",
    contactVerified: true, request: REQUEST
  });
  await flushDelivery();
  now += 1001;
  assert.deepEqual(await recovery.verifyRecovery({
    requestId: issued.requestId, credential: deliveries[0].code, request: REQUEST
  }), { valid: false });
});

test("request limits are enforced by IP without revealing the throttle to the caller", async () => {
  let sends = 0;
  const { recovery, events } = makeRecovery({
    requestPolicies: { ip: { maxRequests: 1, windowMs: 60_000 } },
    smsProvider: { async send() { sends += 1; } }
  });
  const base = {
    accountId: "user-4", channel: "sms", destination: "+50588887777",
    contactVerified: true, request: REQUEST
  };
  const first = await recovery.requestRecovery(base);
  const second = await recovery.requestRecovery(base);
  await flushDelivery();
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(sends, 1);
  assert.ok(events.some((event) => event.action === "request-rate-limited"));
  assert.equal(JSON.stringify(events).includes("+50588887777"), false);
});

test("verification has a separate per-IP limit across challenge IDs", async () => {
  const deliveries = [];
  const { recovery } = makeRecovery({
    verifyIpPolicy: { maxRequests: 1, windowMs: 60_000 },
    smsProvider: { async send(message) { deliveries.push(message); } }
  });
  const issued = await recovery.requestRecovery({
    accountId: "user-5", channel: "sms", destination: "+50588887777",
    contactVerified: true, request: REQUEST
  });
  await flushDelivery();
  assert.deepEqual(await recovery.verifyRecovery({
    requestId: "00000000-0000-4000-8000-000000000000",
    credential: "000000", request: REQUEST
  }), { valid: false });
  assert.deepEqual(await recovery.verifyRecovery({
    requestId: issued.requestId, credential: deliveries[0].code, request: REQUEST
  }), { valid: false });
});

test("provider failures remove the challenge and never expose provider errors", async () => {
  const { recovery, events } = makeRecovery({
    emailProvider: { async send() { throw new Error("provider secret or recipient details"); } }
  });
  const issued = await recovery.requestRecovery({
    accountId: "user-6", channel: "email", destination: "user@example.test",
    contactVerified: true, request: REQUEST
  });
  await flushDelivery();
  assert.equal(issued.accepted, true);
  assert.deepEqual(await recovery.verifyRecovery({
    requestId: issued.requestId, credential: "a".repeat(43), request: REQUEST
  }), { valid: false });
  assert.equal(JSON.stringify(events).includes("provider secret"), false);
});

test("memory store enforces one-time consume and bounded capacity", () => {
  const store = createMemoryRecoveryStore({ maxChallenges: 1, maxRateKeys: 1 });
  assert.equal(typeof store.putChallenge, "function");
  assert.equal(typeof store.consumeChallenge, "function");
  assert.equal(typeof store.consumeLimit, "function");
  store.putChallenge({
    id: "one", subjectKey: "subject-one", accountId: "user-one", channel: "sms",
    credentialDigest: "a".repeat(64), createdAt: 1, expiresAt: 1000
  });
  store.putChallenge({
    id: "two", subjectKey: "subject-two", accountId: "user-two", channel: "sms",
    credentialDigest: "b".repeat(64), createdAt: 1, expiresAt: 1000
  });
  assert.deepEqual(store.getStats(), { challenges: 1, rateLimitKeys: 0 });
  assert.equal(store.consumeLimit({
    key: "ip-one", now: 1, windowMs: 1000, maxRequests: 1
  }).allowed, true);
  assert.equal(store.consumeLimit({
    key: "ip-two", now: 1, windowMs: 1000, maxRequests: 1
  }).allowed, true);
  assert.deepEqual(store.getStats(), { challenges: 1, rateLimitKeys: 1 });
});

test("configuration rejects malformed providers, policies, and numbers", () => {
  assert.throws(() => createAccountRecovery({ secret: SECRET, smsProvider: {} }), /smsProvider/);
  assert.throws(() => createAccountRecovery({
    secret: SECRET, requestPolicies: { unexpected: { maxRequests: 1 } }
  }), /Unknown requestPolicies scope/);
  assert.throws(() => createMemoryRecoveryStore({ maxChallenges: 0 }), /maxChallenges/);
});
