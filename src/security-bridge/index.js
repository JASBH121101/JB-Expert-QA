import { createServer } from "node:http";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const SECURITY_BRIDGE_PROTOCOL = "jb.security.assessment/v1";
export const SECURITY_BRIDGE_DECISION_SCHEMA = "jb.security.decision/v1";
export const SECURITY_BRIDGE_PRODUCERS = Object.freeze(["jb-expert-qa", "jb-security-guard"]);

const SEVERITY_RANK = Object.freeze({ info: 0, low: 1, medium: 2, high: 3, critical: 4 });
const VERDICT_RANK = Object.freeze({ pass: 0, review: 1, quarantine: 2, block: 3 });
const DEFAULT_REQUIRED_PRODUCERS = SECURITY_BRIDGE_PRODUCERS;
const DEFAULT_RETENTION_MS = 15 * 60_000;
const DEFAULT_MAX_CORRELATIONS = 5_000;
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 8 * 1024;

export class SecurityBridgeError extends Error {
  constructor(code) {
    super("JB Security Bridge: " + code.toLowerCase().replaceAll("_", " "));
    this.name = "SecurityBridgeError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, name) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new SecurityBridgeError("INVALID_" + name.toUpperCase());
  }
}

function validIdentifier(value) {
  return typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function validTimestamp(value) {
  return typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value;
}

function validateSecret(secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new TypeError("Security Bridge secret must contain at least 32 UTF-8 bytes");
  }
}

export function createSecurityAssessment(input = {}) {
  if (!isRecord(input)) throw new SecurityBridgeError("INVALID_ASSESSMENT");
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now must be a non-negative safe integer");

  const assessment = {
    schema: SECURITY_BRIDGE_PROTOCOL,
    eventId: input.eventId ?? randomUUID(),
    correlationId: input.correlationId,
    producer: input.producer,
    verdict: input.verdict,
    severity: input.severity,
    reasonCode: input.reasonCode,
    observedAt: input.observedAt ?? new Date(now).toISOString(),
    evidence: input.evidence ?? {}
  };
  return validateSecurityAssessment(assessment);
}

export function validateSecurityAssessment(input) {
  exactKeys(input, [
    "schema", "eventId", "correlationId", "producer", "verdict",
    "severity", "reasonCode", "observedAt", "evidence"
  ], "assessment");

  if (input.schema !== SECURITY_BRIDGE_PROTOCOL ||
      !validIdentifier(input.eventId) ||
      !validIdentifier(input.correlationId) ||
      !SECURITY_BRIDGE_PRODUCERS.includes(input.producer) ||
      !Object.hasOwn(VERDICT_RANK, input.verdict) ||
      !Object.hasOwn(SEVERITY_RANK, input.severity) ||
      typeof input.reasonCode !== "string" ||
      !/^[A-Z][A-Z0-9_.:-]{2,63}$/.test(input.reasonCode) ||
      !validTimestamp(input.observedAt)) {
    throw new SecurityBridgeError("INVALID_ASSESSMENT");
  }

  const evidence = input.evidence;
  exactKeys(evidence, ["sha256"], "evidence");
  if (evidence.sha256 !== undefined &&
      (typeof evidence.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.sha256))) {
    throw new SecurityBridgeError("INVALID_EVIDENCE");
  }

  return Object.freeze({
    schema: SECURITY_BRIDGE_PROTOCOL,
    eventId: input.eventId,
    correlationId: input.correlationId,
    producer: input.producer,
    verdict: input.verdict,
    severity: input.severity,
    reasonCode: input.reasonCode,
    observedAt: input.observedAt,
    evidence: Object.freeze(evidence.sha256 ? { sha256: evidence.sha256 } : {})
  });
}

function signatureInput(assessment, sentAt) {
  return Buffer.from(JSON.stringify({ assessment, sentAt }), "utf8");
}

export function signSecurityAssessment(assessmentInput, secret, sentAt = new Date().toISOString()) {
  validateSecret(secret);
  const assessment = validateSecurityAssessment(assessmentInput);
  if (!validTimestamp(sentAt)) throw new SecurityBridgeError("INVALID_TIMESTAMP");
  const signature = createHmac("sha256", secret)
    .update(signatureInput(assessment, sentAt))
    .digest("hex");
  return Object.freeze({ assessment, sentAt, signature });
}

export function verifySecurityAssessmentEnvelope(envelope, secret, {
  now = Date.now(),
  maxClockSkewMs = 60_000
} = {}) {
  validateSecret(secret);
  exactKeys(envelope, ["assessment", "sentAt", "signature"], "envelope");
  const assessment = validateSecurityAssessment(envelope.assessment);
  if (!validTimestamp(envelope.sentAt) ||
      typeof envelope.signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(envelope.signature)) {
    throw new SecurityBridgeError("INVALID_ENVELOPE");
  }
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0 ||
      Math.abs(now - Date.parse(envelope.sentAt)) > maxClockSkewMs) {
    throw new SecurityBridgeError("EXPIRED_ENVELOPE");
  }

  const expected = createHmac("sha256", secret)
    .update(signatureInput(assessment, envelope.sentAt))
    .digest();
  const supplied = Buffer.from(envelope.signature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new SecurityBridgeError("INVALID_SIGNATURE");
  }
  return assessment;
}

