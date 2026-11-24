import { createJsonFileExecutionJobStore } from "./execution-job-persistence.js";
import {
  createExecutionEventJournal,
  ExecutionEventJournalError
} from "./execution-event-journal.js";

function readOptions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionEventJournalError("INVALID_OPTIONS", "options must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ExecutionEventJournalError("INVALID_OPTIONS", "options must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !new Set(["filePath", "maxEvents", "now"]).has(key)) {
      throw new ExecutionEventJournalError("UNSUPPORTED_OPTION", "options contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new ExecutionEventJournalError("ACCESSOR_NOT_ALLOWED", "options cannot contain accessors");
    }
    output[key] = descriptor.value;
  }
  if (typeof output.filePath !== "string" || !output.filePath.trim() ||
      output.filePath.length > 4096 || output.filePath.includes("\0")) {
    throw new ExecutionEventJournalError("INVALID_FILE_PATH", "filePath must be a valid non-empty path");
  }
  return output;
}

/**
 * Creates a bounded execution event journal backed by the same hardened local
 * JSON store used by the durable job queue. Every append is checksummed and
 * committed through a restrictive, exclusive lock and atomic fsync/rename.
 *
 * The store is single-process. Call journal.close() during orderly shutdown to
 * release its lock. The default createExecutionEventJournal() remains memory-only.
 */
export function createPersistentExecutionEventJournal(options = {}) {
  const config = readOptions(options);
  const store = createJsonFileExecutionJobStore({ filePath: config.filePath });
  try {
    const journal = createExecutionEventJournal({
      ...(config.maxEvents === undefined ? {} : { maxEvents: config.maxEvents }),
      ...(config.now === undefined ? {} : { now: config.now }),
      persistence: store
    });
    return Object.freeze({
      ...journal,
      filePath: store.filePath
    });
  } catch (error) {
    try { store.close(); } catch {}
    throw error;
  }
}
