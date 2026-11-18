export function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Copies a plain record using own data descriptors only.
 * Accessor properties, symbols and non-enumerable own properties are rejected
 * without invoking getters.
 */
export function snapshotPlainRecord(value, label = "value") {
  if (!isPlainRecord(value)) {
    throw new TypeError(label + " must be a plain object");
  }

  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(label + " must not contain symbol properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + "." + key + " must be an enumerable data property");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
