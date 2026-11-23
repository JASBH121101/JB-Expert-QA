const METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "null", "object", "array"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_CONTRACT_OPERATIONS = 200;
const MAX_SCHEMA_NODES = 2000;
const MAX_SCHEMA_DEPTH = 20;
const MAX_RESULT_ERRORS = 1000;

export const API_CONTRACT_TESTING_ENGINE_ID = "jb.api-contract-testing-engine";
export const API_CONTRACT_TESTING_ENGINE_VERSION = "0.1.0";

export class ApiContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiContractError";
    this.code = code;
  }
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonSafe(value, label, limits = {}) {
  const maximumDepth = limits.maximumDepth ?? 24;
  const maximumNodes = limits.maximumNodes ?? 50000;
  const seen = new Set();
  let nodes = 0;

  function visit(item, depth) {
    nodes += 1;
    if (nodes > maximumNodes) throw new TypeError(label + " exceeds the maximum value count");
    if (depth > maximumDepth) throw new TypeError(label + " exceeds the maximum JSON depth");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError(label + " contains a non-finite number");
      return;
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) throw new TypeError(label + " cannot contain circular data");
      seen.add(item);
      for (let index = 0; index < item.length; index += 1) {
        if (!Object.hasOwn(item, index)) throw new TypeError(label + " cannot contain sparse arrays");
        visit(item[index], depth + 1);
      }
      seen.delete(item);
      return;
    }
    if (!isRecord(item)) throw new TypeError(label + " must contain plain JSON objects only");
    if (seen.has(item)) throw new TypeError(label + " cannot contain circular data");
    seen.add(item);
    for (const key of Object.keys(item)) {
      if (FORBIDDEN_KEYS.has(key)) throw new TypeError(label + " contains a forbidden object key");
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError(label + " cannot contain getters or setters");
      }
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  }

  visit(value, 0);
}

function assertKnownKeys(record, allowed, label) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new ApiContractError("UNSUPPORTED_FIELD", label + " contains an unsupported field: " + key);
    }
  }
}

function requireString(value, label, maximum = 256) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value) {
    throw new ApiContractError("INVALID_CONTRACT", label + " must be a non-empty string of at most " + maximum + " characters");
  }
  return value;
}

function validatePathTemplate(value, label) {
  requireString(value, label, 2048);
  if (!value.startsWith("/") || value.includes("?") || value.includes("#") ||
      value.includes("\\") || /\s/u.test(value) || value.includes("//")) {
    throw new ApiContractError("INVALID_PATH_TEMPLATE", label + " must be an absolute path template without query, fragment, whitespace or duplicate slashes");
  }
  const segments = value.slice(1).split("/");
  const parameters = new Set();
  for (const segment of segments) {
    if (segment === "") continue;
    let decoded;
    try { decoded = decodeURIComponent(segment); }
    catch { throw new ApiContractError("INVALID_PATH_TEMPLATE", label + " contains malformed percent encoding"); }
    if (decoded === "." || decoded === "..") {
      throw new ApiContractError("INVALID_PATH_TEMPLATE", label + " cannot contain dot segments");
    }
    if (segment.startsWith("{") || segment.endsWith("}")) {
      const match = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/u.exec(segment);
      if (!match) throw new ApiContractError("INVALID_PATH_TEMPLATE", label + " contains an invalid path parameter");
      if (parameters.has(match[1])) throw new ApiContractError("INVALID_PATH_TEMPLATE", label + " contains a duplicate path parameter");
      parameters.add(match[1]);
    } else if (segment.includes("{") || segment.includes("}")) {
      throw new ApiContractError("INVALID_PATH_TEMPLATE", label + " path parameters must occupy a complete segment");
    }
  }
  return value;
}

