import { signTrustedSignalEnvelope } from "../trusted-signal-gateway.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeProducerOptions(options, expectedEngine) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("producer options must be an object");
  }
  const allowed = new Set([
    "sourceId", "environment", "assetId", "signingKey", "ttlMs", "idGenerator"
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("unsupported producer option: " + key);
  }
  if (typeof options.sourceId !== "string" || !IDENTIFIER.test(options.sourceId)) {
    throw new TypeError("sourceId is invalid");
  }
  if (typeof options.environment !== "string" || !IDENTIFIER.test(options.environment)) {
    throw new TypeError("environment is invalid");
  }
  if (typeof options.assetId !== "string" || !ASSET_ID.test(options.assetId)) {
    throw new TypeError("assetId is invalid");
  }
  if (typeof options.signingKey !== "string" || Buffer.byteLength(options.signingKey, "utf8") < 32) {
    throw new TypeError("signingKey must contain at least 32 UTF-8 bytes from host-owned secret storage");
  }
  const ttlMs = options.ttlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 5 * 60_000) {
    throw new TypeError("ttlMs must be an integer from 1000 to 300000");
  }
  const idGenerator = options.idGenerator;
  if (idGenerator !== undefined && typeof idGenerator !== "function") {
    throw new TypeError("idGenerator must be a function");
  }
  return Object.freeze({
    sourceId: options.sourceId,
    sourceEngine: expectedEngine,
    environment: options.environment,
    assetId: options.assetId,
    signingKey: options.signingKey,
    ttlMs,
    idGenerator
  });
}

export function signProducerSignal(config, {
  eventId,
  issuedAtMs,
  state,
  severity,
  reasonCode,
  evidenceRefs = []
}) {
  if (typeof eventId !== "string" || !UUID.test(eventId)) {
    throw new TypeError("producer eventId must be a UUID");
  }
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0 ||
      !Number.isSafeInteger(issuedAtMs + config.ttlMs)) {
    throw new TypeError("producer timestamp is invalid");
  }
  return signTrustedSignalEnvelope({
    schema: "jb.resilience.trusted-signal/v1",
    eventId,
    sourceId: config.sourceId,
    sourceEngine: config.sourceEngine,
    environment: config.environment,
    assetId: config.assetId,
    issuedAtMs,
    expiresAtMs: issuedAtMs + config.ttlMs,
    state,
    severity,
    reasonCode,
    evidenceRefs
  }, config.signingKey);
}

export function isUuid(value) {
  return typeof value === "string" && UUID.test(value);
}
