import test from "node:test";
import assert from "node:assert/strict";
import { createApiAssertionsEngine, API_ASSERTIONS_ENGINE_ID } from "../src/assertions.js";

const engine = createApiAssertionsEngine();
const response = {
  status: 201,
  ok: true,
  headers: { "content-type": "application/json", "x-request-id": "req-123", "x-ratelimit-remaining": "42" },
  bodyText: '{"data":{"user":{"id":7,"name":"Steven","active":true},"items":[2,4,6]},"message":"created"}',
  json: { data: { user: { id: 7, name: "Steven", active: true }, items: [2,4,6] }, message: "created" },
  jsonParsed: true
};

test("engine identity and successful mixed assertion evaluation", () => {
  const result = engine.evaluate(response, [
    { type: "status", expected: 201 },
    { type: "statusRange", expected: [200, 299] },
    { type: "header", name: "content-type", operator: "contains", expected: "json" },
    { type: "json", path: "$.data.user.id", expected: 7 },
    { type: "exists", path: "$.data.user.active" },
    { type: "type", path: "$.data.items", expected: "array" },
    { type: "number", path: "$.data.user.id", operator: "greaterThan", expected: 6 },
    { type: "arrayLength", path: "$.data.items", expected: 3 },
    { type: "text", operator: "contains", expected: "created" },
    { type: "regex", target: "text", pattern: "Steven", flags: "i" }
  ]);
  assert.equal(result.engineId, API_ASSERTIONS_ENGINE_ID);
  assert.equal(result.passed, true);
  assert.equal(result.total, 10);
  assert.equal(result.passedCount, 10);
  assert.equal(result.failedCount, 0);
  assert.equal(result.passRate, 100);
});

test("reports failed assertions with actual and expected values", () => {
  const result = engine.evaluate(response, [
    { type: "status", expected: 200 },
    { type: "json", path: "$.data.user.name", expected: "Wrong" },
    { type: "number", path: "$.data.user.id", operator: "lessThan", expected: 1 }
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.failedCount, 3);
  assert.equal(result.results[0].actual, 201);
  assert.equal(result.results[1].actual, "Steven");
  assert.equal(result.results[2].expected, 1);
});

test("stopOnFailure short-circuits and reports evaluated assertions only", () => {
  const result = engine.evaluate(response, [
    { type: "status", expected: 500 },
    { type: "status", expected: 201 }
  ], { stopOnFailure: true });
  assert.equal(result.total, 1);
  assert.equal(result.passed, false);
});

test("supports JSON array indexing and comparison operators", () => {
  const result = engine.evaluate(response, [
    { type: "json", path: "$.data.items[1]", expected: 4 },
    { type: "number", path: "$.data.items[2]", operator: "between", expected: [5, 7] },
    { type: "json", path: "$.message", operator: "startsWith", expected: "cre" },
    { type: "json", path: "$.message", operator: "endsWith", expected: "ed" }
  ]);
  assert.equal(result.passed, true);
});

test("missing paths fail existence, value, type and number checks without crashing", () => {
  const result = engine.evaluate(response, [
    { type: "exists", path: "$.missing" },
    { type: "json", path: "$.missing", expected: null },
    { type: "type", path: "$.missing", expected: "null" },
    { type: "number", path: "$.missing", expected: 0 }
  ]);
  assert.equal(result.failedCount, 4);
});

test("validates assertion input, paths, regex flags and operators", () => {
  assert.throws(() => engine.evaluate(response, []), /between 1 and 1000/u);
  assert.throws(() => engine.evaluate(response, [{ type: "bogus" }]), /unsupported type/u);
  assert.throws(() => engine.evaluate(response, [{ type: "json", path: "$.constructor", expected: "x" }]), /Forbidden/u);
  assert.throws(() => engine.evaluate(response, [{ type: "json", path: "$[x]", expected: "x" }]), /numeric array indexes/u);
  assert.throws(() => engine.evaluate(response, [{ type: "regex", pattern: "(", flags: "" }]), /Invalid regular expression/u);
  assert.throws(() => engine.evaluate(response, [{ type: "regex", pattern: "x", flags: "g" }]), /flags/u);
  assert.throws(() => engine.evaluate(response, [{ type: "status", expected: 99 }]), /HTTP status/u);
  assert.throws(() => engine.evaluate(response, [{ type: "number", path: "$.data.user.id", operator: "between", expected: [4, 2] }]), /ordered numeric pair/u);
});

test("text and array contains assertions support both targets", () => {
  const result = engine.evaluate(response, [
    { type: "contains", target: "text", expected: "message" },
    { type: "contains", path: "$.data.items", expected: 4 }
  ]);
  assert.equal(result.passed, true);
});

test("accepts null, object, and boolean JSON type checks", () => {
  const result = engine.evaluate({ json: { a: null, b: {}, c: false } }, [
    { type: "type", path: "$.a", expected: "null" },
    { type: "type", path: "$.b", expected: "object" },
    { type: "type", path: "$.c", expected: "boolean" }
  ]);
  assert.equal(result.passed, true);
});