function validateHeaderRules(headers, label) {
  if (!isRecord(headers)) throw new ApiContractError("INVALID_CONTRACT", label + " must be a plain object");
  const names = Object.keys(headers);
  if (names.length > 100) throw new ApiContractError("INVALID_CONTRACT", label + " cannot contain more than 100 headers");
  const normalized = new Set();
  for (const name of names) {
    if (!/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]{1,128}$/u.test(name)) {
      throw new ApiContractError("INVALID_HEADER_RULE", label + " contains an invalid header name");
    }
    const lower = name.toLowerCase();
    if (normalized.has(lower)) throw new ApiContractError("INVALID_HEADER_RULE", label + " contains duplicate header names");
    normalized.add(lower);
    const rule = headers[name];
    if (typeof rule === "string") {
      requireString(rule, label + "." + name, 1024);
      continue;
    }
    if (!isRecord(rule)) throw new ApiContractError("INVALID_HEADER_RULE", label + "." + name + " must be a string or header rule");
    assertKnownKeys(rule, new Set(["required", "equals", "contains"]), label + "." + name);
    if (rule.required !== undefined && typeof rule.required !== "boolean") {
      throw new ApiContractError("INVALID_HEADER_RULE", label + "." + name + ".required must be boolean");
    }
    if (rule.equals !== undefined) requireString(rule.equals, label + "." + name + ".equals", 1024);
    if (rule.contains !== undefined) requireString(rule.contains, label + "." + name + ".contains", 1024);
    if (rule.equals === undefined && rule.contains === undefined && rule.required !== true) {
      throw new ApiContractError("INVALID_HEADER_RULE", label + "." + name + " must define equals, contains or required: true");
    }
  }
}

