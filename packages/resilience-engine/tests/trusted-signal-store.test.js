import test from "node:test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp, readFile, rm, writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createFileTrustedSignalStore
} from "../src/trusted-signal-store.js";
import {
  createTrustedSignalGateway,
  signTrustedSignalEnvelope
} from "../src/trusted-signal-gateway.js";

const KEY = "local-test-signing-key-with-at-least-32-bytes";
const ENVIRONMENT = "test";
const ASSET = "host-test-01";
const NOW = 1_800_000_000_000;

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jb-trusted-signal-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, filePath: path.join(directory, "trusted-signals.json") };
}

function createSignal({
  eventId = "00000000-0000-4000-8000-000000000001",
  state = "clear",
  issuedAtMs = NOW
} = {}) {
  return signTrustedSignalEnvelope({
    schema: "jb.resilience.trusted-signal/v1",
    eventId,
    sourceId: "guard-primary",
    sourceEngine: "security-guard",
    environment: ENVIRONMENT,
    assetId: ASSET,
    issuedAtMs,
    expiresAtMs: issuedAtMs + 60_000,
    state,
    severity: state === "suspected" ? "high" : "info",
    reasonCode: state === "suspected" ? "THREAT_SUSPECTED" : "SIGNAL_CLEAR",
    evidenceRefs: []
  }, KEY);
}

function digest(signal) {
  return createHash("sha256")
    .update(JSON.stringify({ ...signal, evidenceRefs: signal.evidenceRefs }), "utf8")
    .digest("hex");
}

function storeInput(signal) {
  return {
    signal,
    signalDigest: digest(signal),
    receivedAtMs: NOW,
    retentionUntilMs: signal.issuedAtMs + 10 * 60_000
  };
}

function recordInChildProcess(filePath, input) {
  const storeModuleUrl = new URL("../src/trusted-signal-store.js", import.meta.url).href;
  const script = [
    "import { createFileTrustedSignalStore } from " + JSON.stringify(storeModuleUrl) + ";",
    "const payload = JSON.parse(process.env.JB_TRUSTED_SIGNAL_INPUT);",
    "const store = createFileTrustedSignalStore({ filePath: payload.filePath });",
    "const result = await store.recordSignal(payload.input);",
    "process.stdout.write(JSON.stringify(result));"
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        JB_TRUSTED_SIGNAL_INPUT: JSON.stringify({ filePath, input })
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || "trusted-signal child process failed"));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("trusted-signal child process returned invalid JSON: " + stdout));
      }
    });
  });
}

test("requires a path and bounded options", () => {
  assert.throws(() => createFileTrustedSignalStore(), /filePath/);
  assert.throws(() => createFileTrustedSignalStore({
    filePath: "/tmp/test.json",
    maxRecords: 0
  }), /maxRecords/);
});

test("persists records and detects replay and conflicting event-id reuse across instances", async (t) => {
  const { filePath } = await fixture(t);
  const firstStore = createFileTrustedSignalStore({ filePath });
  const secondStore = createFileTrustedSignalStore({ filePath });
  const original = createSignal();

  assert.equal(firstStore.durable, true);
  assert.deepEqual(await firstStore.recordSignal(storeInput(original)), { recorded: true });
  assert.deepEqual(await secondStore.recordSignal(storeInput(original)), {
    recorded: false,
    reason: "signal-replay"
  });

  const conflict = createSignal({ state: "suspected" });
  assert.equal(conflict.eventId, original.eventId);
  assert.deepEqual(await secondStore.recordSignal(storeInput(conflict)), {
    recorded: false,
    reason: "signal-id-conflict"
  });

  const records = await secondStore.listSignals({
    assetId: ASSET,
    environment: ENVIRONMENT,
    sinceMs: NOW - 1
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].signal.eventId, original.eventId);
  assert.equal(records[0].signal.state, "clear");
  assert.equal(records[0].signalDigest, digest(original));
});

test("serializes concurrent claims from independent store instances", async (t) => {
  const { filePath } = await fixture(t);
  const left = createFileTrustedSignalStore({ filePath });
  const right = createFileTrustedSignalStore({ filePath });
  const input = storeInput(createSignal());

  const results = await Promise.all([
    left.recordSignal(input),
    right.recordSignal(input)
  ]);
  assert.equal(results.filter((result) => result.recorded === true).length, 1);
  assert.equal(results.filter((result) =>
    result.recorded === false && result.reason === "signal-replay"
  ).length, 1);

  const records = await left.listSignals({
    assetId: ASSET,
    environment: ENVIRONMENT,
    sinceMs: 0
  });
  assert.equal(records.length, 1);
});

