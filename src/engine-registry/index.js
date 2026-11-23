const CONTRACT = "jb.qa-engine-adapter/v1";
const MAX_ADAPTERS = 256;
const MAX_CAPABILITIES = 64;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;

const TARGET_TYPES = new Set(["path", "url", "path-or-url", "payload", "none"]);
const EXECUTION_MODES = new Set(["in-process", "browser", "local-process", "remote"]);
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\\.(0|[1-9]\d*)\\.(0|[1-9]\d*)$/;

export const QA_ENGINE_ADAPTER_CONTRACT = CONTRACT;

export class QaEngineRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QaEngineRegistryError";
    this.code = code;
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRecord(value, label, allowedKeys) {
  if (!isPlainRecord(value)) {
    throw new QaEngineRegistryError("INVALID_RECORD", label + " must be a plain object");
  }

  const record = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new QaEngineRegistryError("UNSUPPORTED_FIELD", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new QaEngineRegistryError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    record[key] = descriptor.value;
  }
  return record;
}

function requiredString(value, label, maxLength, pattern) {
  if (typeof value !== "string") {
    throw new QaEngineRegistryError("INVALID_FIELD", label + " must be a string");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new QaEngineRegistryError("INVALID_FIELD", label + " is empty or exceeds its safe length");
  }
  if (pattern && !pattern.test(normalized)) {
    throw new QaEngineRegistryError("INVALID_FIELD", label + " has an invalid format");
  }
  return normalized;
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CAPABILITIES) {
    throw new QaEngineRegistryError("INVALID_CAPABILITIES", "capabilities must contain between 1 and 64 identifiers");
  }
  const capabilities = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new QaEngineRegistryError("ACCESSOR_NOT_ALLOWED", "capabilities cannot contain holes or accessors");
    }
    const normalized = requiredString(descriptor.value, "capability", 64, LABEL_PATTERN);
    if (seen.has(normalized)) {
      throw new QaEngineRegistryError("DUPLICATE_CAPABILITY", "capabilities cannot contain duplicates");
    }
    seen.add(normalized);
    capabilities.push(normalized);
  }
  return Object.freeze(capabilities);
}

function normalizeAdapter(input) {
  const adapter = readRecord(input, "adapter", new Set([
    "id", "name", "version", "category", "targetType",
    "executionMode", "capabilities", "description", "run"
  ]));
  const required = [
    "id", "name", "version", "category", "targetType",
    "executionMode", "capabilities", "run"
  ];
  for (const key of required) {
    if (!Object.hasOwn(adapter, key)) {
      throw new QaEngineRegistryError("MISSING_FIELD", "adapter." + key + " is required");
    }
  }

  const id = requiredString(adapter.id, "adapter.id", 128, ID_PATTERN);
  const name = requiredString(adapter.name, "adapter.name", MAX_NAME_LENGTH);
  const version = requiredString(adapter.version, "adapter.version", 32, VERSION_PATTERN);
  const category = requiredString(adapter.category, "adapter.category", 64, LABEL_PATTERN);
  const targetType = requiredString(adapter.targetType, "adapter.targetType", 32);
  const executionMode = requiredString(adapter.executionMode, "adapter.executionMode", 32);
  const description = adapter.description === undefined
    ? ""
    : requiredString(adapter.description, "adapter.description", MAX_DESCRIPTION_LENGTH);

  if (!TARGET_TYPES.has(targetType)) {
    throw new QaEngineRegistryError("INVALID_TARGET_TYPE", "adapter.targetType is not supported");
  }
  if (!EXECUTION_MODES.has(executionMode)) {
    throw new QaEngineRegistryError("INVALID_EXECUTION_MODE", "adapter.executionMode is not supported");
  }
  if (typeof adapter.run !== "function") {
    throw new QaEngineRegistryError("INVALID_RUNNER", "adapter.run must be a function");
  }

  return {
    metadata: Object.freeze({
      contract: CONTRACT,
      id,
      name,
      version,
      category,
      targetType,
      executionMode,
      capabilities: normalizeCapabilities(adapter.capabilities),
      description
    }),
    runner: adapter.run
  };
}

/**
 * Creates an explicit registry of trusted QA engine adapters.
 *
 * The registry validates and describes adapters; it never invokes a runner.
 * Execution, permissions, scheduling and cancellation belong to later host
 * orchestration layers. No adapter is loaded from disk or discovered implicitly.
 */
export function createQaEngineRegistry(options = {}) {
  const config = readRecord(options, "options", new Set(["adapters"]));
  const adapters = Object.hasOwn(config, "adapters") ? config.adapters : [];
  if (!Array.isArray(adapters) || adapters.length > MAX_ADAPTERS) {
    throw new QaEngineRegistryError("INVALID_ADAPTERS", "adapters must be an array of at most 256 entries");
  }

  const metadataById = new Map();
  const runnerById = new Map();
  let sealed = false;

  function register(input) {
    if (sealed) {
      throw new QaEngineRegistryError("REGISTRY_SEALED", "The QA engine registry is sealed");
    }
    if (metadataById.size >= MAX_ADAPTERS) {
      throw new QaEngineRegistryError("REGISTRY_LIMIT", "The QA engine registry has reached its 256-adapter limit");
    }

    const normalized = normalizeAdapter(input);
    const { id } = normalized.metadata;
    if (metadataById.has(id)) {
      throw new QaEngineRegistryError("DUPLICATE_ENGINE", "An adapter with this engine ID is already registered");
    }

    metadataById.set(id, normalized.metadata);
    runnerById.set(id, normalized.runner);
    return normalized.metadata;
  }

  for (const adapter of adapters) register(adapter);

  return Object.freeze({
    register,
    list() {
      return Object.freeze([...metadataById.values()]);
    },
    get(id) {
      return typeof id === "string" ? metadataById.get(id) ?? null : null;
    },
    has(id) {
      return typeof id === "string" && metadataById.has(id);
    },
    getRunner(id) {
      return typeof id === "string" ? runnerById.get(id) ?? null : null;
    },
    find(criteria = {}) {
      const filter = readRecord(criteria, "criteria", new Set(["category", "capability", "executionMode", "targetType"]));
      for (const [key, value] of Object.entries(filter)) {
        requiredString(value, "criteria." + key, 128);
      }
      return Object.freeze([...metadataById.values()].filter((item) =>
        (filter.category === undefined || item.category === filter.category) &&
        (filter.capability === undefined || item.capabilities.includes(filter.capability)) &&
        (filter.executionMode === undefined || item.executionMode === filter.executionMode) &&
        (filter.targetType === undefined || item.targetType === filter.targetType)
      ));
    },
    seal() {
      sealed = true;
      return true;
    },
    isSealed() {
      return sealed;
    }
  });
}
