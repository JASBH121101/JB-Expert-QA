import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "@jb/advisor-engine";

test("public entry point exposes stable engine metadata", () => {
  assert.equal(engine.ENGINE_NAME, "JB Advisor Engine");
  assert.equal(engine.ENGINE_ID, "JBAE");
  assert.equal(engine.ENGINE_VERSION, "0.1.0");
  assert.deepEqual(engine.getEngineInfo().domains, [
    engine.DOMAINS.FRAGRANCE,
    engine.DOMAINS.TECHNOLOGY,
  ]);
});

test("public entry point exposes the consumer integration surfaces", () => {
  for (const name of [
    "createAdvisorCore",
    "AdvisorCore",
    "KnowledgeStore",
    "MemoryKnowledgeAdapter",
    "CapacitorSQLiteKnowledgeAdapter",
    "CatalogIndex",
    "matchFragrances",
    "parseFragranceCustomerMessage",
    "buildFragranceCustomerExplanation",
    "normalizeFragranceProduct",
    "normalizeTechnologyProduct",
  ]) {
    assert.equal(typeof engine[name], "function", name + " must be exported");
  }
});
