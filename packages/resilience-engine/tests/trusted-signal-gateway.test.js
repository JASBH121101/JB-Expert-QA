import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryTrustedSignalStore,
  createTrustedSignalGateway,
  signTrustedSignalEnvelope,
  validateTrustedSignalEnvelope
} from "../src/trusted-signal-gateway.js";

const GUARD_KEY = "test-only-security-guard-key-material-32-bytes-minimum";
const MALWARE_KEY = "test-only-malware-engine-key-material-32-bytes-minimum";
const ASSET = "host-erp-01";
const ENV = "production";
const EVIDENCE = [{
  refId: "evidence:sample-01",
  sha256: "a".repeat(64)
}];

function setup({ clock = () => 1_800_000_000_000, replayStore = null, ...options } = {}) {
  const store = replayStore ?? createMemoryTrustedSignalStore();
  const gateway = createTrustedSignalGateway({
    sources: [
      {
        sourceId: "guard-primary",
        engine: "security-guard",
        environment: ENV,
        assetIds: [ASSET],
        key: GUARD_KEY
      },
      {
        sourceId: "malware-primary",
        engine: "malware-engine",
        environment: ENV,
        assetIds: [ASSET],
        key: MALWARE_KEY
      }
    ],
    replayStore: store,
    requireDurableStore: false,
    allowInMemoryStore: true,
    clock,
    ...options
  });
  return { gateway, store };
}

let nextId = 1;
function eventId() {
  const suffix = String(nextId++).padStart(12, "0");
  return "00000000-0000-4000-8000-" + suffix;
}

function signal({
  sourceId = "guard-primary",
  sourceEngine = "security-guard",
  key = GUARD_KEY,
  state = "clear",
  now = 1_800_000_000_000,
  assetId = ASSET,
  environment = ENV,
  evidenceRefs = [],
  reasonCode = "SIGNAL_CLEAR"
} = {}) {
  return signTrustedSignalEnvelope({
    schema: "jb.resilience.trusted-signal/v1",
    eventId: eventId(),
    sourceId,
    sourceEngine,
    environment,
    assetId,
    issuedAtMs: now,
    expiresAtMs: now + 60_000,
    state,
    severity: state === "confirmed" || state === "tampered" ? "critical" : "info",
    reasonCode,
    evidenceRefs: ["confirmed", "tampered"].includes(state) ? EVIDENCE : evidenceRefs
  }, key);
}

async function ingestBoth(gateway, now, guardState = "clear", malwareState = "clear") {
  const guard = signal({ state: guardState, now });
  const malware = signal({
    sourceId: "malware-primary",
    sourceEngine: "malware-engine",
    key: MALWARE_KEY,
    state: malwareState,
    now
  });
  assert.equal((await gateway.ingest(guard)).accepted, true);
  assert.equal((await gateway.ingest(malware)).accepted, true);
  return { guard, malware };
}

test("requires a durable replay store unless test-memory opt-in is explicit", () => {
  const store = createMemoryTrustedSignalStore();
  assert.throws(() => createTrustedSignalGateway({
    sources: [{
      sourceId: "guard-primary", engine: "security-guard", environment: ENV,
      assetIds: [ASSET], key: GUARD_KEY
    }],
    replayStore: store
  }), /durable replayStore/);
  assert.throws(() => createTrustedSignalGateway({
    sources: [{
      sourceId: "guard-primary", engine: "security-guard", environment: ENV,
      assetIds: [ASSET], key: GUARD_KEY
    }],
    replayStore: store,
    requireDurableStore: false
  }), /explicit allowInMemoryStore/);
});

test("accepts correctly signed, fresh, scoped signals", async () => {
  const { gateway } = setup();
  const item = signal();
  const result = await gateway.ingest(item);
  assert.equal(result.accepted, true);
  assert.equal(result.sourceEngine, "security-guard");
  assert.equal(result.assetId, ASSET);
});

