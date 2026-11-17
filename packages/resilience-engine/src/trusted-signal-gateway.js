import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SCHEMA = "jb.resilience.trusted-signal/v1";
const ENGINES = new Set(["security-guard", "malware-engine"]);
const STATES = new Set(["clear", "suspected", "confirmed", "tampered", "unknown"]);
const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_.:-]{1,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ENVELOPE_KEYS = [
  "schema", "eventId", "sourceId", "sourceEngine", "environment", "assetId",
  "issuedAtMs", "expiresAtMs", "state", "severity", "reasonCode",
  "evidenceRefs", "signature"
];
const UNSIGNED_KEYS = ENVELOPE_KEYS.filter((key) => key !== "signature");

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDataRecord(value, label) {
  if (!isRecord(value) || Object.getOwnPropertySymbols(value).length) {
    throw new TypeError(label + " must be a plain data object");
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " must not contain accessors or hidden fields");
    }
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new TypeError(label + " contains an unsafe property");
    }
  }
}

function assertExactKeys(value, expected, label) {
  assertDataRecord(value, label);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(label + " has missing or unsupported fields");
  }
}

function assertIdentifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(label + " has an invalid format");
  }
  return value;
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(label + " must be a non-negative safe integer timestamp");
  }
  return value;
}

function normalizeEvidenceRefs(value) {
  if (!Array.isArray(value) || value.length > 16 ||
      Object.getOwnPropertySymbols(value).length ||
      Object.keys(value).length !== value.length) {
    throw new TypeError("evidenceRefs must be a dense array containing at most 16 references");
  }
  const normalized = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("evidenceRefs must not contain holes or accessors");
    }
    const item = descriptor.value;
    assertExactKeys(item, ["refId", "sha256"], "evidenceRefs[" + index + "]");
    assertIdentifier(item.refId, ASSET_ID, "evidenceRefs[" + index + "].refId");
    if (typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) {
      throw new TypeError("evidenceRefs[" + index + "].sha256 must be a lowercase SHA-256 digest");
    }
    normalized.push(Object.freeze({ refId: item.refId, sha256: item.sha256 }));
  }
  return Object.freeze(normalized);
}

function normalizeUnsignedSignal(value) {
  assertExactKeys(value, UNSIGNED_KEYS, "trusted signal");
  if (value.schema !== SCHEMA) throw new TypeError("unsupported trusted-signal schema");
  assertIdentifier(value.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "eventId");
  assertIdentifier(value.sourceId, IDENTIFIER, "sourceId");
  if (!ENGINES.has(value.sourceEngine)) throw new TypeError("sourceEngine is not supported");
  assertIdentifier(value.environment, IDENTIFIER, "environment");
  assertIdentifier(value.assetId, ASSET_ID, "assetId");
  assertTimestamp(value.issuedAtMs, "issuedAtMs");
  assertTimestamp(value.expiresAtMs, "expiresAtMs");
  if (value.expiresAtMs <= value.issuedAtMs) {
    throw new TypeError("expiresAtMs must be later than issuedAtMs");
  }
  if (!STATES.has(value.state)) throw new TypeError("state is not supported");
  if (!SEVERITIES.has(value.severity)) throw new TypeError("severity is not supported");
  assertIdentifier(value.reasonCode, REASON_CODE, "reasonCode");
  const evidenceRefs = normalizeEvidenceRefs(value.evidenceRefs);
  if (["confirmed", "tampered"].includes(value.state) && evidenceRefs.length === 0) {
    throw new TypeError(value.state + " signals must retain at least one evidence reference");
  }
  return Object.freeze({
    schema: SCHEMA,
    eventId: value.eventId,
    sourceId: value.sourceId,
    sourceEngine: value.sourceEngine,
    environment: value.environment,
    assetId: value.assetId,
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
    state: value.state,
    severity: value.severity,
    reasonCode: value.reasonCode,
    evidenceRefs
  });
}

function signingPayload(signal) {
  return JSON.stringify({
    schema: signal.schema,
    eventId: signal.eventId,
    sourceId: signal.sourceId,
    sourceEngine: signal.sourceEngine,
    environment: signal.environment,
    assetId: signal.assetId,
    issuedAtMs: signal.issuedAtMs,
    expiresAtMs: signal.expiresAtMs,
    state: signal.state,
    severity: signal.severity,
    reasonCode: signal.reasonCode,
    evidenceRefs: signal.evidenceRefs.map((item) => ({
      refId: item.refId,
      sha256: item.sha256
    }))
  });
}

