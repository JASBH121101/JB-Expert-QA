import { parseStableVersion } from "./semver.js";

const ENGINE_ID = /^jb\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const CONTRACT_ID = /^jb\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const ROOT_KEYS = ["schema", "engineId", "version", "contractsProvided", "contractsConsumed", "dependencies", "capabilities"];
const CONTRACT_KEYS = ["id", "version"];
const CONSUMED_CONTRACT_KEYS = ["id", "minVersion", "maxMajor"];
const DEPENDENCY_KEYS = ["engineId", "minVersion", "maxMajor", "optional"];

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function unique(values) {
  return new Set(values).size === values.length;
}

export function validateEngineManifest(input) {
  const errors = [];
  if (!isRecord(input)) {
    return Object.freeze({ valid: false, errors: Object.freeze(["manifest must be a plain object"]) });
  }
  if (!exactKeys(input, ROOT_KEYS)) errors.push("manifest has missing or unknown fields");
  if (input.schema !== "jb.engine.manifest/v1") errors.push("schema must be jb.engine.manifest/v1");
  if (typeof input.engineId !== "string" || !ENGINE_ID.test(input.engineId)) errors.push("engineId is invalid");
  if (!parseStableVersion(input.version)) errors.push("version must use stable MAJOR.MINOR.PATCH syntax");

  for (const field of ["contractsProvided", "contractsConsumed", "dependencies", "capabilities"]) {
    if (!Array.isArray(input[field])) errors.push(field + " must be an array");
    else if (input[field].length > 64) errors.push(field + " exceeds the 64-entry limit");
  }

  if (Array.isArray(input.contractsProvided)) {
    const ids = [];
    for (const [index, entry] of input.contractsProvided.entries()) {
      if (!isRecord(entry) || !exactKeys(entry, CONTRACT_KEYS)) {
        errors.push("contractsProvided[" + index + "] has missing or unknown fields");
        continue;
      }
      if (typeof entry.id !== "string" || !CONTRACT_ID.test(entry.id)) errors.push("contractsProvided[" + index + "].id is invalid");
      else ids.push(entry.id);
      if (!parseStableVersion(entry.version)) errors.push("contractsProvided[" + index + "].version is invalid");
    }
    if (!unique(ids)) errors.push("contractsProvided contains duplicate contract IDs");
  }

  if (Array.isArray(input.contractsConsumed)) {
    const ids = [];
    for (const [index, entry] of input.contractsConsumed.entries()) {
      if (!isRecord(entry) || !exactKeys(entry, CONSUMED_CONTRACT_KEYS)) {
        errors.push("contractsConsumed[" + index + "] has missing or unknown fields");
        continue;
      }
      if (typeof entry.id !== "string" || !CONTRACT_ID.test(entry.id)) errors.push("contractsConsumed[" + index + "].id is invalid");
      else ids.push(entry.id);
      if (!parseStableVersion(entry.minVersion)) errors.push("contractsConsumed[" + index + "].minVersion is invalid");
      if (!Number.isSafeInteger(entry.maxMajor) || entry.maxMajor < 1) errors.push("contractsConsumed[" + index + "].maxMajor is invalid");
    }
    if (!unique(ids)) errors.push("contractsConsumed contains duplicate contract IDs");
  }

  if (Array.isArray(input.dependencies)) {
    const ids = [];
    for (const [index, entry] of input.dependencies.entries()) {
      if (!isRecord(entry) || !exactKeys(entry, DEPENDENCY_KEYS)) {
        errors.push("dependencies[" + index + "] has missing or unknown fields");
        continue;
      }
      if (typeof entry.engineId !== "string" || !ENGINE_ID.test(entry.engineId)) errors.push("dependencies[" + index + "].engineId is invalid");
      else {
        ids.push(entry.engineId);
        if (entry.engineId === input.engineId) errors.push("engine cannot depend on itself");
      }
      if (!parseStableVersion(entry.minVersion)) errors.push("dependencies[" + index + "].minVersion is invalid");
      if (!Number.isSafeInteger(entry.maxMajor) || entry.maxMajor < 1) errors.push("dependencies[" + index + "].maxMajor is invalid");
      if (typeof entry.optional !== "boolean") errors.push("dependencies[" + index + "].optional must be boolean");
    }
    if (!unique(ids)) errors.push("dependencies contains duplicate engine IDs");
  }

  if (Array.isArray(input.capabilities)) {
    if (input.capabilities.some((value) => typeof value !== "string" || !CAPABILITY_ID.test(value))) {
      errors.push("capabilities contains an invalid capability identifier");
    }
    if (!unique(input.capabilities)) errors.push("capabilities contains duplicates");
  }

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function assertEngineManifest(input) {
  const result = validateEngineManifest(input);
  if (!result.valid) throw new TypeError("Invalid JB Engine manifest: " + result.errors.join("; "));
  return input;
}