function validateSchemaNode(schema, label, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) throw new ApiContractError("SCHEMA_TOO_COMPLEX", "Contract schema exceeds " + MAX_SCHEMA_NODES + " nodes");
  if (depth > MAX_SCHEMA_DEPTH) throw new ApiContractError("SCHEMA_TOO_DEEP", "Contract schema exceeds maximum depth " + MAX_SCHEMA_DEPTH);
  if (!isRecord(schema)) throw new ApiContractError("INVALID_SCHEMA", label + " must be a plain schema object");

  const allowed = new Set([
    "type", "required", "properties", "additionalProperties", "items", "enum", "const",
    "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "minItems", "maxItems", "minProperties", "maxProperties"
  ]);
  assertKnownKeys(schema, allowed, label);

  if (schema.type !== undefined && !SCHEMA_TYPES.has(schema.type)) {
    throw new ApiContractError("INVALID_SCHEMA", label + ".type is unsupported");
  }

  const type = schema.type;
  const objectCompatible = type === undefined || type === "object";
  const arrayCompatible = type === undefined || type === "array";
  const stringCompatible = type === undefined || type === "string";
  const numberCompatible = type === undefined || type === "number" || type === "integer";

  if (schema.required !== undefined) {
    if (!objectCompatible || !Array.isArray(schema.required) || schema.required.length > 200) {
      throw new ApiContractError("INVALID_SCHEMA", label + ".required must be an array on an object schema");
    }
    const seen = new Set();
    for (const name of schema.required) {
      if (typeof name !== "string" || !name || FORBIDDEN_KEYS.has(name) || name.length > 256 || seen.has(name)) {
        throw new ApiContractError("INVALID_SCHEMA", label + ".required contains an invalid or duplicate property name");
      }
      seen.add(name);
    }
  }

  if (schema.properties !== undefined) {
    if (!objectCompatible || !isRecord(schema.properties) || Object.keys(schema.properties).length > 200) {
      throw new ApiContractError("INVALID_SCHEMA", label + ".properties must be a bounded object schema map");
    }
    for (const [name, child] of Object.entries(schema.properties)) {
      if (!name || FORBIDDEN_KEYS.has(name) || name.length > 256) {
        throw new ApiContractError("INVALID_SCHEMA", label + ".properties contains an unsafe property name");
      }
      validateSchemaNode(child, label + ".properties." + name, state, depth + 1);
    }
  }

  if (schema.additionalProperties !== undefined) {
    if (!objectCompatible) throw new ApiContractError("INVALID_SCHEMA", label + ".additionalProperties requires an object schema");
    if (typeof schema.additionalProperties !== "boolean") {
      validateSchemaNode(schema.additionalProperties, label + ".additionalProperties", state, depth + 1);
    }
  }

  if (schema.items !== undefined) {
    if (!arrayCompatible) throw new ApiContractError("INVALID_SCHEMA", label + ".items requires an array schema");
    validateSchemaNode(schema.items, label + ".items", state, depth + 1);
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length < 1 || schema.enum.length > 100) {
      throw new ApiContractError("INVALID_SCHEMA", label + ".enum must contain between 1 and 100 values");
    }
    const serialized = new Set();
    for (const value of schema.enum) {
      assertJsonSafe(value, label + ".enum value");
      const key = JSON.stringify(value);
      if (serialized.has(key)) throw new ApiContractError("INVALID_SCHEMA", label + ".enum cannot contain duplicate values");
      serialized.add(key);
    }
  }
  if (schema.const !== undefined) assertJsonSafe(schema.const, label + ".const");

  for (const key of ["minLength", "maxLength"]) {
    if (schema[key] !== undefined && (!stringCompatible || !Number.isSafeInteger(schema[key]) || schema[key] < 0 || schema[key] > 1000000)) {
      throw new ApiContractError("INVALID_SCHEMA", label + "." + key + " must be a bounded non-negative integer on a string schema");
    }
  }
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) {
    throw new ApiContractError("INVALID_SCHEMA", label + " minLength cannot exceed maxLength");
  }

  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (schema[key] !== undefined && (!numberCompatible || typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) {
      throw new ApiContractError("INVALID_SCHEMA", label + "." + key + " must be a finite number on a numeric schema");
    }
  }
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
    throw new ApiContractError("INVALID_SCHEMA", label + " minimum cannot exceed maximum");
  }
  if (schema.exclusiveMinimum !== undefined && schema.exclusiveMaximum !== undefined && schema.exclusiveMinimum >= schema.exclusiveMaximum) {
    throw new ApiContractError("INVALID_SCHEMA", label + " exclusiveMinimum must be lower than exclusiveMaximum");
  }

  for (const key of ["minItems", "maxItems"]) {
    if (schema[key] !== undefined && (!arrayCompatible || !Number.isSafeInteger(schema[key]) || schema[key] < 0 || schema[key] > 1000000)) {
      throw new ApiContractError("INVALID_SCHEMA", label + "." + key + " must be a bounded non-negative integer on an array schema");
    }
  }
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) {
    throw new ApiContractError("INVALID_SCHEMA", label + " minItems cannot exceed maxItems");
  }

  for (const key of ["minProperties", "maxProperties"]) {
    if (schema[key] !== undefined && (!objectCompatible || !Number.isSafeInteger(schema[key]) || schema[key] < 0 || schema[key] > 1000000)) {
      throw new ApiContractError("INVALID_SCHEMA", label + "." + key + " must be a bounded non-negative integer on an object schema");
    }
  }
  if (schema.minProperties !== undefined && schema.maxProperties !== undefined && schema.minProperties > schema.maxProperties) {
    throw new ApiContractError("INVALID_SCHEMA", label + " minProperties cannot exceed maxProperties");
  }
}