function normalizeKey(value, label) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new TypeError(label + " must contain at least 32 UTF-8 bytes");
  }
  return Buffer.from(value, "utf8");
}

function signatureFor(signal, key) {
  return createHmac("sha256", key).update(signingPayload(signal), "utf8").digest("hex");
}

function digestFor(signal) {
  return createHash("sha256")
    .update(JSON.stringify({ ...signal, evidenceRefs: signal.evidenceRefs }), "utf8")
    .digest("hex");
}

/**
 * Producer-side helper. The caller must obtain the key from its host-owned
 * secret store; this package ships no production keys or trust roots.
 */
export function signTrustedSignalEnvelope(input, signingKey) {
  const signal = normalizeUnsignedSignal(input);
  const key = normalizeKey(signingKey, "signingKey");
  return Object.freeze({ ...signal, signature: signatureFor(signal, key) });
}

/** Validate the exact v1 envelope shape and freeze its normalized contents. */
export function validateTrustedSignalEnvelope(value) {
  assertExactKeys(value, ENVELOPE_KEYS, "trusted signal");
  const unsigned = Object.create(null);
  for (const key of UNSIGNED_KEYS) unsigned[key] = value[key];
  const normalized = normalizeUnsignedSignal(unsigned);
  if (typeof value.signature !== "string" || !SHA256.test(value.signature)) {
    throw new TypeError("signature must be a lowercase HMAC-SHA-256 digest");
  }
  return Object.freeze({ ...normalized, signature: value.signature });
}

function normalizeSources(sources) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 32) {
    throw new TypeError("sources must contain between 1 and 32 trusted source definitions");
  }
  const byId = new Map();
  const normalized = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    assertExactKeys(source, ["sourceId", "engine", "environment", "assetIds", "key"], "sources[" + index + "]");
    const sourceId = assertIdentifier(source.sourceId, IDENTIFIER, "sourceId");
    if (byId.has(sourceId)) throw new TypeError("trusted source IDs must be unique");
    if (!ENGINES.has(source.engine)) throw new TypeError("trusted source engine is unsupported");
    const environment = assertIdentifier(source.environment, IDENTIFIER, "source.environment");
    if (!Array.isArray(source.assetIds) || source.assetIds.length < 1 ||
        source.assetIds.length > 256 || Object.getOwnPropertySymbols(source.assetIds).length ||
        Object.keys(source.assetIds).length !== source.assetIds.length) {
      throw new TypeError("source.assetIds must contain 1 to 256 dense exact asset IDs");
    }
    const assetValues = [];
    for (let assetIndex = 0; assetIndex < source.assetIds.length; assetIndex += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(source.assetIds, String(assetIndex));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError("source.assetIds must not contain holes or accessors");
      }
      assetValues.push(assertIdentifier(descriptor.value, ASSET_ID, "source.assetIds[]"));
    }
    if (new Set(assetValues).size !== assetValues.length) {
      throw new TypeError("source.assetIds must contain unique exact asset IDs");
    }
    const assetIds = Object.freeze(assetValues);
    const entry = Object.freeze({
      sourceId,
      engine: source.engine,
      environment,
      assetIds,
      key: normalizeKey(source.key, "source.key")
    });
    byId.set(sourceId, entry);
    normalized.push(entry);
  }
  return { byId, all: Object.freeze(normalized) };
}

