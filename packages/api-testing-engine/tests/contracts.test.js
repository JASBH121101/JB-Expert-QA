import test from "node:test";
import assert from "node:assert/strict";
import {
  API_CONTRACT_TESTING_ENGINE_ID,
  ApiContractError,
  createApiContractTestingEngine
} from "../src/index.js";

const engine = createApiContractTestingEngine();

function contract(overrides = {}) {
  return {
    schema: "jb.api-contract/v1",
    contractId: "example.users",
    version: "1.0.0",
    title: "Users API",
    operations: [{
      operationId: "getUser",
      method: "GET",
      path: "/v1/users/{userId}",
      responses: {
        "200": {
          headers: {
            "content-type": { contains: "application/json" },
            "x-request-id": { required: true }
          },
          body: {
            type: "object",
            required: ["data"],
            additionalProperties: false,
            properties: {
              data: {
                type: "object",
                required: ["id", "name", "active", "roles"],
                additionalProperties: false,
                properties: {
                  id: { type: "integer", minimum: 1 },
                  name: { type: "string", minLength: 2, maxLength: 80 },
                  active: { type: "boolean" },
                  roles: { type: "array", minItems: 1, items: { type: "string", enum: ["admin", "user"] } }
                }
              }
            }
          }
        },
        "404": {
          headers: { "content-type": "application/json" },
          body: {
            type: "object",
            required: ["error"],
            additionalProperties: false,
            properties: { error: { type: "string", const: "not_found" } }
          }
        }
      }
    }],
    ...overrides
  };
}

function response(overrides = {}) {
  return {
    method: "GET",
    url: "https://api.example.com/v1/users/42?trace=1",
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": "req-123"
    },
    jsonParsed: true,
    json: {
      data: {
        id: 42,
        name: "Steven",
        active: true,
        roles: ["admin", "user"]
      }
    },
    ...overrides
  };
}

test("engine identity, compilation and valid response contract", () => {
  const compiled = engine.compile(contract());
  const result = compiled.validate(response(), { operationId: "getUser" });
  assert.equal(engine.engineId, API_CONTRACT_TESTING_ENGINE_ID);
  assert.equal(compiled.contractId, "example.users");
  assert.deepEqual(compiled.operationIds, ["getUser"]);
  assert.equal(result.engineId, API_CONTRACT_TESTING_ENGINE_ID);
  assert.equal(result.passed, true);
  assert.equal(result.failedCount, 0);
  assert.equal(result.passRate, 100);
  assert.ok(result.total >= 5);
});

test("validates HTTP method, path template and declared response status", () => {
  const compiled = engine.compile(contract());
  const wrongMethod = compiled.validate(response({ method: "POST" }), { operationId: "getUser" });
  assert.equal(wrongMethod.passed, false);
  assert.ok(wrongMethod.results.some((item) => item.code === "METHOD_MATCH" && !item.passed));

  const wrongPath = compiled.validate(response({ url: "https://api.example.com/v1/teams/42" }), { operationId: "getUser" });
  assert.ok(wrongPath.results.some((item) => item.code === "PATH_MATCH" && !item.passed));

  const undeclared = compiled.validate(response({ status: 202 }), { operationId: "getUser" });
  assert.ok(undeclared.results.some((item) => item.code === "DECLARED_STATUS" && !item.passed));
});

test("validates required fields, nested types, enums, numeric bounds and additional properties", () => {
  const compiled = engine.compile(contract());
  const result = compiled.validate(response({
    json: {
      data: {
        id: 0,
        name: "A",
        active: "yes",
        roles: ["root"],
        unexpected: true
      }
    }
  }), { operationId: "getUser" });
  assert.equal(result.passed, false);
  const codes = result.results.filter((item) => !item.passed).map((item) => item.code);
  assert.ok(codes.includes("MINIMUM"));
  assert.ok(codes.includes("MIN_LENGTH"));
  assert.ok(codes.includes("TYPE_MISMATCH"));
  assert.ok(codes.includes("ENUM_MISMATCH"));
  assert.ok(codes.includes("ADDITIONAL_PROPERTY"));
});

test("reports missing required properties and does not echo response strings", () => {
  const compiled = engine.compile(contract());
  const secretLikeValue = "private-user-token-value-".repeat(5);
  const result = compiled.validate(response({ json: { data: { id: 42, name: secretLikeValue, roles: ["admin"] } } }), { operationId: "getUser" });
  assert.equal(result.passed, false);
  assert.ok(result.results.some((item) => item.code === "REQUIRED_PROPERTY"));
  const nameCheck = result.results.find((item) => item.path === "$.data.name" && item.code === "MAX_LENGTH");
  assert.equal(nameCheck.actual, secretLikeValue.length);
  assert.equal(JSON.stringify(result).includes(secretLikeValue), false);
});

test("selects the default response case when a status has no exact declaration", () => {
  const compiled = engine.compile(contract({
    operations: [{
      operationId: "getUser",
      method: "GET",
      path: "/v1/users/{userId}",
      responses: {
        default: {
          headers: { "content-type": { contains: "json" } },
          body: { type: "object", required: ["error"], properties: { error: { type: "string" } } }
        }
      }
    }]
  }));
  const result = compiled.validate(response({
    status: 503,
    json: { error: "temporarily_unavailable" }
  }), { operationId: "getUser" });
  assert.equal(result.passed, true);
});

test("validates an explicit 404 response body", () => {
  const compiled = engine.compile(contract());
  const result = compiled.validate(response({
    status: 404,
    json: { error: "not_found" }
  }), { operationId: "getUser" });
  assert.equal(result.passed, true);
});

