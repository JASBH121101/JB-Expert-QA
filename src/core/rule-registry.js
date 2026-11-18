import { snapshotPlainRecord } from "./safe-record.js";

const SPECIALIST_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isValidSpecialistId(value) {
  return typeof value === "string" && SPECIALIST_ID_PATTERN.test(value);
}

export class RuleRegistry {
  #rules = new Map();

  register(rule) {
    const safeRule = snapshotPlainRecord(rule, "rule");
    if (typeof safeRule.id !== "string" || !safeRule.id.trim()) {
      throw new TypeError("A rule must have a non-empty id");
    }
    if (!isValidSpecialistId(safeRule.specialist)) {
      throw new TypeError(
        "A rule must use a valid specialist id (lowercase letters, numbers and hyphens)"
      );
    }
    if (typeof safeRule.evaluate !== "function") {
      throw new TypeError("Rule \"" + safeRule.id + "\" must provide evaluate(context)");
    }
    if (this.#rules.has(safeRule.id)) {
      throw new Error("Rule already registered: " + safeRule.id);
    }
    this.#rules.set(safeRule.id, Object.freeze(safeRule));
    return this;
  }

  get(id) {
    return this.#rules.get(id) ?? null;
  }

  list(options = {}) {
    const safeOptions = snapshotPlainRecord(options, "registry filter");
    const specialist = safeOptions.specialist;
    if (specialist !== undefined && !isValidSpecialistId(specialist)) {
      throw new TypeError("specialist filter must be a valid specialist id");
    }
    return [...this.#rules.values()].filter(
      (rule) => !specialist || rule.specialist === specialist
    );
  }

  listSpecialists() {
    return [...new Set([...this.#rules.values()].map((rule) => rule.specialist))].sort();
  }

  get size() {
    return this.#rules.size;
  }
}
