import test from "node:test";
import assert from "node:assert/strict";
import { createAccountRecovery } from "@jb/security-guard";

const SECRET = "recovery-core-test-secret-material-at-least-32-bytes";
const CORE = {
  tenantId: "tenant-recovery",
  applicationId: "recovery-api",
  accountKeyId: "recovery-account-hmac-v1",
  clientKeyId: "recovery-client-hmac-v1"
};
const REQUEST = { socket: { remoteAddress: "192.0.2.77" } };

function capture(extra = {}) {
  const attempts = [];
  const decisions = [];
  const events = [];
  const recovery = createAccountRecovery({
    secret: SECRET,
    coreContract: CORE,
    onCoreAttempt: (value) => attempts.push(value),
    onCoreDecision: (value) => decisions.push(value),
    onCoreEvent: (value) => events.push(value),
    ...extra
  });
  return { recovery, attempts, decisions, events };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("recovery Core v1 reports delivery and verification without exposing secrets or identities", async () => {
  const deliveries = [];
  const state = capture({
    smsProvider: { async send(message) { deliveries.push(message); } }
  });
  const accountId = "private-recovery-account-42";
  const destination = "+50588886666";
  const issued = await state.recovery.requestRecovery({
    accountId, channel: "sms", destination, contactVerified: true, request: REQUEST
  });
  await flush();

  assert.deepEqual({ accepted: issued.accepted }, { accepted: true });
  assert.equal(deliveries.length, 1);
  assert.equal(state.attempts.length, 0, "generic request acceptance is not reported as successful authentication");
  assert.ok(state.events.some((event) =>
    event.category === "recovery" && event.ruleId === "JBG-RECOVERY-REQUEST-001" &&
    event.action === "challenged" && event.outcome === "success"
  ));

  const wrong = deliveries[0].code === "000000" ? "000001" : "000000";
  assert.deepEqual(await state.recovery.verifyRecovery({
    requestId: issued.requestId, credential: wrong, request: REQUEST
  }), { valid: false });
  assert.deepEqual(await state.recovery.verifyRecovery({
    requestId: issued.requestId, credential: deliveries[0].code, request: REQUEST
  }), { valid: true, accountId, channel: "sms" });

  assert.deepEqual(state.attempts.map((attempt) => attempt.outcome), ["failure", "success"]);
  assert.ok(state.attempts.every((attempt) =>
    attempt.operation === "account_recovery" &&
    attempt.schema === "jb.security.authentication.attempt/v1"
  ));
  assert.ok(state.decisions.every((entry) =>
    entry.decision.outcome === "allow" && entry.decision.status === null
  ), "allow describes passing the verification throttle, not OTP acceptance");
  assert.ok(state.events.some((event) => event.scope === "invalidCredential"));
  assert.ok(state.events.some((event) => event.outcome === "success" && event.action === "allowed"));

  const serialized = JSON.stringify({
    attempts: state.attempts, decisions: state.decisions, events: state.events
  });
  for (const sensitive of [accountId, destination, REQUEST.socket.remoteAddress, deliveries[0].code]) {
    assert.equal(serialized.includes(sensitive), false, "Core telemetry must not contain raw identity or credential data");
  }
  assert.ok(state.events.every((event) =>
    event.category === "recovery" && event.schema === "jb.security.event/v1"
  ));
});

test("recovery Core v1 distinguishes locked, expired, and missing-or-consumed challenges", async () => {
  const deliveries = [];
  const state = capture({
    maxAttempts: 1,
    smsProvider: { async send(message) { deliveries.push(message); } }
  });
  const issued = await state.recovery.requestRecovery({
    accountId: "locked-account", channel: "sms", destination: "+50588885555",
    contactVerified: true, request: REQUEST
  });
  await flush();
  const wrong = deliveries[0].code === "000000" ? "000001" : "000000";
  await state.recovery.verifyRecovery({ requestId: issued.requestId, credential: wrong, request: REQUEST });
  await state.recovery.verifyRecovery({ requestId: issued.requestId, credential: deliveries[0].code, request: REQUEST });
  const rules = state.events.map((event) => event.ruleId);
  assert.ok(rules.includes("JBG-RECOVERY-BRUTE-001"));
  assert.ok(rules.includes("JBG-RECOVERY-CHALLENGE-001"));
  assert.equal(state.events.find((event) => event.ruleId === "JBG-RECOVERY-BRUTE-001").severity, "high");

  let now = 5_000_000;
  const expiredDeliveries = [];
  const expiredState = capture({
    clock: () => now,
    smsTtlMs: 1000,
    smsProvider: { async send(message) { expiredDeliveries.push(message); } }
  });
  const expired = await expiredState.recovery.requestRecovery({
    accountId: "expired-account", channel: "sms", destination: "+50588884444",
    contactVerified: true, request: REQUEST
  });
  await flush();
  now += 1001;
  assert.deepEqual(await expiredState.recovery.verifyRecovery({
    requestId: expired.requestId, credential: expiredDeliveries[0].code, request: REQUEST
  }), { valid: false });
  assert.ok(expiredState.events.some((event) => event.ruleId === "JBG-RECOVERY-EXPIRED-001"));
});

test("verification IP quota emits a deny decision while keeping the public response generic", async () => {
  const deliveries = [];
  const state = capture({
    verifyIpPolicy: { maxRequests: 1, windowMs: 60_000 },
    smsProvider: { async send(message) { deliveries.push(message); } }
  });
  const issued = await state.recovery.requestRecovery({
    accountId: "quota-account", channel: "sms", destination: "+50588883333",
    contactVerified: true, request: REQUEST
  });
  await flush();

  assert.deepEqual(await state.recovery.verifyRecovery({
    requestId: issued.requestId, credential: "wrong", request: REQUEST
  }), { valid: false });
  assert.deepEqual(await state.recovery.verifyRecovery({
    requestId: issued.requestId, credential: deliveries[0].code, request: REQUEST
  }), { valid: false });
  assert.equal(state.decisions[0].decision.outcome, "allow");
  assert.equal(state.decisions[1].decision.outcome, "deny");
  assert.equal(state.decisions[1].decision.status, 429);
  assert.ok(state.events.some((event) => event.ruleId === "JBG-RECOVERY-RATE-001" && event.outcome === "denied"));
});

test("recovery store outages emit sanitized unavailable telemetry and preserve thrown behavior", async () => {
  const events = [];
  const unavailableStore = {
    async putChallenge() { throw new Error("private storage endpoint or credential"); },
    async consumeChallenge() { throw new Error("private storage endpoint or credential"); },
    async consumeLimit() { throw new Error("private storage endpoint or credential"); },
    async deleteChallenge() { return false; }
  };
  const recovery = createAccountRecovery({
    secret: SECRET,
    store: unavailableStore,
    coreContract: CORE,
    onCoreEvent: (event) => events.push(event)
  });

  await assert.rejects(recovery.requestRecovery({
    accountId: "outage-account", channel: "sms", destination: "+50588882222",
    contactVerified: true, request: REQUEST
  }), /private storage endpoint/);
  assert.ok(events.some((event) =>
    event.ruleId === "JBG-RECOVERY-STORE-001" &&
    event.outcome === "unavailable" &&
    event.severity === "critical"
  ));
  assert.equal(JSON.stringify(events).includes("private storage endpoint"), false);
});

test("Core callbacks are opt-in, isolated, and configuration is constrained to recovery operation", async () => {
  assert.throws(() => createAccountRecovery({
    secret: SECRET, coreContract: { ...CORE, operation: "login" }
  }), /must be account_recovery/);
  assert.throws(() => createAccountRecovery({
    secret: SECRET, coreContract: CORE, onCoreEvent: {}
  }), /onCoreEvent must be a function/);

  const recovery = createAccountRecovery({
    secret: SECRET,
    coreContract: CORE,
    onCoreAttempt() { throw new Error("telemetry failure"); },
    onCoreDecision() { throw new Error("telemetry failure"); },
    onCoreEvent() { throw new Error("telemetry failure"); }
  });
  assert.deepEqual(await recovery.verifyRecovery({
    requestId: "00000000-0000-4000-8000-000000000000",
    credential: "invalid", request: REQUEST
  }), { valid: false });
});


test("generic suppression and request rate limiting emit different recovery events", async () => {
  const suppressed = capture();
  const response = await suppressed.recovery.requestRecovery({
    accountId: null, channel: "sms", destination: null,
    contactVerified: false, request: REQUEST
  });
  assert.equal(response.accepted, true);
  assert.equal(suppressed.attempts.length, 0);
  assert.ok(suppressed.events.some((event) =>
    event.action === "observed" && event.outcome === "observed"
  ));

  let deliveries = 0;
  const limited = capture({
    requestPolicies: {
      ip: { maxRequests: 1, windowMs: 60_000 },
      account: { maxRequests: 50, windowMs: 60_000 },
      destination: { maxRequests: 50, windowMs: 60_000 }
    },
    smsProvider: { async send() { deliveries += 1; } }
  });
  const input = {
    accountId: "limited-account", channel: "sms", destination: "+50588881111",
    contactVerified: true, request: REQUEST
  };
  assert.equal((await limited.recovery.requestRecovery(input)).accepted, true);
  assert.equal((await limited.recovery.requestRecovery(input)).accepted, true);
  await flush();
  assert.equal(deliveries, 1);
  assert.ok(limited.events.some((event) =>
    event.ruleId === "JBG-RECOVERY-RATE-001" &&
    event.action === "blocked" && event.outcome === "denied"
  ));
});

test("provider delivery failures are reported only after rejection and remain sanitized", async () => {
  const state = capture({
    smsProvider: {
      async send() {
        throw new Error("private provider token and destination");
      }
    }
  });
  const result = await state.recovery.requestRecovery({
    accountId: "provider-failure-account", channel: "sms",
    destination: "+50588880000", contactVerified: true, request: REQUEST
  });
  assert.equal(result.accepted, true);
  await flush();
  const failure = state.events.find((event) =>
    event.ruleId === "JBG-RECOVERY-REQUEST-001" && event.outcome === "error"
  );
  assert.ok(failure);
  assert.equal(failure.action, "rejected");
  assert.equal(JSON.stringify(state.events).includes("private provider token"), false);
  assert.equal(JSON.stringify(state.events).includes("+50588880000"), false);
  assert.equal(state.recovery.getStats().deliveryFailures, 1);
});

test("verification challenge-store outage publishes unavailable Core decision and event", async () => {
  const attempts = [];
  const decisions = [];
  const events = [];
  const store = {
    async putChallenge() { return true; },
    async consumeLimit() { return { allowed: true, retryAfterMs: 0 }; },
    async consumeChallenge() { throw new Error("private challenge-store connection string"); },
    async deleteChallenge() { return true; }
  };
  const recovery = createAccountRecovery({
    secret: SECRET, store, coreContract: CORE,
    onCoreAttempt: (value) => attempts.push(value),
    onCoreDecision: (value) => decisions.push(value),
    onCoreEvent: (value) => events.push(value)
  });
  await assert.rejects(recovery.verifyRecovery({
    requestId: "00000000-0000-4000-8000-000000000000",
    credential: "wrong", request: REQUEST
  }), /private challenge-store connection string/);
  assert.equal(attempts[0].outcome, "failure");
  assert.equal(decisions[0].decision.outcome, "unavailable");
  assert.equal(decisions[0].decision.status, 503);
  assert.ok(events.some((event) =>
    event.ruleId === "JBG-RECOVERY-STORE-001" && event.outcome === "unavailable"
  ));
  assert.equal(JSON.stringify({ attempts, decisions, events }).includes("connection string"), false);
});
