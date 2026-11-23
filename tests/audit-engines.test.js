import test from "node:test";
import assert from "node:assert/strict";
import { AUDIT_ENGINE_IDS, createAuditEngineRegistry } from "../src/audit-engines/index.js";

test("registry exposes the seven built-in audit adapters with immutable metadata", () => {
  const registry = createAuditEngineRegistry();
  assert.deepEqual(AUDIT_ENGINE_IDS, [
    "static", "live-site", "responsive", "accessibility", "performance", "security", "visual"
  ]);
  assert.deepEqual(registry.list().map((item) => item.id), AUDIT_ENGINE_IDS);
  assert.equal(registry.get("static").mode, "local-static");
  assert.equal(registry.get("missing"), null);
  assert.ok(Object.isFrozen(registry.list()));
  assert.ok(Object.isFrozen(registry.get("responsive").capabilities));
});

test("static adapter validates the local target and forwards options to the static auditor", async () => {
  const registry = createAuditEngineRegistry({
    adapters: {
      static: async (target, options) => ({ target, options })
    }
  });
  const result = await registry.run("static", { path: "./project" }, { format: "json" });
  assert.deepEqual(result, {
    target: { path: "./project" },
    options: { format: "json" }
  });
});

test("live-site and responsive adapters route to independent browser handlers", async () => {
  const calls = [];
  const registry = createAuditEngineRegistry({
    adapters: {
      "live-site": async (target, options) => {
        calls.push({ id: "live-site", target, options });
        return "site";
      },
      responsive: async (target, options) => {
        calls.push({ id: "responsive", target, options });
        return "matrix";
      }
    }
  });
  assert.equal(await registry.run("live-site", { url: "https://example.test" }), "site");
  assert.equal(await registry.run("responsive", { url: "https://example.test" }, { themes: ["light", "dark"] }), "matrix");
  assert.deepEqual(calls.map((call) => call.id), ["live-site", "responsive"]);
  assert.equal(calls[1].options.themes.length, 2);
});

test("accessibility and performance adapters enforce their specialist scope", async () => {
  const calls = [];
  const capture = (id) => async (target, options) => {
    calls.push({ id, target, options });
    return id;
  };
  const registry = createAuditEngineRegistry({
    adapters: {
      accessibility: capture("accessibility"),
      performance: capture("performance")
    }
  });
  await registry.run("accessibility", { url: "https://example.test" }, { specialist: "responsive" });
  await registry.run("performance", { url: "https://example.test" });
  assert.equal(calls[0].options.specialist, "accessibility");
  assert.equal(calls[1].options.specialist, "performance");
});

test("security adapter accepts exactly one local path or runtime URL", async () => {
  const calls = [];
  const registry = createAuditEngineRegistry({
    adapters: {
      security: async (target) => {
        calls.push(target);
        return target;
      }
    }
  });
  assert.deepEqual(await registry.run("security", { path: "./project" }), { path: "./project" });
  assert.deepEqual(await registry.run("security", { url: "https://example.test" }), { url: "https://example.test" });
  assert.deepEqual(calls, [{ path: "./project" }, { url: "https://example.test" }]);
  await assert.rejects(registry.run("security", { path: "./project", url: "https://example.test" }), /exactly one/);
  await assert.rejects(registry.run("security", {}), /exactly one/);
});

test("invalid engines, target fields, target types and adapter overrides are rejected", async () => {
  assert.throws(() => createAuditEngineRegistry({ adapters: { unknown: () => null } }), /Unknown audit adapter/);
  assert.throws(() => createAuditEngineRegistry({ adapters: { static: true } }), /must be a function/);
  const registry = createAuditEngineRegistry();
  await assert.rejects(registry.run("unknown", { url: "https://example.test" }), /Unknown audit engine/);
  await assert.rejects(registry.run("live-site", { path: "./project" }), /Unexpected target field/);
  await assert.rejects(registry.run("live-site", { url: "  " }), /non-empty string/);
  await assert.rejects(registry.run("live-site", { url: "https://example.test", extra: true }), /Unexpected target field/);
  await assert.rejects(registry.run("static", { path: "./project" }, []), /plain object/);
});

test("engine metadata identifies existing capabilities without claiming unsupported API contract testing", () => {
  const registry = createAuditEngineRegistry();
  assert.match(registry.get("live-site").description, /HTTP/);
  assert.match(registry.get("visual").description, /pixel-baseline/);
  assert.ok(!AUDIT_ENGINE_IDS.includes("api"));
});
