import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = path.join(repositoryRoot, "packages", "security-guard-core");

async function findFiles(directory, suffix) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findFiles(fullPath, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(fullPath);
  }
  return found;
}

function validateSchema(schema, value, location = "$") {
  const issues = [];
  const matchesType = (type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "integer") return Number.isSafeInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    return typeof value === type;
  };

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(matchesType)) return [location + ": type mismatch"];
  }
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(value, schema.const)) {
    issues.push(location + ": const mismatch");
  }
  if (schema.enum && !schema.enum.some((item) => isDeepStrictEqual(item, value))) {
    issues.push(location + ": enum mismatch");
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push(location + ": pattern mismatch");
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(location + ": minLength");
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push(location + ": maxLength");
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      issues.push(location + ": invalid UUID");
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(location + ": minimum");
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(location + ": maximum");
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) issues.push(location + "." + key + ": required");
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) issues.push(location + "." + key + ": additional property");
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) issues.push(...validateSchema(childSchema, value[key], location + "." + key));
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(location + ": minItems");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(location + ": maxItems");
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      issues.push(location + ": duplicate items");
    }
    if (schema.items) value.forEach((item, index) => issues.push(...validateSchema(schema.items, item, location + "[" + index + "]")));
  }
  for (const branch of schema.allOf ?? []) issues.push(...validateSchema(branch, value, location));
  if (schema.if && validateSchema(schema.if, value, location).length === 0 && schema.then) {
    issues.push(...validateSchema(schema.then, value, location));
  }
  return issues;
}

const schemaFiles = await findFiles(path.join(coreRoot, "contracts"), ".schema.json");
const schemaEntries = await Promise.all(schemaFiles.map(async (file) => ({
  file,
  schema: JSON.parse(await readFile(file, "utf8"))
})));
const schemasById = new Map(schemaEntries.map(({ schema }) => [schema.$id, schema]));

test("Core contracts use unique Draft 2020-12 strict object schemas", () => {
  assert.ok(schemaEntries.length >= 8);
  assert.equal(schemasById.size, schemaEntries.length, "schema $id values must be unique");
  for (const { file, schema } of schemaEntries) {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", file);
    assert.equal(schema.type, "object", file);
    assert.equal(schema.additionalProperties, false, file);
    assert.ok(Array.isArray(schema.required) && schema.required.length > 0, file);
    for (const field of schema.required) assert.ok(Object.hasOwn(schema.properties ?? {}, field), file + ": " + field);
  }
});

const fixtureSchemas = [
  ["rate-limit/check-request.valid.json", "urn:jb:security-guard:rate-limit:check-request:v1"],
  ["rate-limit/decision-allowed.valid.json", "urn:jb:security-guard:rate-limit:decision:v1"],
  ["rate-limit/decision-blocked.valid.json", "urn:jb:security-guard:rate-limit:decision:v1"],
  ["policies/rate-limit-policy.valid.json", "urn:jb:security-guard:policies:rate-limit:v1"],
  ["authentication/attempt-failed.valid.json", "urn:jb:security-guard:authentication:attempt:v1"],
  ["authentication/decision-unavailable.valid.json", "urn:jb:security-guard:authentication:decision:v1"],
  ["security-events/request-blocked.valid.json", "urn:jb:security-guard:security-event:v1"],
  ["threat-detection/signal-brute-force.valid.json", "urn:jb:security-guard:threat-signal:v1"],
  ["threat-detection/assessment-observe.valid.json", "urn:jb:security-guard:threat-assessment:v1"]
];

for (const [relativePath, schemaId] of fixtureSchemas) {
  test("Core fixture conforms to " + schemaId + ": " + relativePath, async () => {
    const fixture = JSON.parse(await readFile(path.join(coreRoot, "tests", "fixtures", relativePath), "utf8"));
    const schema = schemasById.get(schemaId);
    assert.ok(schema, "schema must exist: " + schemaId);
    assert.deepEqual(validateSchema(schema, fixture), []);
  });
}

test("rate-limit wire request rejects raw identity fields", async () => {
  const fixture = JSON.parse(await readFile(path.join(coreRoot, "tests/fixtures/rate-limit/check-request.valid.json"), "utf8"));
  fixture.identity.rawIp = "203.0.113.9";
  const schema = schemasById.get("urn:jb:security-guard:rate-limit:check-request:v1");
  assert.ok(validateSchema(schema, fixture).some((issue) => issue.includes("additional property")));
});

test("rate-limit decision rejects an incoherent enforced 429", async () => {
  const fixture = JSON.parse(await readFile(path.join(coreRoot, "tests/fixtures/rate-limit/decision-blocked.valid.json"), "utf8"));
  fixture.unavailable = true;
  const schema = schemasById.get("urn:jb:security-guard:rate-limit:decision:v1");
  assert.ok(validateSchema(schema, fixture).length > 0);
});
