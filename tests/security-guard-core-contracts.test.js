import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  validateRateLimitCheckV1,
  validateRateLimitDecisionV1,
  validateAuthenticationAttemptV1,
  validateAuthenticationDecisionV1,
  validateSecurityEventV1,
  validateRateLimitPolicyV1,
  validateThreatSignalV1,
  validateThreatAssessmentV1,
  validateThreatAssessmentPolicyV1,
  validateUploadInspectionAttestationV1
} from "@jb/security-guard/core-contract-v1";
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
  ["rate-limit/decision-fail-open.valid.json", "urn:jb:security-guard:rate-limit:decision:v1"],
  ["policies/rate-limit-policy.valid.json", "urn:jb:security-guard:policies:rate-limit:v1"],
  ["authentication/attempt-failed.valid.json", "urn:jb:security-guard:authentication:attempt:v1"],
  ["authentication/decision-unavailable.valid.json", "urn:jb:security-guard:authentication:decision:v1"],
  ["security-events/request-blocked.valid.json", "urn:jb:security-guard:security-event:v1"],
  ["threat-detection/signal-brute-force.valid.json", "urn:jb:security-guard:threat-signal:v1"],
  ["threat-detection/assessment-observe.valid.json", "urn:jb:security-guard:threat-assessment:v1"],
  ["threat-detection/assessment-policy.valid.json", "urn:jb:security-guard:threat-assessment-policy:v1"]
];

const runtimeValidators = new Map([
  ["urn:jb:security-guard:rate-limit:check-request:v1", validateRateLimitCheckV1],
  ["urn:jb:security-guard:rate-limit:decision:v1", validateRateLimitDecisionV1],
  ["urn:jb:security-guard:policies:rate-limit:v1", validateRateLimitPolicyV1],
  ["urn:jb:security-guard:authentication:attempt:v1", validateAuthenticationAttemptV1],
  ["urn:jb:security-guard:authentication:decision:v1", validateAuthenticationDecisionV1],
  ["urn:jb:security-guard:security-event:v1", validateSecurityEventV1],
  ["urn:jb:security-guard:threat-signal:v1", validateThreatSignalV1],
  ["urn:jb:security-guard:threat-assessment:v1", validateThreatAssessmentV1],
  ["urn:jb:security-guard:threat-assessment-policy:v1", validateThreatAssessmentPolicyV1]
]);

for (const [relativePath, schemaId] of fixtureSchemas) {
  test("Core fixture conforms to " + schemaId + ": " + relativePath, async () => {
    const fixture = JSON.parse(await readFile(path.join(coreRoot, "tests", "fixtures", relativePath), "utf8"));
    const schema = schemasById.get(schemaId);
    assert.ok(schema, "schema must exist: " + schemaId);
    assert.deepEqual(validateSchema(schema, fixture), []);
  });

  test("JavaScript runtime validator accepts shared Core fixture: " + relativePath, async () => {
    const fixture = JSON.parse(await readFile(path.join(coreRoot, "tests", "fixtures", relativePath), "utf8"));
    const validate = runtimeValidators.get(schemaId);
    assert.equal(typeof validate, "function", "runtime validator must exist for " + schemaId);
    assert.doesNotThrow(() => validate(fixture));
  });
}

test("JSON Schema and JavaScript validators reject undeclared fields for every shared fixture", async () => {
  for (const [relativePath, schemaId] of fixtureSchemas) {
    const fixture = JSON.parse(await readFile(path.join(coreRoot, "tests", "fixtures", relativePath), "utf8"));
    const invalid = { ...fixture, rawCredentialLeak: "must-never-cross-contract" };
    const schema = schemasById.get(schemaId);
    const validate = runtimeValidators.get(schemaId);
    assert.ok(validateSchema(schema, invalid).some((issue) => issue.includes("additional property")), relativePath);
    assert.throws(() => validate(invalid), relativePath);
  }
});

test("authentication schema and runtime validator agree on nullable client key pairing", async () => {
  const fixture = JSON.parse(await readFile(path.join(coreRoot, "tests/fixtures/authentication/attempt-failed.valid.json"), "utf8"));
  fixture.client = { key: null, keyId: "client-key" };
  const schema = schemasById.get("urn:jb:security-guard:authentication:attempt:v1");
  assert.ok(validateSchema(schema, fixture).length > 0);
  assert.throws(() => validateAuthenticationAttemptV1(fixture));
});

test("event and threat schemas and runtime validators require key IDs for opaque subject keys", async () => {
  const cases = [
    ["security-events/request-blocked.valid.json", "urn:jb:security-guard:security-event:v1", validateSecurityEventV1],
    ["threat-detection/signal-brute-force.valid.json", "urn:jb:security-guard:threat-signal:v1", validateThreatSignalV1]
  ];
  for (const [relativePath, schemaId, validate] of cases) {
    const fixture = JSON.parse(await readFile(path.join(coreRoot, "tests/fixtures", relativePath), "utf8"));
    delete fixture.subjectKeyId;
    const schema = schemasById.get(schemaId);
    assert.ok(validateSchema(schema, fixture).length > 0, relativePath);
    assert.throws(() => validate(fixture), relativePath);
  }
});

