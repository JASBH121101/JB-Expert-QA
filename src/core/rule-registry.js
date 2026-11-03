const SPECIALIST_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isValidSpecialistId(value) {
  return typeof value === "string" && SPECIALIST_ID_PATTERN.test(value);
}

export class RuleRegistry {
  #rules = new Map();

  register(rule) {
    if (!rule || typeof rule.id !== "string" || !rule.id.trim()) {
      throw new TypeError("A rule must have a non-empty id");
    }
    if (!isValidSpecialistId(rule.specialist)) {
      throw new TypeError(
        "A rule must use a valid specialist id (lowercase letters, numbers and hyphens)"
      );
    }
    if (typeof rule.evaluate !== "function") {
      throw new TypeError("Rule \"" + rule.id + "\" must provide evaluate(context)");
    }
    if (this.#rules.has(rule.id)) {
      throw new Error("Rule already registered: " + rule.id);
    }
    this.#rules.set(rule.id, Object.freeze({ ...rule }));
    return this;
  }

  get(id) {
    return this.#rules.get(id) ?? null;
  }

  list({ specialist } = {}) {
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