function validateContractDefinition(contract) {
  if (!isRecord(contract)) throw new ApiContractError("INVALID_CONTRACT", "contract must be a plain object");
  try { assertJsonSafe(contract, "contract", { maximumDepth: 24, maximumNodes: 50000 }); }
  catch (error) { throw new ApiContractError("UNSAFE_CONTRACT", error.message); }

  assertKnownKeys(contract, new Set(["schema", "contractId", "version", "title", "operations"]), "contract");
  if (contract.schema !== "jb.api-contract/v1") {
    throw new ApiContractError("UNSUPPORTED_CONTRACT_SCHEMA", "contract.schema must be jb.api-contract/v1");
  }
  requireString(contract.contractId, "contract.contractId", 128);
  if (!/^[a-z][a-z0-9._-]*$/u.test(contract.contractId)) {
    throw new ApiContractError("INVALID_CONTRACT", "contract.contractId must be a stable lowercase identifier");
  }
  requireString(contract.version, "contract.version", 32);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(contract.version)) {
    throw new ApiContractError("INVALID_CONTRACT", "contract.version must use stable MAJOR.MINOR.PATCH notation");
  }
  if (contract.title !== undefined) requireString(contract.title, "contract.title", 200);
  if (!Array.isArray(contract.operations) || contract.operations.length < 1 || contract.operations.length > MAX_CONTRACT_OPERATIONS) {
    throw new ApiContractError("INVALID_CONTRACT", "contract.operations must contain between 1 and " + MAX_CONTRACT_OPERATIONS + " operations");
  }

  const operationIds = new Set();
  const routeKeys = new Set();
  let schemaNodes = 0;
  for (let index = 0; index < contract.operations.length; index += 1) {
    const operation = contract.operations[index];
    const label = "contract.operations[" + index + "]";
    if (!isRecord(operation)) throw new ApiContractError("INVALID_OPERATION", label + " must be a plain object");
    assertKnownKeys(operation, new Set(["operationId", "method", "path", "responses"]), label);
    requireString(operation.operationId, label + ".operationId", 128);
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(operation.operationId) || operationIds.has(operation.operationId)) {
      throw new ApiContractError("INVALID_OPERATION", label + ".operationId must be unique and use a stable identifier");
    }
    operationIds.add(operation.operationId);

    requireString(operation.method, label + ".method", 16);
    const method = operation.method.toUpperCase();
    if (!METHODS.has(method) || method !== operation.method) {
      throw new ApiContractError("INVALID_OPERATION", label + ".method must be an uppercase supported HTTP method");
    }
    validatePathTemplate(operation.path, label + ".path");
    const routeKey = method + " " + operation.path;
    if (routeKeys.has(routeKey)) throw new ApiContractError("INVALID_OPERATION", "contract contains duplicate method/path operations");
    routeKeys.add(routeKey);

    if (!isRecord(operation.responses)) throw new ApiContractError("INVALID_OPERATION", label + ".responses must be a plain object");
    const responseKeys = Object.keys(operation.responses);
    if (responseKeys.length < 1 || responseKeys.length > 50) {
      throw new ApiContractError("INVALID_OPERATION", label + ".responses must define between 1 and 50 response cases");
    }
    for (const code of responseKeys) {
      if (code !== "default" && (!/^[1-5]\d\d$/u.test(code) || Number(code) < 100 || Number(code) > 599)) {
        throw new ApiContractError("INVALID_RESPONSE_CASE", label + ".responses contains an invalid HTTP status key");
      }
      const responseCase = operation.responses[code];
      const responseLabel = label + ".responses." + code;
      if (!isRecord(responseCase)) throw new ApiContractError("INVALID_RESPONSE_CASE", responseLabel + " must be a plain object");
      assertKnownKeys(responseCase, new Set(["headers", "body"]), responseLabel);
      if (responseCase.headers !== undefined) validateHeaderRules(responseCase.headers, responseLabel + ".headers");
      if (responseCase.body !== undefined) {
        const schemaState = { nodes: schemaNodes };
        validateSchemaNode(responseCase.body, responseLabel + ".body", schemaState);
        schemaNodes = schemaState.nodes;
      }
    }
  }
}

