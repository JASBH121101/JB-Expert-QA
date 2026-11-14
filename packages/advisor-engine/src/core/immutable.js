function cloneValue(value, seen) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Product data cannot contain non-finite numbers");
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("Product data must contain only JSON-compatible values");
  }
  if (seen.has(value)) throw new TypeError("Product data cannot contain circular references");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map(item => cloneValue(item, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Product data objects must be plain JSON objects");
    }
    result = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item, seen)])
    );
  }
  seen.delete(value);
  return Object.freeze(result);
}

export function cloneAndFreeze(value) {
  return cloneValue(value, new WeakSet());
}

export function normalizeEvidenceIds(value, label = "evidenceIds") {
  if (value === undefined || value === null) return Object.freeze({});
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object keyed by attribute field`);
  }
  const normalized = {};
  for (const [field, ids] of Object.entries(value)) {
    if (!field.trim() || !Array.isArray(ids) ||
        ids.some(id => typeof id !== "string" || !id.trim())) {
      throw new TypeError(`${label}.${field} must be an array of non-empty evidence IDs`);
    }
    if (new Set(ids).size !== ids.length) {
      throw new TypeError(`${label}.${field} cannot contain duplicate evidence IDs`);
    }
    normalized[field] = Object.freeze(ids.map(id => id.trim()));
  }
  return Object.freeze(normalized);
}
