const SPECIALISTS = new Set([
  "ui-ux",
  "responsive",
  "accessibility",
  "performance",
  "functional",
  "consistency"
]);

export class RuleRegistry {
  #rules = new Map();

  register(rule) {
    if (!rule || typeof rule.id !== "string" || !rule.id.trim()) {
      throw new TypeError("A rule must have a non-empty id");
    }
    if (!SPECIALISTS.has(rule.specialist)) {
      throw new TypeError(`Unknown specialist: ${rule.specialist}`);
    }
    if (typeof rule.evaluate !== "function") {
      throw new TypeError(`Rule "${rule.id}" must provide evaluate(context)`);
    }
    if (this.#rules.has(rule.id)) {
      throw new Error(`Rule already registered: ${rule.id}`);
    }
    this.#rules.set(rule.id, Object.freeze({ ...rule }));
    return this;
  }

  get(id) {
    return this.#rules.get(id) ?? null;
  }

  list({ specialist } = {}) {
    return [...this.#rules.values()].filter(
      (rule) => !specialist || rule.specialist === specialist
    );
  }

  get size() {
    return this.#rules.size;
  }
}