function pathMatches(template, actualPath) {
  const expected = template.slice(1).split("/");
  const actual = actualPath.slice(1).split("/");
  if (expected.length !== actual.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const part = expected[index];
    const value = actual[index];
    if (/^\{[A-Za-z][A-Za-z0-9_]*\}$/u.test(part)) {
      if (!value) return false;
    } else if (part !== value) {
      return false;
    }
  }
  return true;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, type) {
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return valueType(value) === type;
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function propertyPath(base, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? base + "." + key : base + "[" + JSON.stringify(key) + "]";
}

function safeSummary(value) {
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string") return { type: "string", length: [...value].length };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (isRecord(value)) return { type: "object", propertyCount: Object.keys(value).length };
  return { type: typeof value };
}

function validateBodyAgainstSchema(value, schema, path, results, state, depth = 0) {
  if (results.length >= MAX_RESULT_ERRORS) return;
  state.visited += 1;
  if (state.visited > 50000 || depth > 24) {
    results.push({ category: "body", code: "BODY_COMPLEXITY_LIMIT", path, passed: false, message: "Response JSON exceeds validation complexity limits" });
    return;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    results.push({
      category: "body",
      code: "TYPE_MISMATCH",
      path,
      expected: schema.type,
      actual: valueType(value),
      passed: false,
      message: "Value does not match the declared JSON type"
    });
    return;
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    results.push({ category: "body", code: "CONST_MISMATCH", path, expected: safeSummary(schema.const), actual: safeSummary(value), passed: false, message: "Value does not match the declared constant" });
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => deepEqual(value, candidate))) {
    results.push({ category: "body", code: "ENUM_MISMATCH", path, expected: { allowedValues: schema.enum.length }, actual: safeSummary(value), passed: false, message: "Value is not one of the declared enum values" });
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      results.push({ category: "body", code: "MIN_LENGTH", path, expected: schema.minLength, actual: length, passed: false, message: "String is shorter than the declared minimum" });
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      results.push({ category: "body", code: "MAX_LENGTH", path, expected: schema.maxLength, actual: length, passed: false, message: "String exceeds the declared maximum length" });
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    for (const [key, code, condition, message] of [
      ["minimum", "MINIMUM", value < schema.minimum, "Number is below the declared minimum"],
      ["maximum", "MAXIMUM", value > schema.maximum, "Number exceeds the declared maximum"],
      ["exclusiveMinimum", "EXCLUSIVE_MINIMUM", value <= schema.exclusiveMinimum, "Number does not exceed the exclusive minimum"],
      ["exclusiveMaximum", "EXCLUSIVE_MAXIMUM", value >= schema.exclusiveMaximum, "Number does not meet the exclusive maximum"]
    ]) {
      if (schema[key] !== undefined && condition) {
        results.push({ category: "body", code, path, expected: schema[key], actual: value, passed: false, message });
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      results.push({ category: "body", code: "MIN_ITEMS", path, expected: schema.minItems, actual: value.length, passed: false, message: "Array contains fewer items than declared" });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      results.push({ category: "body", code: "MAX_ITEMS", path, expected: schema.maxItems, actual: value.length, passed: false, message: "Array contains more items than declared" });
    }
    if (schema.items) {
      for (let index = 0; index < value.length && results.length < MAX_RESULT_ERRORS; index += 1) {
        validateBodyAgainstSchema(value[index], schema.items, path + "[" + index + "]", results, state, depth + 1);
      }
    }
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      results.push({ category: "body", code: "MIN_PROPERTIES", path, expected: schema.minProperties, actual: keys.length, passed: false, message: "Object contains fewer properties than declared" });
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      results.push({ category: "body", code: "MAX_PROPERTIES", path, expected: schema.maxProperties, actual: keys.length, passed: false, message: "Object contains more properties than declared" });
    }
    for (const name of schema.required || []) {
      if (!Object.hasOwn(value, name)) {
        results.push({ category: "body", code: "REQUIRED_PROPERTY", path: propertyPath(path, name), expected: "present", actual: "missing", passed: false, message: "Required property is missing" });
      }
    }
    const properties = schema.properties || {};
    for (const name of keys) {
      if (Object.hasOwn(properties, name)) {
        validateBodyAgainstSchema(value[name], properties[name], propertyPath(path, name), results, state, depth + 1);
      } else if (schema.additionalProperties === false) {
        results.push({ category: "body", code: "ADDITIONAL_PROPERTY", path: propertyPath(path, name), expected: "not present", actual: "present", passed: false, message: "Object contains an undeclared property" });
      } else if (isRecord(schema.additionalProperties)) {
        validateBodyAgainstSchema(value[name], schema.additionalProperties, propertyPath(path, name), results, state, depth + 1);
      }
    }
  }
}