test("rate-limit decision schema and runtime validator reject incoherent enforced decisions", async () => {
  const fixture = JSON.parse(await readFile(path.join(coreRoot, "tests/fixtures/rate-limit/decision-blocked.valid.json"), "utf8"));
  fixture.unavailable = true;
  const schema = schemasById.get("urn:jb:security-guard:rate-limit:decision:v1");
  assert.ok(validateSchema(schema, fixture).length > 0);
  assert.throws(() => validateRateLimitDecisionV1(fixture));
});

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

test("Upload Scan v1 request/result schemas enforce exact identity, digest, bounds and complete consumption", async () => {
  const requestSchema = schemasById.get("urn:jb:security-guard:upload-scan-request:v1");
  const resultSchema = schemasById.get("urn:jb:security-guard:upload-scan-result:v1");
  assert.ok(requestSchema);
  assert.ok(resultSchema);

  const fixtureRoot = path.join(coreRoot, "tests", "fixtures", "upload-inspection");
  const request = JSON.parse(await readFile(path.join(fixtureRoot, "scan-request.valid.json"), "utf8"));
  const cleanResult = JSON.parse(await readFile(path.join(fixtureRoot, "scan-result-clean.valid.json"), "utf8"));
  const incompleteResult = JSON.parse(await readFile(path.join(fixtureRoot, "scan-result-incomplete.invalid.json"), "utf8"));

  assert.deepEqual(validateSchema(requestSchema, request), []);
  assert.deepEqual(validateSchema(resultSchema, cleanResult), []);
  assert.ok(
    validateSchema(resultSchema, incompleteResult).some((issue) => issue.includes("const mismatch")),
    "a result cannot claim complete conformance unless streamConsumed is true"
  );

  const mismatched = { ...cleanResult, sha256: "b".repeat(64) };
  assert.deepEqual(validateSchema(resultSchema, mismatched), []);
  assert.notEqual(mismatched.sha256, request.sha256);
  assert.equal(mismatched.uploadId, request.uploadId);
  assert.equal(mismatched.size, request.size);

  for (const invalid of [
    { ...request, size: 0 },
    { ...request, sha256: "not-a-digest" },
    { ...request, detectedMimeType: "image/svg+xml" },
    { ...request, rawBody: "not-allowed" }
  ]) {
    assert.notDeepEqual(validateSchema(requestSchema, invalid), []);
  }

  for (const invalid of [
    { ...cleanResult, verdict: "maybe-clean" },
    { ...cleanResult, uploadId: "../outside" },
    { ...cleanResult, scanner: { id: "scanner" } },
    { ...cleanResult, untrustedMetadata: { rawName: "customer.pdf" } }
  ]) {
    assert.notDeepEqual(validateSchema(resultSchema, invalid), []);
  }
});

test("shared upload inspection vectors remain deterministic and bounded", async () => {
  const fixturePath = path.join(
    coreRoot,
    "tests",
    "fixtures",
    "upload-inspection",
    "conformance-vectors.v1.json"
  );
  const vectors = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(vectors.schema, "jb.security.upload-inspection.conformance/v1");
  assert.equal(vectors.fileCases.length, 9);
  assert.equal(vectors.scannerCases.length, 4);

  for (const item of [...vectors.fileCases, ...vectors.scannerCases]) {
    assert.match(item.id, /^[a-z0-9-]{1,80}$/);
  }
  for (const item of vectors.fileCases) {
    assert.match(item.bytesHex, /^(?:[0-9a-f]{2})+$/);
    assert.ok(Buffer.from(item.bytesHex, "hex").length <= 4096);
    assert.ok(["approved", "rejected"].includes(item.expected.disposition));
  }
  for (const item of vectors.scannerCases) {
    assert.ok(["clean", "malicious", "unknown"].includes(item.verdict));
    assert.ok(["all", "none"].includes(item.consume));
    assert.ok(["approved", "rejected", "quarantined"].includes(item.expected.disposition));
  }
});

\ntest("upload inspection attestation schema and runtime validator bind exact object evidence", async () => {
  const schema = schemasById.get("urn:jb:security-guard:upload-inspection:attestation:v1");
  assert.ok(schema);
  const fixtureRoot = path.join(coreRoot, "tests", "fixtures", "upload-inspection");
  for (const [name, verdict] of [
    ["attestation-clean.valid.json", "clean"],
    ["attestation-malicious.valid.json", "malicious"],
    ["attestation-unknown.valid.json", "unknown"]
  ]) {
    const fixture = JSON.parse(await readFile(path.join(fixtureRoot, name), "utf8"));
    assert.deepEqual(validateSchema(schema, fixture), []);
    assert.equal(validateUploadInspectionAttestationV1(fixture).verdict, verdict);
  }

  const clean = JSON.parse(await readFile(path.join(fixtureRoot, "attestation-clean.valid.json"), "utf8"));
  for (const invalid of [
    { ...clean, sha256: "A".repeat(64) },
    { ...clean, size: 0 },
    { ...clean, size: 104857601 },
    { ...clean, mimeType: "application/x-msdownload" },
    { ...clean, verdict: "no_match" },
    { ...clean, engine: "" },
    { ...clean, originalFileName: "customer-secret.png" }
  ]) {
    assert.notDeepEqual(validateSchema(schema, invalid), []);
    assert.throws(() => validateUploadInspectionAttestationV1(invalid));
  }

  const evidence = validateUploadInspectionAttestationV1(clean);
  assert.equal(Object.hasOwn(evidence, "approved"), false);
  assert.equal(Object.hasOwn(evidence, "promoted"), false);
});
