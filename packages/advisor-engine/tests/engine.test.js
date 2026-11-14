import test from "node:test";
import assert from "node:assert/strict";
import {
  ENGINE_NAME,
  ENGINE_ID,
  DOMAINS,
  getEngineInfo,
} from "../src/index.js";

test("exposes the independent JB Advisor Engine identity", () => {
  assert.equal(ENGINE_NAME, "JB Advisor Engine");
  assert.equal(ENGINE_ID, "JBAE");
});

test("keeps fragrance and technology as separate domains", () => {
  assert.deepEqual(Object.values(DOMAINS), ["fragrance", "technology"]);
});

test("reports offline-first and evidence-first principles", () => {
  const info = getEngineInfo();
  assert.ok(info.principles.includes("offline-first"));
  assert.ok(info.principles.includes("evidence-first"));
});