function makeResult(contractId, version, operationId, checks) {
  const safeChecks = checks.slice(0, MAX_RESULT_ERRORS).map((check, index) => Object.freeze({ index, ...check }));
  const passedCount = safeChecks.filter((item) => item.passed).length;
  const failedCount = safeChecks.length - passedCount;
  return Object.freeze({
    engineId: API_CONTRACT_TESTING_ENGINE_ID,
    engineVersion: API_CONTRACT_TESTING_ENGINE_VERSION,
    contractId,
    contractVersion: version,
    operationId,
    passed: failedCount === 0 && safeChecks.length > 0,
    total: safeChecks.length,
    passedCount,
    failedCount,
    passRate: safeChecks.length ? Math.round((passedCount / safeChecks.length) * 10000) / 100 : 0,
    results: Object.freeze(safeChecks)
  });
}

function validateResponse(compiledContract, operation, response) {
  if (!isRecord(response)) throw new TypeError("response must be a plain Request Engine response object");
  for (const key of ["method", "url", "status", "headers", "json", "jsonParsed"]) {
    const descriptor = Object.getOwnPropertyDescriptor(response, key);
    if (descriptor && !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("response cannot contain accessor properties");
    }
  }

  const checks = [];
  const add = (check) => {
    if (checks.length < MAX_RESULT_ERRORS) checks.push(check);
  };

  const method = typeof response.method === "string" ? response.method.toUpperCase() : "";
  add({
    category: "operation",
    code: "METHOD_MATCH",
    path: "$.method",
    expected: operation.method,
    actual: method || "missing",
    passed: method === operation.method,
    message: method === operation.method ? "HTTP method matches the contract" : "HTTP method does not match the contract"
  });

  let actualPath = null;
  try {
    if (typeof response.url === "string" && response.url.length <= 4096) {
      const url = new URL(response.url);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash) actualPath = url.pathname;
    }
  } catch { /* represented as a failed path check below */ }
  const pathOk = actualPath !== null && pathMatches(operation.path, actualPath);
  add({
    category: "operation",
    code: "PATH_MATCH",
    path: "$.url.pathname",
    expected: operation.path,
    actual: actualPath === null ? "invalid-or-missing" : "pathname-present",
    passed: pathOk,
    message: pathOk ? "Request path matches the contract template" : "Request path does not match the contract template"
  });

  const status = response.status;
  const validStatus = Number.isInteger(status) && status >= 100 && status <= 599;
  const responseCase = validStatus ? (operation.responses[String(status)] ?? operation.responses.default) : undefined;
  add({
    category: "response",
    code: "DECLARED_STATUS",
    path: "$.status",
    expected: Object.keys(operation.responses),
    actual: validStatus ? status : "invalid-or-missing",
    passed: Boolean(responseCase),
    message: responseCase ? "HTTP status is declared by the contract" : "HTTP status is not declared by the contract"
  });

  if (!responseCase) return makeResult(compiledContract.contractId, compiledContract.version, operation.operationId, checks);

  if (responseCase.headers) {
    let headers = {};
    let headersValid = true;
    try {
      if (response.headers !== undefined && !isRecord(response.headers)) {
        throw new TypeError("response.headers must be a plain object");
      }
      headers = response.headers || {};
      assertJsonSafe(headers, "response.headers", { maximumDepth: 2, maximumNodes: 500 });
    } catch {
      headersValid = false;
      add({
        category: "headers",
        code: "INVALID_RESPONSE_HEADERS",
        path: "$.headers",
        expected: "plain string header map",
        actual: "invalid-or-unsafe",
        passed: false,
        message: "Response headers must be a safe plain object of string values"
      });
      headers = {};
    }
    const lookup = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    for (const [name, rule] of Object.entries(responseCase.headers)) {
      const actual = lookup.get(name.toLowerCase());
      const present = typeof actual === "string";
      const required = typeof rule === "string" ? true : rule.required !== false;
      let passed = headersValid;
      if (required && !present) passed = false;
      if (present && typeof rule === "string" && actual !== rule) passed = false;
      if (present && isRecord(rule) && rule.equals !== undefined && actual !== rule.equals) passed = false;
      if (present && isRecord(rule) && rule.contains !== undefined && !actual.includes(rule.contains)) passed = false;
      add({
        category: "headers",
        code: "HEADER_CONTRACT",
        path: "$.headers." + name.toLowerCase(),
        expected: typeof rule === "string" ? { equals: rule, required: true } : { required, equals: rule.equals ?? null, contains: rule.contains ?? null },
        actual: present ? { present: true, length: actual.length } : { present: false },
        passed,
        message: passed ? "Response header satisfies the contract" : "Response header is missing or does not satisfy the contract"
      });
    }
  }

  if (responseCase.body !== undefined) {
    if (response.jsonParsed !== true) {
      add({
        category: "body",
        code: "JSON_BODY_UNAVAILABLE",
        path: "$.json",
        expected: "valid parsed JSON",
        actual: response.jsonParsed === false ? "not-parsed" : "missing-parse-evidence",
        passed: false,
        message: "Contract requires a JSON body but the Request Engine did not confirm successful JSON parsing"
      });
    } else {
      try {
        assertJsonSafe(response.json, "response.json");
        const bodyResults = [];
        validateBodyAgainstSchema(response.json, responseCase.body, "$", bodyResults, { visited: 0 });
        if (bodyResults.length === 0) {
          add({ category: "body", code: "BODY_SCHEMA", path: "$", expected: "contract schema", actual: "valid", passed: true, message: "Response JSON satisfies the contract schema" });
        } else {
          for (const result of bodyResults) add(result);
        }
      } catch (error) {
        add({
          category: "body",
          code: "INVALID_JSON_VALUE",
          path: "$.json",
          expected: "bounded, safe JSON value",
          actual: "unsafe-or-invalid",
          passed: false,
          message: error.message
        });
      }
    }
  }

  return makeResult(compiledContract.contractId, compiledContract.version, operation.operationId, checks);
}

