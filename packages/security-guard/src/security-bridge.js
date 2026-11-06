import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const PROTOCOL = "jb.security.assessment/v1";
const DECISION_SCHEMA = "jb.security.decision/v1";
const PRODUCERS = Object.freeze(["jb-expert-qa", "jb-security-guard"]);
const VERDICTS = new Set(["pass", "review", "quarantine", "block"]);
const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);

export class SecurityBridgeClientError extends Error {
  constructor(code) {
    super("JB Security Bridge client: " + code.toLowerCase().replaceAll("_", " "));
    this.name = "SecurityBridgeClientError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value) {
  return typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value;
}

function validIdentifier(value) {
  return typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function validateSecret(secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new TypeError("Security Bridge secret must contain at least 32 UTF-8 bytes");
  }
}

function makeAssessment(input, now) {
  if (!isRecord(input) ||
      Object.keys(input).some((key) => ![
        "eventId", "correlationId", "verdict", "severity", "reasonCode", "observedAt", "evidence"
      ].includes(key))) {
    throw new SecurityBridgeClientError("INVALID_ASSESSMENT");
  }

  const evidence = input.evidence ?? {};
  if (!isRecord(evidence) || Object.keys(evidence).some((key) => key !== "sha256") ||
      (evidence.sha256 !== undefined &&
       (typeof evidence.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.sha256)))) {
    throw new SecurityBridgeClientError("INVALID_EVIDENCE");
  }

  const assessment = {
    schema: PROTOCOL,
    eventId: input.eventId ?? randomUUID(),
    correlationId: input.correlationId,
    producer: "jb-security-guard",
    verdict: input.verdict,
    severity: input.severity,
    reasonCode: input.reasonCode,
    observedAt: input.observedAt ?? new Date(now).toISOString(),
    evidence: evidence.sha256 ? { sha256: evidence.sha256 } : {}
  };

  if (!validIdentifier(assessment.eventId) ||
      !validIdentifier(assessment.correlationId) ||
      !VERDICTS.has(assessment.verdict) ||
      !SEVERITIES.has(assessment.severity) ||
      typeof assessment.reasonCode !== "string" ||
      !/^[A-Z][A-Z0-9_.:-]{2,63}$/.test(assessment.reasonCode) ||
      !validTimestamp(assessment.observedAt)) {
    throw new SecurityBridgeClientError("INVALID_ASSESSMENT");
  }
  return Object.freeze({ ...assessment, evidence: Object.freeze(assessment.evidence) });
}

function signAssessment(assessment, secret, sentAt) {
  const signature = createHmac("sha256", secret)
    .update(Buffer.from(JSON.stringify({ assessment, sentAt }), "utf8"))
    .digest("hex");
  return Object.freeze({ assessment, sentAt, signature });
}

function verifyDecisionEnvelope(envelope, secret, now, maxClockSkewMs) {
  if (!isRecord(envelope) ||
      Object.keys(envelope).some((key) => !["decision", "sentAt", "signature"].includes(key)) ||
      !isRecord(envelope.decision) ||
      envelope.decision.schema !== DECISION_SCHEMA ||
      !validIdentifier(envelope.decision.correlationId) ||
      !["allow", "block", "quarantine", "review"].includes(envelope.decision.action) ||
      !["complete", "pending"].includes(envelope.decision.status) ||
      !Array.isArray(envelope.decision.requiredProducers) ||
      !Array.isArray(envelope.decision.missingProducers) ||
      !Array.isArray(envelope.decision.assessments) ||
      !validTimestamp(envelope.sentAt) ||
      typeof envelope.signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(envelope.signature)) {
    throw new SecurityBridgeClientError("INVALID_DECISION");
  }
  if (Math.abs(now - Date.parse(envelope.sentAt)) > maxClockSkewMs) {
    throw new SecurityBridgeClientError("EXPIRED_DECISION");
  }

  const expected = createHmac("sha256", secret)
    .update(Buffer.from(JSON.stringify({ decision: envelope.decision, sentAt: envelope.sentAt }), "utf8"))
    .digest();
  const supplied = Buffer.from(envelope.signature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new SecurityBridgeClientError("INVALID_DECISION_SIGNATURE");
  }

  const decision = envelope.decision;
  if (decision.requiredProducers.length !== 2 ||
      new Set(decision.requiredProducers).size !== 2 ||
      PRODUCERS.some((producer) => !decision.requiredProducers.includes(producer)) ||
      decision.missingProducers.some((producer) => !PRODUCERS.includes(producer))) {
    throw new SecurityBridgeClientError("INVALID_DECISION");
  }
  if (decision.action === "allow") {
    const passed = new Set(decision.assessments
      .filter((item) => isRecord(item) && item.verdict === "pass" &&
        !["high", "critical"].includes(item.severity))
      .map((item) => item.producer));
    if (decision.status !== "complete" || decision.missingProducers.length !== 0 ||
        PRODUCERS.some((producer) => !passed.has(producer))) {
      throw new SecurityBridgeClientError("INVALID_ALLOW_DECISION");
    }
  }
  return Object.freeze(decision);
}

export function createSecurityBridgeClient(options = {}) {
  if (!isRecord(options)) throw new TypeError("Security Bridge client options must be an object");
  const allowed = ["url", "secret", "timeoutMs", "fetchImpl", "clock", "maxClockSkewMs"];
  if (Object.keys(options).some((key) => !allowed.includes(key))) {
    throw new TypeError("Unknown Security Bridge client option");
  }
  validateSecret(options.secret);

  let endpoint;
  try {
    endpoint = new URL(options.url);
  } catch {
    throw new TypeError("Security Bridge URL must be an explicit loopback HTTP URL");
  }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
      !endpoint.port || !["", "/"].includes(endpoint.pathname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError("Security Bridge client only permits an explicit 127.0.0.1 HTTP endpoint");
  }
  endpoint.pathname = "/v1/assessments";

  const timeoutMs = options.timeoutMs ?? 3_000;
  const maxClockSkewMs = options.maxClockSkewMs ?? 60_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = options.clock ?? Date.now;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000 ||
      !Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0 ||
      typeof fetchImpl !== "function" || typeof clock !== "function") {
    throw new TypeError("Invalid Security Bridge client configuration");
  }

  async function submitAssessment(input) {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new SecurityBridgeClientError("INVALID_CLOCK");
    const assessment = makeAssessment(input, now);
    const sentAt = new Date(now).toISOString();
    const envelope = signAssessment(assessment, options.secret, sentAt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(endpoint.href, {
          method: "POST",
          headers: { "content-type": "application/json", "accept": "application/json" },
          body: JSON.stringify(envelope),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal
        });
      } catch {
        throw new SecurityBridgeClientError(controller.signal.aborted ? "BRIDGE_TIMEOUT" : "BRIDGE_UNAVAILABLE");
      }
      if (!response || response.ok !== true || typeof response.json !== "function") {
        throw new SecurityBridgeClientError("BRIDGE_REJECTED");
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new SecurityBridgeClientError("INVALID_RESPONSE");
      }
      const decision = verifyDecisionEnvelope(body, options.secret, clock(), maxClockSkewMs);
      if (decision.correlationId !== assessment.correlationId) {
        throw new SecurityBridgeClientError("CORRELATION_MISMATCH");
      }
      if (decision.action === "allow") {
        const guardResult = decision.assessments.find((item) =>
          item.producer === "jb-security-guard"
        );
        if (!guardResult || guardResult.evidence?.sha256 !== assessment.evidence.sha256) {
          throw new SecurityBridgeClientError("RESOURCE_MISMATCH");
        }
      }
      return decision;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({ submitAssessment });
}
