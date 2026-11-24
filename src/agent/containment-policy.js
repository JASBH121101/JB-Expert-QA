const MIB = 1024 ** 2;
const MAX_MEMORY_BYTES = 1024 ** 4;
const MIN_MEMORY_BYTES = 16 * MIB;
const DEFAULT_MEMORY_BYTES = 512 * MIB;

const MEMORY_UNITS = Object.freeze({
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4
});

export class ContainmentPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContainmentPolicyError";
    this.code = code;
  }
}

function readRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContainmentPolicyError("INVALID_POLICY", label + " must be a plain object");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContainmentPolicyError("INVALID_POLICY", label + " must be a plain object");
  }

  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new ContainmentPolicyError("UNSUPPORTED_POLICY_FIELD", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ContainmentPolicyError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function parseMemoryLimit(value) {
  if (Number.isSafeInteger(value)) return value;
  if (typeof value !== "string") {
    throw new ContainmentPolicyError("INVALID_MEMORY_LIMIT", "memoryLimit must be bytes or a size string such as 512MiB");
  }

  const match = /^([1-9][0-9]*)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/iu.exec(value.trim());
  if (!match) {
    throw new ContainmentPolicyError("INVALID_MEMORY_LIMIT", "memoryLimit must use B, KB, MB, GB, TB, KiB, MiB, GiB or TiB");
  }
  const amount = Number(match[1]);
  const unit = MEMORY_UNITS[match[2].toUpperCase()];
  const bytes = amount * unit;
  if (!Number.isSafeInteger(bytes)) {
    throw new ContainmentPolicyError("INVALID_MEMORY_LIMIT", "memoryLimit exceeds the safe integer range");
  }
  return bytes;
}

function normalizeMemoryLimit(value) {
  const bytes = parseMemoryLimit(value);
  if (!Number.isSafeInteger(bytes) || bytes < MIN_MEMORY_BYTES || bytes > MAX_MEMORY_BYTES) {
    throw new ContainmentPolicyError(
      "INVALID_MEMORY_LIMIT",
      "memoryLimit must be between 16 MiB and 1 TiB"
    );
  }
  return bytes;
}

/**
 * Creates the versioned, platform-neutral resource policy consumed by the
 * Phase 5 containment adapters. This function is deterministic and performs
 * no host inspection, process creation, filesystem access or OS mutation.
 *
 * memoryLimit accepts bytes or a size string (for example, "512MiB").
 * cpuLimit is a percentage from 1 to 100; processLimit is a positive count.
 */
export function createContainmentPolicy(options = {}) {
  const config = readRecord(options, "containment policy");
  const allowedKeys = new Set([
    "required",
    "allowUncontainedFallback",
    "memoryLimit",
    "cpuLimit",
    "processLimit"
  ]);

  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key)) {
      throw new ContainmentPolicyError("UNSUPPORTED_POLICY_FIELD", "containment policy contains an unsupported field: " + key);
    }
  }

  const required = config.required ?? false;
  const allowUncontainedFallback = config.allowUncontainedFallback ?? false;
  const memoryBytes = normalizeMemoryLimit(config.memoryLimit ?? DEFAULT_MEMORY_BYTES);
  const cpuPercent = config.cpuLimit ?? 50;
  const processCount = config.processLimit ?? 32;

  if (typeof required !== "boolean") {
    throw new ContainmentPolicyError("INVALID_REQUIRED_FLAG", "required must be boolean");
  }
  if (typeof allowUncontainedFallback !== "boolean") {
    throw new ContainmentPolicyError("INVALID_FALLBACK_FLAG", "allowUncontainedFallback must be boolean");
  }
  if (required && allowUncontainedFallback) {
    throw new ContainmentPolicyError(
      "CONFLICTING_CONTAINMENT_POLICY",
      "required containment cannot allow an uncontained fallback"
    );
  }
  if (!Number.isSafeInteger(cpuPercent) || cpuPercent < 1 || cpuPercent > 100) {
    throw new ContainmentPolicyError("INVALID_CPU_LIMIT", "cpuLimit must be an integer from 1 to 100");
  }
  if (!Number.isSafeInteger(processCount) || processCount < 1 || processCount > 65535) {
    throw new ContainmentPolicyError("INVALID_PROCESS_LIMIT", "processLimit must be an integer from 1 to 65535");
  }

  return Object.freeze({
    schemaVersion: 1,
    required,
    allowUncontainedFallback,
    limits: Object.freeze({
      memoryBytes,
      cpuPercent,
      processCount
    })
  });
}