test("rejects tampered payloads and signatures", async () => {
  const { gateway } = setup();
  const item = signal();
  const changed = { ...item, state: "confirmed" };
  assert.equal((await gateway.ingest(changed)).accepted, false);
  assert.equal((await gateway.ingest({ ...item, signature: "b".repeat(64) })).reason, "invalid-signature");
});

test("rejects unknown source and source engine, environment or asset scope mismatch", async () => {
  const { gateway } = setup();
  const original = signal();
  assert.equal((await gateway.ingest({ ...original, sourceId: "unregistered" })).reason, "untrusted-source");
  const wrongAsset = signal({ assetId: "host-other" });
  assert.equal((await gateway.ingest(wrongAsset)).reason, "source-scope-mismatch");
  const wrongEnvironment = signal({ environment: "development" });
  assert.equal((await gateway.ingest(wrongEnvironment)).reason, "source-scope-mismatch");
  const wrongEngine = signal({ sourceEngine: "malware-engine" });
  assert.equal((await gateway.ingest(wrongEngine)).reason, "source-scope-mismatch");
});

test("rejects expired, stale, too-long and future-dated signals", async () => {
  let now = 1_800_000_000_000;
  const { gateway } = setup({ clock: () => now });
  const expired = signal({ now: now - 120_000 });
  assert.equal((await gateway.ingest(expired)).reason, "signal-expired");
  const tooLong = signTrustedSignalEnvelope({
    schema: "jb.resilience.trusted-signal/v1",
    eventId: eventId(),
    sourceId: "guard-primary",
    sourceEngine: "security-guard",
    environment: ENV,
    assetId: ASSET,
    issuedAtMs: now,
    expiresAtMs: now + 600_000,
    state: "clear",
    severity: "info",
    reasonCode: "SIGNAL_CLEAR",
    evidenceRefs: []
  }, GUARD_KEY);
  assert.equal((await gateway.ingest(tooLong)).reason, "signal-lifetime-exceeded");
  const future = signal({ now: now + 60_000 });
  assert.equal((await gateway.ingest(future)).reason, "signal-from-future");
  now += 5;
});

test("rejects malformed schemas, extra fields and confirmed signals without evidence", async () => {
  const { gateway } = setup();
  const item = signal();
  assert.throws(() => validateTrustedSignalEnvelope({ ...item, extra: true }), /unsupported fields/);
  assert.equal((await gateway.ingest({ ...item, schema: "jb.other/v1" })).reason, "invalid-envelope");
  assert.throws(() => signTrustedSignalEnvelope({
    schema: "jb.resilience.trusted-signal/v1",
    eventId: eventId(),
    sourceId: "guard-primary",
    sourceEngine: "security-guard",
    environment: ENV,
    assetId: ASSET,
    issuedAtMs: 1_800_000_000_000,
    expiresAtMs: 1_800_000_060_000,
    state: "confirmed",
    severity: "critical",
    reasonCode: "THREAT_CONFIRMED",
    evidenceRefs: []
  }, GUARD_KEY), /at least one evidence reference/);
});

test("claims event IDs atomically and rejects replay or conflicting reuse", async () => {
  const { gateway } = setup();
  const item = signal();
  assert.equal((await gateway.ingest(item)).accepted, true);
  assert.equal((await gateway.ingest(item)).reason, "signal-replay");
  const { signature: ignoredSignature, ...unsigned } = item;
  const reused = signTrustedSignalEnvelope({
    ...unsigned,
    state: "suspected",
    reasonCode: "THREAT_SUSPECTED",
    severity: "high"
  }, GUARD_KEY);
  assert.equal((await gateway.ingest(reused)).reason, "signal-id-conflict");
});

test("reports clear only when every configured source has a fresh clear signal", async () => {
  const now = 1_800_000_000_000;
  const { gateway } = setup({ clock: () => now });
  await ingestBoth(gateway, now);
  const result = await gateway.getSecurityState({ assetId: ASSET, environment: ENV });
  assert.equal(result.state, "clear");
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.sources.length, 2);
});

