import assert from "node:assert/strict";
import test from "node:test";
import {
  createContainmentPolicy,
  ContainmentPolicyError
} from "../src/agent/containment-policy.js";

test("containment policy normalizes the shared cross-platform defaults", () => {
  const policy = createContainmentPolicy();

  assert.deepEqual(policy, {
    schemaVersion: 1,
    required: false,
    allowUncontainedFallback: false,
    limits: {
      memoryBytes: 536870912,
      cpuPercent: 50,
      processCount: 32
    }
  });
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.limits), true);
});

test("containment policy accepts the documented application configuration", () => {
  const policy = createContainmentPolicy({
    required: true,
    memoryLimit: "512MB",
    cpuLimit: 50,
    processLimit: 8
  });

  assert.deepEqual(policy.limits, {
    memoryBytes: 512000000,
    cpuPercent: 50,
    processCount: 8
  });
  assert.equal(policy.required, true);
  assert.equal(policy.allowUncontainedFallback, false);
});

test("containment policy supports IEC memory units and exact byte values", () => {
  assert.equal(createContainmentPolicy({ memoryLimit: "1GiB" }).limits.memoryBytes, 1073741824);
  assert.equal(createContainmentPolicy({ memoryLimit: 16777216 }).limits.memoryBytes, 16777216);
});

test("containment fallback is explicit and cannot contradict a required policy", () => {
  const policy = createContainmentPolicy({
    required: false,
    allowUncontainedFallback: true
  });
  assert.equal(policy.allowUncontainedFallback, true);

  assert.throws(
    () => createContainmentPolicy({ required: true, allowUncontainedFallback: true }),
    (error) => error instanceof ContainmentPolicyError && error.code === "CONFLICTING_CONTAINMENT_POLICY"
  );
});

test("containment policy rejects out-of-range and malformed limits", () => {
  for (const memoryLimit of ["512", "0MiB", "15MiB", "2TiB", "1.5GiB", "512MB;rm"]) {
    assert.throws(
      () => createContainmentPolicy({ memoryLimit }),
      (error) => error.code === "INVALID_MEMORY_LIMIT"
    );
  }
  for (const cpuLimit of [0, 101, 50.5, "50"]) {
    assert.throws(
      () => createContainmentPolicy({ cpuLimit }),
      (error) => error.code === "INVALID_CPU_LIMIT"
    );
  }
  for (const processLimit of [0, 65536, 1.5, "8"]) {
    assert.throws(
      () => createContainmentPolicy({ processLimit }),
      (error) => error.code === "INVALID_PROCESS_LIMIT"
    );
  }
});

test("containment policy rejects unknown fields, accessors and non-plain objects", () => {
  assert.throws(
    () => createContainmentPolicy({ allowFallback: true }),
    (error) => error.code === "UNSUPPORTED_POLICY_FIELD"
  );
  let getterInvoked = false;
  const withGetter = {};
  Object.defineProperty(withGetter, "required", {
    enumerable: true,
    get() {
      getterInvoked = true;
      return true;
    }
  });
  assert.throws(
    () => createContainmentPolicy(withGetter),
    (error) => error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(getterInvoked, false);
  assert.throws(
    () => createContainmentPolicy(new Date()),
    (error) => error.code === "INVALID_POLICY"
  );
  assert.throws(
    () => createContainmentPolicy(null),
    (error) => error.code === "INVALID_POLICY"
  );
});

test("containment policy rejects symbol keys and invalid policy flags", () => {
  const withSymbol = { required: true };
  withSymbol[Symbol("unexpected")] = true;
  assert.throws(
    () => createContainmentPolicy(withSymbol),
    (error) => error.code === "UNSUPPORTED_POLICY_FIELD"
  );
  assert.throws(
    () => createContainmentPolicy({ required: "yes" }),
    (error) => error.code === "INVALID_REQUIRED_FLAG"
  );
  assert.throws(
    () => createContainmentPolicy({ allowUncontainedFallback: 1 }),
    (error) => error.code === "INVALID_FALLBACK_FLAG"
  );
});