function safeNotify(callback, value) {
  try {
    const result = callback(value);
    if (result && typeof result.then === "function") result.catch(() => {});
  } catch {
    // Observability must not alter a security decision.
  }
}

function compareAssessment(current, incoming) {
  const currentVerdict = VERDICT_RANK[current.verdict];
  const incomingVerdict = VERDICT_RANK[incoming.verdict];
  if (incomingVerdict !== currentVerdict) return incomingVerdict > currentVerdict ? incoming : current;
  return SEVERITY_RANK[incoming.severity] > SEVERITY_RANK[current.severity] ? incoming : current;
}

function buildDecision(record, requiredProducers, now) {
  const assessments = requiredProducers
    .filter((producer) => record.byProducer.has(producer))
    .map((producer) => record.byProducer.get(producer))
    .map((item) => Object.freeze({
      producer: item.producer,
      verdict: item.verdict,
      severity: item.severity,
      reasonCode: item.reasonCode,
      observedAt: item.observedAt,
      evidence: item.evidence
    }));
  const missingProducers = requiredProducers.filter((producer) => !record.byProducer.has(producer));
  const complete = missingProducers.length === 0;

  let action = "allow";
  if (assessments.some((item) => item.verdict === "block" || item.severity === "critical")) {
    action = "block";
  } else if (assessments.some((item) => item.verdict === "quarantine")) {
    action = "quarantine";
  } else if (assessments.some((item) => item.verdict === "review" || item.severity === "high")) {
    action = "review";
  } else if (!complete || assessments.some((item) => item.verdict !== "pass")) {
    action = "review";
  }

  return Object.freeze({
    schema: SECURITY_BRIDGE_DECISION_SCHEMA,
    correlationId: record.correlationId,
    action,
    status: complete ? "complete" : "pending",
    requiredProducers: Object.freeze([...requiredProducers]),
    missingProducers: Object.freeze(missingProducers),
    assessments: Object.freeze(assessments),
    evaluatedAt: new Date(now).toISOString()
  });
}

export function createSecurityBridgeCoordinator(options = {}) {
  if (!isRecord(options)) throw new TypeError("coordinator options must be an object");
  const allowed = ["requiredProducers", "retentionMs", "maxCorrelations", "maxEvents", "clock", "onDecision"];
  if (Object.keys(options).some((key) => !allowed.includes(key))) {
    throw new TypeError("Unknown Security Bridge coordinator option");
  }

  const requiredProducers = Object.freeze([...(options.requiredProducers ?? DEFAULT_REQUIRED_PRODUCERS)]);
  if (requiredProducers.length !== 2 ||
      new Set(requiredProducers).size !== 2 ||
      requiredProducers.some((item) => !SECURITY_BRIDGE_PRODUCERS.includes(item))) {
    throw new TypeError("requiredProducers must contain both supported producers exactly once");
  }
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxCorrelations = options.maxCorrelations ?? DEFAULT_MAX_CORRELATIONS;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const clock = options.clock ?? Date.now;
  const onDecision = options.onDecision ?? (() => {});
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 60_000 ||
      !Number.isSafeInteger(maxCorrelations) || maxCorrelations < 1 ||
      !Number.isSafeInteger(maxEvents) || maxEvents < 1 ||
      typeof clock !== "function" || typeof onDecision !== "function") {
    throw new TypeError("Invalid Security Bridge coordinator configuration");
  }

  const correlations = new Map();
  const seenEvents = new Map();

  function currentTime() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new SecurityBridgeError("INVALID_CLOCK");
    return value;
  }

  function prune(now) {
    for (const [key, record] of correlations) {
      if (now - record.lastSeenAt > retentionMs) correlations.delete(key);
    }
    for (const [eventId, item] of seenEvents) {
      if (item.expiresAt <= now) seenEvents.delete(eventId);
    }
  }

  function getDecision(correlationId) {
    if (!validIdentifier(correlationId)) throw new SecurityBridgeError("INVALID_CORRELATION_ID");
    const now = currentTime();
    prune(now);
    const record = correlations.get(correlationId);
    return record ? buildDecision(record, requiredProducers, now) : null;
  }

  function submit(assessmentInput) {
    const assessment = validateSecurityAssessment(assessmentInput);
    if (!requiredProducers.includes(assessment.producer)) {
      throw new SecurityBridgeError("UNEXPECTED_PRODUCER");
    }
    const now = currentTime();
    prune(now);
    const digest = createHash("sha256").update(JSON.stringify(assessment)).digest("hex");
    const seen = seenEvents.get(assessment.eventId);
    if (seen) {
      if (seen.digest !== digest) throw new SecurityBridgeError("EVENT_ID_CONFLICT");
      return getDecision(assessment.correlationId);
    }
    if (seenEvents.size >= maxEvents) throw new SecurityBridgeError("CAPACITY_REACHED");

    let record = correlations.get(assessment.correlationId);
    if (!record && correlations.size >= maxCorrelations) {
      throw new SecurityBridgeError("CAPACITY_REACHED");
    }

    if (!record) {
      record = { correlationId: assessment.correlationId, byProducer: new Map(), lastSeenAt: now };
      correlations.set(assessment.correlationId, record);
    }

    const incomingHash = assessment.evidence.sha256;
    if (incomingHash) {
      for (const existing of record.byProducer.values()) {
        const existingHash = existing.evidence.sha256;
        if (existingHash && existingHash !== incomingHash) {
          throw new SecurityBridgeError("RESOURCE_MISMATCH");
        }
      }
    }

    const current = record.byProducer.get(assessment.producer);
    record.byProducer.set(
      assessment.producer,
      current ? compareAssessment(current, assessment) : assessment
    );
    record.lastSeenAt = now;
    seenEvents.set(assessment.eventId, { digest, expiresAt: now + retentionMs });

    const decision = buildDecision(record, requiredProducers, now);
    safeNotify(onDecision, decision);
    return decision;
  }

  return Object.freeze({
    submit,
    getDecision,
    getStats() {
      const now = currentTime();
      prune(now);
      return Object.freeze({
        correlations: correlations.size,
        seenEvents: seenEvents.size,
        maxCorrelations,
        maxEvents
      });
    }
  });
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  });
  response.end(body);
}