test("missing or expired required source fails closed as unknown or stale", async () => {
  let now = 1_800_000_000_000;
  const { gateway } = setup({ clock: () => now });
  const onlyGuard = signal({ now });
  await gateway.ingest(onlyGuard);
  assert.equal((await gateway.getSecurityState({ assetId: ASSET, environment: ENV })).state, "unknown");

  const malware = signal({
    sourceId: "malware-primary", sourceEngine: "malware-engine", key: MALWARE_KEY, now
  });
  await gateway.ingest(malware);
  now += 61_000;
  const result = await gateway.getSecurityState({ assetId: ASSET, environment: ENV });
  assert.equal(result.state, "stale");
  assert.equal(result.reason, "required-source-signal-expired");
});

test("conflicting clear and threat signals fail closed", async () => {
  const now = 1_800_000_000_000;
  const { gateway } = setup({ clock: () => now });
  await ingestBoth(gateway, now, "clear", "suspected");
  const result = await gateway.getSecurityState({ assetId: ASSET, environment: ENV });
  assert.equal(result.state, "conflicting");
  assert.equal(result.reason, "trusted-sources-disagree");
});

test("confirmed and tampered findings retain evidence and never grant authorization", async () => {
  const now = 1_800_000_000_000;
  const { gateway } = setup({ clock: () => now });
  await ingestBoth(gateway, now, "suspected", "confirmed");
  const confirmed = await gateway.getSecurityState({ assetId: ASSET, environment: ENV });
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.evidenceRefs.length, 1);
  assert.equal(confirmed.authorizationGranted, false);

  const { gateway: second } = setup({ clock: () => now });
  await ingestBoth(second, now, "clear", "tampered");
  const tampered = await second.getSecurityState({ assetId: ASSET, environment: ENV });
  assert.equal(tampered.state, "tampered");
  assert.equal(tampered.preserveEvidence, true);
  assert.equal(tampered.authorizationGranted, false);
});

test("tampered persisted records are rejected instead of trusted", async () => {
  const records = [];
  const store = {
    durable: true,
    async recordSignal(record) { records.push(record); return { recorded: true }; },
    async listSignals() {
      return records.map((record) => ({
        ...record,
        signal: { ...record.signal, state: "confirmed" }
      }));
    }
  };
  const { gateway } = setup({ replayStore: store, clock: () => 1_800_000_000_000 });
  await gateway.ingest(signal());
  const result = await gateway.getSecurityState({ assetId: ASSET, environment: ENV });
  assert.equal(result.state, "tampered");
  assert.equal(result.reason, "persisted-signal-integrity-failure");
});

test("replay-store failures never accept a signal or report a clear state", async () => {
  const store = {
    durable: true,
    async recordSignal() { throw new Error("offline"); },
    async listSignals() { throw new Error("offline"); }
  };
  const { gateway } = setup({ replayStore: store });
  assert.equal((await gateway.ingest(signal())).reason, "replay-store-unavailable");
  assert.equal((await gateway.getSecurityState({ assetId: ASSET, environment: ENV })).state, "unknown");
});

test("source definitions reject duplicate IDs and wildcard capabilities", () => {
  const store = createMemoryTrustedSignalStore();
  const source = {
    sourceId: "guard-primary", engine: "security-guard", environment: ENV,
    assetIds: [ASSET], key: GUARD_KEY
  };
  assert.throws(() => createTrustedSignalGateway({
    sources: [source, source], replayStore: store,
    requireDurableStore: false, allowInMemoryStore: true
  }), /unique/);
  assert.throws(() => createTrustedSignalGateway({
    sources: [{ ...source, assetIds: ["*"] }], replayStore: store,
    requireDurableStore: false, allowInMemoryStore: true
  }), /invalid format/);
});
