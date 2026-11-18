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

export function snapshotArray(value, label = "value") {
  if (!Array.isArray(value)) {
    throw new TypeError(label + " must be an array");
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 100_000) {
    throw new TypeError(label + " has an invalid or excessive length");
  }

  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + "[" + index + "] must be an enumerable data property");
    }
    snapshot.push(descriptor.value);
  }

  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\\d*)$/.test(key) || Number(key) >= length) {
      throw new TypeError(label + " must not contain extra properties");
    }
  }
  return snapshot;
}
