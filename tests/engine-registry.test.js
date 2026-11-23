import test from "node:test";
import assert from "node:assert/strict";
import {
  createQaEngineRegistry,
  QaEngineRegistryError,
  QA_ENGINE_ADAPTER_CONTRACT
} from "../src/engine-registry/index.js";

function adapter(overrides = {}) {
  return {
    id: "jb.test.static",
    name: "Static QA",
    version: "1.0.0",
    category: "audit",
    targetType: "path",
    executionMode: "in-process",
    capabilities: ["source-audit", "dependency-audit"],
    description: "Read-only static project inspection",
    run: async () => ({ passed: true }),
    ...overrides
  };
}

test("creates an empty registry and exposes the v1 adapter contract", () => {
  const registry = createQaEngineRegistry();
  assert.equal(QA_ENGINE_ADAPTER_CONTRACT, "jb.qa-engine-adapter/v1");
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.get("missing"), null);
  assert.equal(registry.getRunner("missing"), null);
  assert.equal(registry.has("missing"), false);
  assert.equal(registry.isSealed(), false);
});

test("registers an adapter and keeps its runner separate from public metadata", async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return "result";
  };
  const registry = createQaEngineRegistry({ adapters: [adapter({ run: runner })] });
  const metadata = registry.get("jb.test.static");

  assert.equal(metadata.contract, QA_ENGINE_ADAPTER_CONTRACT);
  assert.equal(metadata.name, "Static QA");
  assert.deepEqual(metadata.capabilities, ["source-audit", "dependency-audit"]);
  assert.equal(registry.getRunner("jb.test.static"), runner);
  assert.equal(calls, 0, "registration and discovery must never execute an adapter");
  assert.deepEqual(await registry.getRunner("jb.test.static")(), "result");
  assert.equal(calls, 1);
});

test("returns immutable metadata snapshots and does not retain caller-owned capability arrays", () => {
  const capabilities = ["source-audit"];
  const input = adapter({ capabilities });
  const registry = createQaEngineRegistry({ adapters: [input] });
  capabilities.push("injected-capability");
  input.name = "Mutated outside registry";

  const metadata = registry.get("jb.test.static");
  assert.equal(metadata.name, "Static QA");
  assert.deepEqual(metadata.capabilities, ["source-audit"]);
  assert.ok(Object.isFrozen(metadata));
  assert.ok(Object.isFrozen(metadata.capabilities));
  assert.ok(Object.isFrozen(registry.list()));
});

test("find filters by category, capability, execution mode and target type", () => {
  const registry = createQaEngineRegistry({
    adapters: [
      adapter(),
      adapter({
        id: "jb.test.api",
        name: "API QA",
        category: "api",
        targetType: "url",
        executionMode: "remote",
        capabilities: ["http", "contract-validation"]
      }),
      adapter({
        id: "jb.test.visual",
        name: "Visual QA",
        category: "audit",
        targetType: "url",
        executionMode: "browser",
        capabilities: ["screenshots", "layout"]
      })
    ]
  });

  assert.deepEqual(registry.find({ category: "api" }).map((item) => item.id), ["jb.test.api"]);
  assert.deepEqual(registry.find({ capability: "contract-validation" }).map((item) => item.id), ["jb.test.api"]);
  assert.deepEqual(registry.find({ executionMode: "browser", targetType: "url" }).map((item) => item.id), ["jb.test.visual"]);
  assert.equal(registry.find({}).length, 3);
});

test("rejects duplicate engine IDs without replacing the original adapter", () => {
  const firstRunner = () => "first";
  const registry = createQaEngineRegistry({ adapters: [adapter({ run: firstRunner })] });
  assert.throws(
    () => registry.register(adapter({ name: "Replacement", run: () => "second" })),
    (error) => error instanceof QaEngineRegistryError && error.code === "DUPLICATE_ENGINE"
  );
  assert.equal(registry.get("jb.test.static").name, "Static QA");
  assert.equal(registry.getRunner("jb.test.static"), firstRunner);
});

test("rejects missing, malformed and unsupported adapter fields", () => {
  const cases = [
    [({ id, ...rest }) => rest, "MISSING_FIELD"],
    [(value) => ({ ...value, id: "Not Valid" }), "INVALID_FIELD"],
    [(value) => ({ ...value, version: "1.0" }), "INVALID_FIELD"],
    [(value) => ({ ...value, category: "Not Valid" }), "INVALID_FIELD"],
    [(value) => ({ ...value, targetType: "shell" }), "INVALID_TARGET_TYPE"],
    [(value) => ({ ...value, executionMode: "implicit" }), "INVALID_EXECUTION_MODE"],
    [(value) => ({ ...value, capabilities: [] }), "INVALID_CAPABILITIES"],
    [(value) => ({ ...value, capabilities: ["same", "same"] }), "DUPLICATE_CAPABILITY"],
    [(value) => ({ ...value, run: null }), "INVALID_RUNNER"],
    [(value) => ({ ...value, unexpected: true }), "UNSUPPORTED_FIELD"]
  ];

  for (const [mutate, code] of cases) {
    assert.throws(
      () => createQaEngineRegistry().register(mutate(adapter())),
      (error) => error instanceof QaEngineRegistryError && error.code === code
    );
  }
});

test("rejects accessors without invoking them", () => {
  let invoked = false;
  const input = adapter();
  Object.defineProperty(input, "name", {
    enumerable: true,
    get() {
      invoked = true;
      return "unsafe";
    }
  });

  assert.throws(
    () => createQaEngineRegistry().register(input),
    (error) => error instanceof QaEngineRegistryError && error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(invoked, false);
});

test("rejects symbol keys and non-plain adapter records", () => {
  const withSymbol = adapter();
  withSymbol[Symbol("hidden")] = true;
  assert.throws(
    () => createQaEngineRegistry().register(withSymbol),
    (error) => error instanceof QaEngineRegistryError && error.code === "UNSUPPORTED_FIELD"
  );
  assert.throws(() => createQaEngineRegistry().register(new (class Adapter extends Object {})()), /plain object/u);
});

test("registry limits adapter count and validates constructor input", () => {
  assert.throws(() => createQaEngineRegistry({ adapters: {} }), /array/u);
  assert.throws(() => createQaEngineRegistry({ adapters: new Array(257).fill(adapter()) }), /256/u);
});

test("seal prevents later registration while preserving discovery", () => {
  const registry = createQaEngineRegistry({ adapters: [adapter()] });
  assert.equal(registry.seal(), true);
  assert.equal(registry.isSealed(), true);
  assert.throws(
    () => registry.register(adapter({ id: "jb.test.other" })),
    (error) => error instanceof QaEngineRegistryError && error.code === "REGISTRY_SEALED"
  );
  assert.equal(registry.has("jb.test.static"), true);
  assert.equal(registry.list().length, 1);
});

test("registry enforces the adapter limit when entries are added incrementally", () => {
  const registry = createQaEngineRegistry();
  for (let index = 0; index < 256; index += 1) {
    registry.register(adapter({ id: "jb.test.engine-" + index }));
  }
  assert.throws(
    () => registry.register(adapter({ id: "jb.test.engine-overflow" })),
    (error) => error instanceof QaEngineRegistryError && error.code === "REGISTRY_LIMIT"
  );
});
