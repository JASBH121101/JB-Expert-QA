import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createMockRecoveryProviders } from "../packages/security-guard/testing/recovery-adapters.js";
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
    requestId: issued.requestId,
    credential: deliveries[0].code === "000000" ? "000001" : "000000",
    request: REQUEST
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
  assert.equal(store.putChallenge({
    id: "one", subjectKey: "a".repeat(64), accountId: "user-one", channel: "sms",
    credentialDigest: "a".repeat(64), createdAt: 1, expiresAt: 1000
  }), true);
  assert.equal(store.putChallenge({
    id: "two", subjectKey: "b".repeat(64), accountId: "user-two", channel: "sms",
    credentialDigest: "b".repeat(64), createdAt: 1, expiresAt: 1000
  }), false, "a full store must not evict a live recovery challenge");
  assert.deepEqual(store.getStats(), { challenges: 1, rateLimitKeys: 0 });
  assert.equal(store.consumeLimit({
    key: "ip-one", now: 1, windowMs: 1000, maxRequests: 1
  }).allowed, true);
  const saturated = store.consumeLimit({
    key: "ip-two", now: 2, windowMs: 1000, maxRequests: 1
  });
  assert.equal(saturated.allowed, false, "live limiter buckets must not be evicted to make room");
  assert.ok(saturated.retryAfterMs > 0);
  assert.deepEqual(store.getStats(), { challenges: 1, rateLimitKeys: 1 });

  const afterExpiry = store.consumeLimit({
    key: "ip-two", now: 1001, windowMs: 1000, maxRequests: 1
  });
  assert.equal(afterExpiry.allowed, true, "expired buckets should be reclaimed safely");
  assert.equal(store.consumeChallenge({
    id: "one", credentialDigest: "a".repeat(64), now: 2, maxAttempts: 5
  }).status, "valid", "the original live challenge must remain usable");
});

test("configuration rejects malformed providers, policies, and numbers", () => {
  assert.throws(() => createAccountRecovery({ secret: SECRET, smsProvider: {} }), /smsProvider/);
  assert.throws(() => createAccountRecovery({
    secret: SECRET, requestPolicies: { unexpected: { maxRequests: 1 } }
  }), /Unknown requestPolicies scope/);
  assert.throws(() => createMemoryRecoveryStore({ maxChallenges: 0 }), /maxChallenges/);
});


test("mock providers keep recovery messages in memory and exercise the real verification flow", async () => {
  const mocks = createMockRecoveryProviders();
  const recovery = createAccountRecovery({
    secret: randomBytes(32),
    emailProvider: mocks.emailProvider,
    smsProvider: mocks.smsProvider
  });

  const emailRequest = await recovery.requestRecovery({
    accountId: "test-email-account",
    channel: "email",
    destination: "qa-user@example.test",
    contactVerified: true,
    request: REQUEST
  });
  const smsRequest = await recovery.requestRecovery({
    accountId: "test-sms-account",
    channel: "sms",
    destination: "+15555550100",
    contactVerified: true,
    request: REQUEST
  });
  await flushDelivery();

  const emailMessages = mocks.takeMessages("email");
  const smsMessages = mocks.takeMessages("sms");
  assert.equal(emailMessages.length, 1);
  assert.equal(smsMessages.length, 1);
  assert.match(emailMessages[0].token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(smsMessages[0].code, /^\d{6}$/);
  assert.equal(JSON.stringify(emailRequest).includes(emailMessages[0].token), false);
  assert.equal(JSON.stringify(smsRequest).includes(smsMessages[0].code), false);

  assert.deepEqual(await recovery.verifyRecovery({
    requestId: emailRequest.requestId,
    credential: emailMessages[0].token,
    request: REQUEST
  }), { valid: true, accountId: "test-email-account", channel: "email" });
  assert.deepEqual(await recovery.verifyRecovery({
    requestId: smsRequest.requestId,
    credential: smsMessages[0].code,
    request: REQUEST
  }), { valid: true, accountId: "test-sms-account", channel: "sms" });

  assert.deepEqual(mocks.getMessages("email"), []);
  assert.deepEqual(mocks.getMessages("sms"), []);
  mocks.close();
  await assert.rejects(mocks.emailProvider.send({
    to: "qa-user@example.test",
    requestId: emailRequest.requestId,
    token: emailMessages[0].token,
    expiresAt: emailMessages[0].expiresAt
  }), /closed/);
});

test("mock providers enforce bounded queues and reject malformed test messages", async () => {
  const mocks = createMockRecoveryProviders({ maxMessages: 1 });
  const message = {
    to: "qa-user@example.test",
    requestId: "00000000-0000-4000-8000-000000000000",
    token: "A".repeat(43),
    expiresAt: 2_000_000
  };
  await mocks.emailProvider.send(message);
  await assert.rejects(mocks.emailProvider.send(message), /capacity/);
  await assert.rejects(mocks.smsProvider.send({
    to: "+15555550100",
    requestId: message.requestId,
    code: "not-an-otp",
    expiresAt: message.expiresAt
  }), /six-digit/);
  assert.equal(mocks.getMessages("email").length, 1);
  mocks.clear("email");
  assert.deepEqual(mocks.getMessages("email"), []);
  mocks.close();
});

test("anonymous recovery requests reuse bounded synthetic buckets", async () => {
  const { recovery } = makeRecovery({
    requestPolicies: {
      ip: { maxRequests: 100, windowMs: 60_000 },
      account: { maxRequests: 100, windowMs: 60_000 },
      destination: { maxRequests: 100, windowMs: 60_000 }
    }
  });

  for (let index = 0; index < 25; index += 1) {
    await recovery.requestRecovery({
      accountId: null,
      channel: "email",
      destination: null,
      contactVerified: false,
      request: REQUEST
    });
  }

  assert.equal(recovery.getStats().storage.rateLimitKeys, 3);
});

test("challenge-store saturation suppresses new deliveries without evicting active challenges", async () => {
  const deliveries = [];
  const store = createMemoryRecoveryStore({ maxChallenges: 1 });
  const { recovery } = makeRecovery({
    store,
    emailProvider: { async send(message) { deliveries.push(message); } }
  });

  const first = await recovery.requestRecovery({
    accountId: "active-account",
    channel: "email",
    destination: "first@example.test",
    contactVerified: true,
    request: REQUEST
  });
  const second = await recovery.requestRecovery({
    accountId: "new-account",
    channel: "email",
    destination: "second@example.test",
    contactVerified: true,
    request: REQUEST
  });
  await flushDelivery();

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(deliveries.length, 1);
  assert.equal((await recovery.verifyRecovery({
    requestId: first.requestId,
    credential: deliveries[0].token,
    request: REQUEST
  })).valid, true);
  assert.equal(recovery.getStats().suppressed, 1);
});

test("recovery rejects malformed UUIDs and invalid clock values", async () => {
  const { recovery } = makeRecovery({ clock: () => 1.5 });
  await assert.rejects(recovery.requestRecovery({
    accountId: "user-clock",
    channel: "email",
    destination: "user@example.test",
    contactVerified: true,
    request: REQUEST
  }), /safe integer timestamp/);

  const valid = makeRecovery();
  assert.deepEqual(await valid.recovery.verifyRecovery({
    requestId: "------------------------------------",
    credential: "x",
    request: REQUEST
  }), { valid: false });
});