test("serializes atomic replay claims across independent OS processes", async (t) => {
  const { filePath } = await fixture(t);
  const input = storeInput(createSignal());
  const results = await Promise.all([
    recordInChildProcess(filePath, input),
    recordInChildProcess(filePath, input)
  ]);

  assert.equal(results.filter((result) => result.recorded === true).length, 1);
  assert.equal(results.filter((result) =>
    result.recorded === false && result.reason === "signal-replay"
  ).length, 1);
  const records = await createFileTrustedSignalStore({ filePath }).listSignals({
    assetId: ASSET,
    environment: ENVIRONMENT,
    sinceMs: 0
  });
  assert.equal(records.length, 1);
});

test("works as the gateway's default durable replay store and survives reload", async (t) => {
  const { filePath } = await fixture(t);
  const store = createFileTrustedSignalStore({ filePath });
  const gateway = createTrustedSignalGateway({
    sources: [{
      sourceId: "guard-primary",
      engine: "security-guard",
      environment: ENVIRONMENT,
      assetIds: [ASSET],
      key: KEY
    }],
    replayStore: store,
    clock: () => NOW
  });

  assert.equal((await gateway.ingest(createSignal())).accepted, true);
  const reloadedGateway = createTrustedSignalGateway({
    sources: [{
      sourceId: "guard-primary",
      engine: "security-guard",
      environment: ENVIRONMENT,
      assetIds: [ASSET],
      key: KEY
    }],
    replayStore: createFileTrustedSignalStore({ filePath }),
    clock: () => NOW
  });

  assert.equal((await reloadedGateway.ingest(createSignal())).reason, "signal-replay");
  const state = await reloadedGateway.getSecurityState({
    assetId: ASSET,
    environment: ENVIRONMENT
  });
  assert.equal(state.state, "clear");
  assert.equal(state.authorizationGranted, false);
});

test("capacity exhaustion never evicts prior replay keys", async (t) => {
  const { filePath } = await fixture(t);
  const store = createFileTrustedSignalStore({ filePath, maxRecords: 1 });
  const first = createSignal();
  const second = createSignal({
    eventId: "00000000-0000-4000-8000-000000000002"
  });

  assert.equal((await store.recordSignal(storeInput(first))).recorded, true);
  assert.deepEqual(await store.recordSignal(storeInput(second)), {
    recorded: false,
    reason: "replay-store-capacity-exceeded"
  });
  const records = await store.listSignals({
    assetId: ASSET,
    environment: ENVIRONMENT,
    sinceMs: 0
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].signal.eventId, first.eventId);
});

test("malformed or tampered ledger data fails closed without overwriting the file", async (t) => {
  const { filePath } = await fixture(t);
  const store = createFileTrustedSignalStore({ filePath });
  const signal = createSignal();
  await store.recordSignal(storeInput(signal));

  const before = await readFile(filePath, "utf8");
  const ledger = JSON.parse(before);
  ledger.records[0].signalDigest = "0".repeat(64);
  await writeFile(filePath, JSON.stringify(ledger), "utf8");
  const tampered = await readFile(filePath, "utf8");

  await assert.rejects(
    store.listSignals({ assetId: ASSET, environment: ENVIRONMENT, sinceMs: 0 }),
    /integrity check failed/
  );
  assert.equal(await readFile(filePath, "utf8"), tampered);
});

test("ledger schema rejects duplicate replay keys", async (t) => {
  const { filePath } = await fixture(t);
  const store = createFileTrustedSignalStore({ filePath });
  const signal = createSignal();
  const input = storeInput(signal);
  const record = {
    signal,
    signalDigest: input.signalDigest,
    receivedAtMs: input.receivedAtMs,
    retentionUntilMs: input.retentionUntilMs
  };
  await writeFile(filePath, JSON.stringify({
    schema: "jb.resilience.trusted-signal-ledger/v1",
    revision: 1,
    records: [record, record]
  }), "utf8");

  await assert.rejects(
    store.listSignals({ assetId: ASSET, environment: ENVIRONMENT, sinceMs: 0 }),
    /duplicate replay keys/
  );
});
