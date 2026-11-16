import { parseStableVersion } from "./semver.js";

const ENVELOPE_KEYS = ["schema", "messageId", "correlationId", "producer", "contract", "kind", "occurredAt", "classification", "semantics", "payload"];
const PRODUCER_KEYS = ["engineId", "version"];
const CONTRACT_KEYS = ["id", "version"];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const NAMESPACE = /^jb\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const KIND = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const CLASSIFICATIONS = new Set(["public", "internal", "sensitive"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_PAYLOAD_BYTES = 65_536;
const MAX_DEPTH = 12;
const MAX_COLLECTION_SIZE = 256;

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isJsonValue(value, depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && !isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > MAX_COLLECTION_SIZE) return false;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isJsonValue(value[index], depth + 1, seen)) return false;
    }
  } else {
    seen.add(value);
    const valid = Object.entries(value).every(([key, entry]) =>
      !FORBIDDEN_KEYS.has(key) && isJsonValue(entry, depth + 1, seen));
    seen.delete(value);
    return valid;
  }
  return true;
}

export function validateMessageEnvelope(input) {
  const errors = [];
  if (!isRecord(input)) {
    return Object.freeze({ valid: false, errors: Object.freeze(["envelope must be a plain object"]) });
  }
  if (!exactKeys(input, ENVELOPE_KEYS)) errors.push("envelope has missing or unknown fields");
  if (input.schema !== "jb.engine.message/v1") errors.push("schema must be jb.engine.message/v1");
  if (typeof input.messageId !== "string" || !IDENTIFIER.test(input.messageId)) errors.push("messageId is invalid");
  if (typeof input.correlationId !== "string" || !IDENTIFIER.test(input.correlationId)) errors.push("correlationId is invalid");
  if (!isRecord(input.producer) || !exactKeys(input.producer, PRODUCER_KEYS)) {
    errors.push("producer has missing or unknown fields");
  } else {
    if (typeof input.producer.engineId !== "string" || !NAMESPACE.test(input.producer.engineId)) errors.push("producer.engineId is invalid");
    if (!parseStableVersion(input.producer.version)) errors.push("producer.version is invalid");
  }
  if (!isRecord(input.contract) || !exactKeys(input.contract, CONTRACT_KEYS)) {
    errors.push("contract has missing or unknown fields");
  } else {
    if (typeof input.contract.id !== "string" || !NAMESPACE.test(input.contract.id)) errors.push("contract.id is invalid");
    if (!parseStableVersion(input.contract.version)) errors.push("contract.version is invalid");
  }
  if (typeof input.kind !== "string" || !KIND.test(input.kind)) errors.push("kind is invalid");
  if (typeof input.occurredAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.occurredAt) ||
      !Number.isFinite(Date.parse(input.occurredAt))) errors.push("occurredAt must be an ISO-8601 timestamp with timezone");
  if (!CLASSIFICATIONS.has(input.classification)) errors.push("classification is invalid");
  if (input.semantics !== "advisory") errors.push("semantics must be advisory; messages cannot grant authority");
  if (!isRecord(input.payload)) {
    errors.push("payload must be a plain JSON object");
  } else if (!isJsonValue(input.payload)) {
    errors.push("payload must contain bounded, finite, acyclic JSON values without unsafe keys");
  } else {
    const bytes = new TextEncoder().encode(JSON.stringify(input.payload)).byteLength;
    if (bytes > MAX_PAYLOAD_BYTES) errors.push("payload exceeds the 65536-byte limit");
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function assertMessageEnvelope(input) {
  const result = validateMessageEnvelope(input);
  if (!result.valid) throw new TypeError("Invalid JB Engine message: " + result.errors.join("; "));
  return input;
}