async function readBoundedBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new SecurityBridgeError("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function createSecurityBridgeServer(options = {}) {
  if (!isRecord(options)) throw new TypeError("server options must be an object");
  const allowed = ["coordinator", "secrets", "port", "maxBodyBytes", "maxClockSkewMs", "clock"];
  if (Object.keys(options).some((key) => !allowed.includes(key))) {
    throw new TypeError("Unknown Security Bridge server option");
  }
  if (!options.coordinator || typeof options.coordinator.submit !== "function") {
    throw new TypeError("coordinator must implement submit(assessment)");
  }
  if (!isRecord(options.secrets)) throw new TypeError("secrets must be a producer-to-secret object");
  for (const producer of SECURITY_BRIDGE_PRODUCERS) {
    if (options.secrets[producer] !== undefined) validateSecret(options.secrets[producer]);
  }
  if (!options.secrets["jb-security-guard"]) {
    throw new TypeError("A dedicated jb-security-guard secret is required");
  }

  const port = options.port ?? 0;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxClockSkewMs = options.maxClockSkewMs ?? 60_000;
  const clock = options.clock ?? Date.now;
  if (!Number.isInteger(port) || port < 0 || port > 65_535 ||
      !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 64 * 1024 ||
      !Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0 ||
      typeof clock !== "function") {
    throw new TypeError("Invalid Security Bridge server configuration");
  }

  const server = createServer(async (request, response) => {
    if (!isLoopback(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: "loopback_only" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/assessments") {
      sendJson(response, request.method === "POST" ? 404 : 405, { error: "not_found" });
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
      sendJson(response, 415, { error: "content_type_required" });
      return;
    }

    try {
      const rawBody = await readBoundedBody(request, maxBodyBytes);
      let envelope;
      try {
        envelope = JSON.parse(rawBody);
      } catch {
        throw new SecurityBridgeError("INVALID_JSON");
      }
      const producer = envelope?.assessment?.producer;
      const secret = options.secrets[producer];
      if (typeof secret !== "string") throw new SecurityBridgeError("INVALID_SIGNATURE");
      const assessment = verifySecurityAssessmentEnvelope(envelope, secret, {
        now: clock(),
        maxClockSkewMs
      });
      const decision = options.coordinator.submit(assessment);
      sendJson(response, 200, { decision });
    } catch (error) {
      const code = error instanceof SecurityBridgeError ? error.code : "INTERNAL_ERROR";
      const status = code === "INVALID_SIGNATURE" || code === "EXPIRED_ENVELOPE" ? 401
        : code === "CAPACITY_REACHED" ? 503
        : code === "EVENT_ID_CONFLICT" || code === "RESOURCE_MISMATCH" ? 409
        : code === "INTERNAL_ERROR" ? 500
        : code === "BODY_TOO_LARGE" ? 413
        : 400;
      sendJson(response, status, { error: code.toLowerCase() });
    }
  });

  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.maxHeadersCount = 20;

  let listening = false;
  return Object.freeze({
    listen() {
      if (listening) return Promise.reject(new SecurityBridgeError("ALREADY_LISTENING"));
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", onError);
          listening = true;
          resolve(Object.freeze({ host: "127.0.0.1", port: server.address().port }));
        });
      });
    },
    close() {
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
    address() {
      const address = server.address();
      return address && typeof address === "object"
        ? Object.freeze({ host: address.address, port: address.port })
        : null;
    },
    getStats() {
      return Object.freeze({ listening: server.listening, ...options.coordinator.getStats() });
    }
  });
}