function verifyEnvelope(envelope, source) {
  const expected = Buffer.from(signatureFor(envelope, source.key), "hex");
  const supplied = Buffer.from(envelope.signature, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function validStore(store) {
  return store !== null && typeof store === "object" && !Array.isArray(store) &&
    typeof store.recordSignal === "function" &&
    typeof store.listSignals === "function";
}

/**
 * Development/test-only replay store. It deliberately refuses silent eviction:
 * removing old event IDs would reopen the replay window.
 */
export function createMemoryTrustedSignalStore({ maxEntries = 10_000 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
    throw new TypeError("maxEntries must be an integer from 1 to 100000");
  }
  const records = new Map();
  return Object.freeze({
    durable: false,
    async recordSignal({ signal, signalDigest, receivedAtMs, retentionUntilMs } = {}) {
      const key = signal.sourceId + ":" + signal.eventId;
      if (records.has(key)) {
        const prior = records.get(key);
        return Object.freeze({
          recorded: false,
          reason: prior.signalDigest === signalDigest ? "signal-replay" : "signal-id-conflict"
        });
      }
      if (records.size >= maxEntries) {
        return Object.freeze({ recorded: false, reason: "replay-store-capacity-exceeded" });
      }
      records.set(key, Object.freeze({
        signal,
        signalDigest,
        receivedAtMs,
        retentionUntilMs
      }));
      return Object.freeze({ recorded: true });
    },
    async listSignals({ assetId, environment, sinceMs } = {}) {
      return Object.freeze([...records.values()]
        .filter((record) => record.signal.assetId === assetId &&
          record.signal.environment === environment &&
          record.signal.issuedAtMs >= sinceMs)
        .sort((a, b) => a.signal.issuedAtMs - b.signal.issuedAtMs ||
          a.signal.eventId.localeCompare(b.signal.eventId)));
    },
    get size() {
      return records.size;
    }
  });
}

function safeClock(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("clock must return a non-negative safe integer");
  return now;
}

function stateResult({
  state, reason, assetId, environment, sources = [], evidenceRefs = [],
  replayStoreDurable = false, observedAtMs = null, expiresAtMs = null
}) {
  const result = Object.freeze({
    schema: "jb.resilience.signal-state/v1",
    state,
    reason,
    assetId,
    environment,
    sources: Object.freeze(sources),
    evidenceRefs: Object.freeze(evidenceRefs),
    preserveEvidence: true,
    authorizationGranted: false
  });
  TRUSTED_SIGNAL_STATE_METADATA.set(result, Object.freeze({
    replayStoreDurable: replayStoreDurable === true,
    observedAtMs: Number.isSafeInteger(observedAtMs) && observedAtMs >= 0 ? observedAtMs : null,
    expiresAtMs: Number.isSafeInteger(expiresAtMs) && expiresAtMs >= 0 ? expiresAtMs : null
  }));
  return result;
}

/**
 * Returns gateway-owned trust metadata only for exact result objects created
 * by getSecurityState(). It adds no enumerable fields to the public contract.
 */
export function getTrustedSignalStateMetadata(value) {
  if (value === null || typeof value !== "object") return null;
  return TRUSTED_SIGNAL_STATE_METADATA.get(value) ?? null;
}

/**
 * Authenticates and de-duplicates Security Guard and Malware Engine signals.
 * A durable store must implement recordSignal as an atomic unique claim on
 * (sourceId,eventId), and listSignals as a consistent read of retained records.
 */
export function createTrustedSignalGateway({
  sources,
  replayStore,
  requireDurableStore = true,
  allowInMemoryStore = false,
  maxClockSkewMs = 30_000,
  maxSignalLifetimeMs = 5 * 60_000,
  historyWindowMs = 10 * 60_000,
  clock = Date.now
} = {}) {
  const registry = normalizeSources(sources);
  if (!validStore(replayStore)) {
    throw new TypeError("replayStore must implement recordSignal and listSignals");
  }
  if (typeof requireDurableStore !== "boolean" || typeof allowInMemoryStore !== "boolean") {
    throw new TypeError("store safety options must be boolean");
  }
  if (requireDurableStore && replayStore.durable !== true) {
    throw new TypeError("a durable replayStore is required");
  }
  if (!requireDurableStore && replayStore.durable !== true && allowInMemoryStore !== true) {
    throw new TypeError("in-memory replayStore requires explicit allowInMemoryStore=true");
  }
  if (!Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0 || maxClockSkewMs > 120_000 ||
      !Number.isSafeInteger(maxSignalLifetimeMs) || maxSignalLifetimeMs < 1_000 || maxSignalLifetimeMs > 15 * 60_000 ||
      !Number.isSafeInteger(historyWindowMs) || historyWindowMs < maxSignalLifetimeMs ||
      historyWindowMs > 60 * 60_000) {
    throw new TypeError("signal timing limits are outside their permitted bounds");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  function validateForSource(value, now) {
    const envelope = validateTrustedSignalEnvelope(value);
    const source = registry.byId.get(envelope.sourceId);
    if (!source) return { ok: false, reason: "untrusted-source" };
    if (envelope.sourceEngine !== source.engine ||
        envelope.environment !== source.environment ||
        !source.assetIds.includes(envelope.assetId)) {
      return { ok: false, reason: "source-scope-mismatch" };
    }
    if (!verifyEnvelope(envelope, source)) return { ok: false, reason: "invalid-signature" };
    if (envelope.expiresAtMs - envelope.issuedAtMs > maxSignalLifetimeMs) {
      return { ok: false, reason: "signal-lifetime-exceeded" };
    }
    if (envelope.issuedAtMs > now + maxClockSkewMs) {
      return { ok: false, reason: "signal-from-future" };
    }
    if (envelope.expiresAtMs <= now || now - envelope.issuedAtMs > maxSignalLifetimeMs) {
      return { ok: false, reason: "signal-expired" };
    }
    return { ok: true, envelope, source };
  }

  async function ingest(value) {
    let now;
    let verified;
    try {
      now = safeClock(clock);
      verified = validateForSource(value, now);
    } catch {
      return Object.freeze({ accepted: false, reason: "invalid-envelope" });
    }
    if (!verified.ok) return Object.freeze({ accepted: false, reason: verified.reason });

    const signalDigest = digestFor(verified.envelope);
    let claim;
    try {
      claim = await replayStore.recordSignal({
        signal: verified.envelope,
        signalDigest,
        receivedAtMs: now,
        retentionUntilMs: verified.envelope.issuedAtMs + historyWindowMs
      });
    } catch {
      return Object.freeze({ accepted: false, reason: "replay-store-unavailable" });
    }
    if (!claim || claim.recorded !== true) {
      return Object.freeze({
        accepted: false,
        reason: typeof claim?.reason === "string" ? claim.reason : "replay-claim-rejected"
      });
    }

    let afterStore;
    try {
      afterStore = safeClock(clock);
    } catch {
      return Object.freeze({ accepted: false, reason: "invalid-clock" });
    }
    if (verified.envelope.expiresAtMs <= afterStore ||
        afterStore - verified.envelope.issuedAtMs > maxSignalLifetimeMs) {
      return Object.freeze({ accepted: false, reason: "signal-expired-during-ingest" });
    }

    return Object.freeze({
      accepted: true,
      eventId: verified.envelope.eventId,
      sourceId: verified.envelope.sourceId,
      sourceEngine: verified.envelope.sourceEngine,
      assetId: verified.envelope.assetId,
      environment: verified.envelope.environment,
      expiresAtMs: verified.envelope.expiresAtMs
    });
  }

  async function getSecurityState({ assetId, environment } = {}) {
    const buildStateResult = (input) => stateResult({
      ...input,
      replayStoreDurable: replayStore.durable === true
    });
    assertIdentifier(assetId, ASSET_ID, "assetId");
    assertIdentifier(environment, IDENTIFIER, "environment");
    const matchingSources = registry.all.filter((source) =>
      source.environment === environment && source.assetIds.includes(assetId)
    );
    if (matchingSources.length === 0) {
      return buildStateResult({
        state: "unknown", reason: "no-trusted-sources-for-asset", assetId, environment
      });
    }

    let now;
    let records;
    try {
      const readStartedAt = safeClock(clock);
      records = await replayStore.listSignals({
        assetId,
        environment,
        sinceMs: Math.max(0, readStartedAt - historyWindowMs)
      });
      now = safeClock(clock);
    } catch {
      return buildStateResult({
        state: "unknown", reason: "replay-store-unavailable", assetId, environment
      });
    }
    if (!Array.isArray(records)) {
      return buildStateResult({
        state: "tampered", reason: "invalid-replay-store-response", assetId, environment
      });
    }
    if (records.length > 10_000) {
      return buildStateResult({
        state: "unknown", reason: "replay-store-result-limit-exceeded", assetId, environment
      });
    }
    if (records.length === 0) {
      return buildStateResult({
        state: "unknown", reason: "no-trusted-signals", assetId, environment
      });
    }

    const validBySource = new Map();
    const expiredSources = new Set();
    const seenEventIds = new Set();
    for (const record of records) {
      try {
        assertExactKeys(record, ["signal", "signalDigest", "receivedAtMs", "retentionUntilMs"], "replay record");
        const envelope = validateTrustedSignalEnvelope(record.signal);
        assertTimestamp(record.receivedAtMs, "receivedAtMs");
        assertTimestamp(record.retentionUntilMs, "retentionUntilMs");
        const replayKey = envelope.sourceId + ":" + envelope.eventId;
        if (seenEventIds.has(replayKey)) throw new TypeError("duplicate persisted replay key");
        seenEventIds.add(replayKey);
        if (typeof record.signalDigest !== "string" || !SHA256.test(record.signalDigest) ||
            digestFor(envelope) !== record.signalDigest) {
          throw new TypeError("persisted signal digest mismatch");
        }
        const source = registry.byId.get(envelope.sourceId);
        if (!source || source.engine !== envelope.sourceEngine ||
            source.environment !== envelope.environment ||
            !source.assetIds.includes(envelope.assetId) ||
            envelope.assetId !== assetId || envelope.environment !== environment ||
            !verifyEnvelope(envelope, source) ||
            envelope.expiresAtMs - envelope.issuedAtMs > maxSignalLifetimeMs ||
            envelope.issuedAtMs > now + maxClockSkewMs ||
            record.retentionUntilMs < envelope.expiresAtMs ||
            record.receivedAtMs < envelope.issuedAtMs - maxClockSkewMs ||
            record.receivedAtMs > now + maxClockSkewMs) {
          throw new TypeError("persisted signal provenance or timing mismatch");
        }
        if (envelope.expiresAtMs <= now ||
            now - envelope.issuedAtMs > maxSignalLifetimeMs) {
          expiredSources.add(envelope.sourceId);
          continue;
        }
        if (!validBySource.has(envelope.sourceId)) validBySource.set(envelope.sourceId, []);
        validBySource.get(envelope.sourceId).push(envelope);
      } catch {
        return buildStateResult({
          state: "tampered",
          reason: "persisted-signal-integrity-failure",
          assetId,
          environment
        });
      }
    }

    const latest = [];
    const missing = [];
    for (const source of matchingSources) {
      const events = validBySource.get(source.sourceId) ?? [];
      if (events.length === 0) {
        missing.push(source.sourceId);
        continue;
      }
      events.sort((a, b) => b.issuedAtMs - a.issuedAtMs || a.eventId.localeCompare(b.eventId));
      const newestTimestamp = events[0].issuedAtMs;
      const sameTime = events.filter((item) => item.issuedAtMs === newestTimestamp);
      if (new Set(sameTime.map((item) => item.state)).size > 1) {
        return buildStateResult({
          state: "conflicting",
          reason: "same-source-conflicting-signals",
          assetId,
          environment,
          sources: sameTime.map((item) => Object.freeze({
            sourceId: item.sourceId,
            sourceEngine: item.sourceEngine,
            state: item.state,
            issuedAtMs: item.issuedAtMs,
            reasonCode: item.reasonCode
          }))
        });
      }
      latest.push(events[0]);
    }

    if (missing.length > 0) {
      const expired = missing.some((sourceId) => expiredSources.has(sourceId));
      return buildStateResult({
        state: expired ? "stale" : "unknown",
        reason: expired ? "required-source-signal-expired" : "required-source-signal-missing",
        assetId,
        environment,
        sources: latest.map((item) => Object.freeze({
          sourceId: item.sourceId,
          sourceEngine: item.sourceEngine,
          state: item.state,
          issuedAtMs: item.issuedAtMs,
          reasonCode: item.reasonCode
        }))
      });
    }

    const states = new Set(latest.map((item) => item.state));
    let state;
    let reason;
    if (states.has("tampered")) {
      state = "tampered";
      reason = "source-reported-tampering";
    } else if (states.has("unknown")) {
      state = "unknown";
      reason = "source-reported-unknown";
    } else if (states.has("clear") && [...states].some((item) => item !== "clear")) {
      state = "conflicting";
      reason = "trusted-sources-disagree";
    } else if (states.has("confirmed")) {
      state = "confirmed";
      reason = "trusted-source-confirmed-threat";
    } else if (states.has("suspected")) {
      state = "suspected";
      reason = "trusted-source-suspected-threat";
    } else {
      state = "clear";
      reason = "all-required-sources-clear";
    }

    const evidenceRefs = [];
    const seenEvidence = new Set();
    for (const item of latest) {
      for (const evidence of item.evidenceRefs) {
        const key = evidence.refId + ":" + evidence.sha256;
        if (!seenEvidence.has(key) && evidenceRefs.length < 32) {
          seenEvidence.add(key);
          evidenceRefs.push(evidence);
        }
      }
    }
    return buildStateResult({
      state,
      reason,
      assetId,
      environment,
      sources: latest.map((item) => Object.freeze({
        sourceId: item.sourceId,
        sourceEngine: item.sourceEngine,
        state: item.state,
        severity: item.severity,
        issuedAtMs: item.issuedAtMs,
        reasonCode: item.reasonCode
      })),
      evidenceRefs,
      observedAtMs: Math.min(...latest.map((item) => item.issuedAtMs)),
      expiresAtMs: Math.min(...latest.map((item) => item.expiresAtMs))
    });
  }

  return Object.freeze({
    engine: "JB Resilience Engine",
    version: "0.4.0",
    module: "Trusted Signal Gateway",
    mode: "signal-ingress-only",
    ingest,
    getSecurityState
  });
}