export function createApiContractTestingEngine() {
  function compile(contract) {
    validateContractDefinition(contract);
    const safeContract = structuredClone(contract);
    const operations = new Map(safeContract.operations.map((operation) => [operation.operationId, operation]));
    const compiled = Object.freeze({
      contractId: safeContract.contractId,
      version: safeContract.version,
      operationIds: Object.freeze([...operations.keys()]),
      validate(response, options = {}) {
        if (!isRecord(options) || Object.keys(options).some((key) => key !== "operationId")) {
          throw new TypeError("Contract validation options only support operationId");
        }
        const operationDescriptor = Object.getOwnPropertyDescriptor(options, "operationId");
        if (operationDescriptor && !Object.hasOwn(operationDescriptor, "value")) {
          throw new TypeError("Contract validation options cannot contain accessors");
        }
        const operationId = operationDescriptor?.value;
        if (typeof operationId !== "string" || !operations.has(operationId)) {
          throw new ApiContractError("UNKNOWN_OPERATION", "operationId is not declared in this contract");
        }
        return validateResponse(compiled, operations.get(operationId), response);
      }
    });
    return compiled;
  }

  return Object.freeze({
    engineId: API_CONTRACT_TESTING_ENGINE_ID,
    version: API_CONTRACT_TESTING_ENGINE_VERSION,
    compile
  });
}
