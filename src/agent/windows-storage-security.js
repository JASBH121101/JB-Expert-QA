const SERVICE_SIDS = new Set(["S-1-5-19", "S-1-5-20"]);
const PRIVILEGED_SIDS = new Set(["S-1-5-18", "S-1-5-32-544"]);
const SID_PATTERN = /^S-1-(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*)){1,14}$/u;

export class WindowsStorageSecurityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WindowsStorageSecurityError";
    this.code = code;
  }
}

function readPlainRecord(value, allowedKeys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", label + " cannot contain accessors");
    }
    output[key] = descriptor.value;
  }
  return output;
}

/**
 * Validate an application-supplied Windows token/NTFS ACL attestation.
 *
 * The verifier that creates this report is a trusted deployment integration:
 * it must inspect the effective process token and the complete, effective
 * directory DACL using native Windows security APIs. This function validates
 * the report contract; it does not query or modify Windows ACLs itself.
 */
export function validateWindowsStorageSecurityReport(report, options = {}) {
  const config = readPlainRecord(options, new Set(["directory", "expectedServiceSid"]), "validation options");
  if (typeof config.directory !== "string" || !config.directory ||
      !SERVICE_SIDS.has(config.expectedServiceSid)) {
    throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", "directory and a supported service SID are required");
  }

  const value = readPlainRecord(report, new Set([
    "directory", "processIdentitySid", "ownerSid", "daclProtected", "accessEntries"
  ]), "security report");

  if (value.directory !== config.directory ||
      value.processIdentitySid !== config.expectedServiceSid ||
      value.ownerSid !== config.expectedServiceSid ||
      value.daclProtected !== true) {
    throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", "Windows storage identity, owner or protected DACL does not match the expected service identity");
  }

  const entries = value.accessEntries;
  if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype ||
      entries.length < 1 || entries.length > 3) {
    throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", "accessEntries must contain one to three explicit allow entries");
  }

  const allowedArrayKeys = new Set(["length"]);
  for (let index = 0; index < entries.length; index += 1) {
    allowedArrayKeys.add(String(index));
  }
  if (Reflect.ownKeys(entries).some(key => typeof key !== "string" || !allowedArrayKeys.has(key))) {
    throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", "accessEntries cannot contain custom fields");
  }

  const seen = new Set();
  let serviceIdentityGranted = false;
  for (let index = 0; index < entries.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", "accessEntries cannot contain holes or accessors");
    }
    const entry = readPlainRecord(descriptor.value,
      new Set(["sid", "type", "access", "inherited"]), "access entry");

    if (typeof entry.sid !== "string" || !SID_PATTERN.test(entry.sid) ||
        seen.has(entry.sid) || entry.type !== "allow" || entry.inherited !== false) {
      throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", "only unique explicit allow entries are permitted");
    }
    seen.add(entry.sid);

    if (entry.sid === config.expectedServiceSid) {
      if (!["modify", "full-control"].includes(entry.access)) {
        throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", "the service identity must have modify access to its state directory");
      }
      serviceIdentityGranted = true;
    } else if (PRIVILEGED_SIDS.has(entry.sid)) {
      if (entry.access !== "full-control") {
        throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", "system and local administrators may only have full-control access");
      }
    } else {
      throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", "the storage DACL contains an unapproved principal");
    }
  }

  if (!serviceIdentityGranted) {
    throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_INVALID", "the service identity has no explicit modify grant");
  }

  return Object.freeze({
    identityVerified: true,
    ownerVerified: true,
    permissionsVerified: true,
    daclProtected: true
  });
}