test("checks required, optional, exact and contains response headers", () => {
  const compiled = engine.compile(contract({
    operations: [{
      operationId: "getUser",
      method: "GET",
      path: "/v1/users/{userId}",
      responses: {
        "200": {
          headers: {
            "content-type": "application/json",
            "x-optional": { required: false },
            "x-trace": { contains: "trace-" }
          }
        }
      }
    }]
  }));
  const result = compiled.validate(response({
    headers: { "Content-Type": "text/plain", "x-trace": "trace-42" }
  }), { operationId: "getUser" });
  assert.equal(result.passed, false);
  assert.ok(result.results.some((item) => item.path === "$.headers.content-type" && !item.passed));
  assert.ok(result.results.some((item) => item.path === "$.headers.x-optional" && item.passed));
  assert.ok(result.results.some((item) => item.path === "$.headers.x-trace" && item.passed));
});

test("fails safely when the contract requires JSON but the Request Engine did not parse it", () => {
  const compiled = engine.compile(contract());
  const result = compiled.validate(response({ jsonParsed: false, json: null }), { operationId: "getUser" });
  assert.ok(result.results.some((item) => item.code === "JSON_BODY_UNAVAILABLE" && !item.passed));
});

test("rejects unsupported schema keywords instead of silently ignoring them", () => {
  const invalid = contract();
  invalid.operations[0].responses["200"].body.pattern = ".*";
  assert.throws(() => engine.compile(invalid), (error) => error instanceof ApiContractError && error.code === "UNSUPPORTED_FIELD");
  const withRef = contract();
  withRef.operations[0].responses["200"].body.$ref = "https://example.test/schema.json";
  assert.throws(() => engine.compile(withRef), /unsupported field/u);
});

test("rejects unsafe fields, accessors, invalid path templates and invalid schema bounds", () => {
  const invalidVersion = contract({ version: "1.0.0-beta" });
  assert.throws(() => engine.compile(invalidVersion), /stable MAJOR.MINOR.PATCH/u);

  const invalidPath = contract();
  invalidPath.operations[0].path = "/v1/users/../{userId}";
  assert.throws(() => engine.compile(invalidPath), /dot segments/u);

  const invalidRange = contract();
  invalidRange.operations[0].responses["200"].body.properties.data.properties.id.minimum = 10;
  invalidRange.operations[0].responses["200"].body.properties.data.properties.id.maximum = 5;
  assert.throws(() => engine.compile(invalidRange), /minimum cannot exceed maximum/u);

  let getterCalled = false;
  const accessor = contract();
  Object.defineProperty(accessor, "title", { enumerable: true, get() { getterCalled = true; return "unsafe"; } });
  assert.throws(() => engine.compile(accessor), /getters or setters/u);
  assert.equal(getterCalled, false);
});

test("rejects prototype-pollution keys and duplicate operation identifiers", () => {
  const unsafe = JSON.parse('{"schema":"jb.api-contract/v1","contractId":"example.users","version":"1.0.0","operations":[{"operationId":"getUser","method":"GET","path":"/users","responses":{"200":{"body":{"type":"object","properties":{"__proto__":{"type":"string"}}}}}}]}');
  assert.throws(() => engine.compile(unsafe), /forbidden object key/u);

  const duplicate = contract({
    operations: [
      contract().operations[0],
      { ...contract().operations[0], path: "/v1/other/{otherId}" }
    ]
  });
  assert.throws(() => engine.compile(duplicate), /operationId must be unique/u);
});

test("rejects unknown operations and unsupported validation options", () => {
  const compiled = engine.compile(contract());
  assert.throws(() => compiled.validate(response(), { operationId: "missing" }), /not declared/u);
  assert.throws(() => compiled.validate(response(), { operationId: "getUser", allowNetwork: true }), /only support operationId/u);
});

test("requires bounded plain response data and rejects response getters", () => {
  const compiled = engine.compile(contract());
  const unsafeResponse = response();
  Object.defineProperty(unsafeResponse, "json", { enumerable: true, get() { throw new Error("must not execute"); } });
  assert.throws(() => compiled.validate(unsafeResponse, { operationId: "getUser" }), /accessor properties/u);
});

test("rejects response header accessors without executing them", () => {
  const compiled = engine.compile(contract());
  let getterCalled = false;
  const unsafeHeaders = {};
  Object.defineProperty(unsafeHeaders, "content-type", {
    enumerable: true,
    get() { getterCalled = true; return "application/json"; }
  });
  const result = compiled.validate(response({ headers: unsafeHeaders }), { operationId: "getUser" });
  assert.equal(result.passed, false);
  assert.equal(getterCalled, false);
  assert.ok(result.results.some((item) => item.code === "INVALID_RESPONSE_HEADERS"));
});

test("rejects validation-option getters without executing them", () => {
  const compiled = engine.compile(contract());
  let getterCalled = false;
  const options = {};
  Object.defineProperty(options, "operationId", {
    enumerable: true,
    get() { getterCalled = true; return "getUser"; }
  });
  assert.throws(() => compiled.validate(response(), options), /cannot contain accessors/u);
  assert.equal(getterCalled, false);
});


test("rejects array accessors in contract documents without executing them", () => {
  const invalid = contract();
  const required = invalid.operations[0].responses["200"].body.properties.data.required;
  let getterCalled = false;
  Object.defineProperty(required, "0", {
    enumerable: true,
    configurable: true,
    get() { getterCalled = true; return "id"; }
  });
  assert.throws(() => engine.compile(invalid), /accessors/u);
  assert.equal(getterCalled, false);
});
