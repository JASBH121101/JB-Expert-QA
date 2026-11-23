const ASSERTION_TYPES = new Set([
  "status", "statusRange", "header", "json", "text", "contains",
  "type", "exists", "number", "arrayLength", "regex"
]);
const OPERATORS = new Set(["equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "between", "contains", "startsWith", "endsWith", "matches"]);
const JSON_TYPES = new Set(["null", "object", "array", "string", "number", "boolean"]);

export const API_ASSERTIONS_ENGINE_ID = "jb.api-testing-assertions-engine";
export const API_ASSERTIONS_ENGINE_VERSION = "0.1.0";

export class ApiAssertionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiAssertionError";
    this.code = code;
  }
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeJsonPath(path) {
  if (typeof path !== "string" || !path.startsWith("$") || path.length > 512) {
    throw new TypeError("JSON path must be a string starting with $ and no longer than 512 characters");
  }
  const tokens = [];
  let index = 1;
  while (index < path.length) {
    if (path[index] === ".") {
      index += 1;
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(path.slice(index));
      if (!match) throw new TypeError("Invalid JSON path property segment");
      if (["__proto__", "prototype", "constructor"].includes(match[0])) throw new TypeError("Forbidden JSON path property");
      tokens.push({ type: "property", key: match[0] });
      index += match[0].length;
    } else if (path[index] === "[") {
      const match = /^\[(\d+)\]/u.exec(path.slice(index));
      if (!match) throw new TypeError("JSON path supports numeric array indexes only in brackets");
      const numeric = Number(match[1]);
      if (!Number.isSafeInteger(numeric) || numeric > 1000000) throw new TypeError("JSON path index is out of bounds");
      tokens.push({ type: "index", index: numeric });
      index += match[0].length;
    } else {
      throw new TypeError("Invalid JSON path syntax");
    }
  }
  return tokens;
}

function resolvePath(value, path) {
  let current = value;
  for (const token of safeJsonPath(path)) {
    if (token.type === "property") {
      if (current === null || typeof current !== "object" || !Object.hasOwn(current, token.key)) return { exists: false, value: undefined };
      current = current[token.key];
    } else {
      if (!Array.isArray(current) || token.index >= current.length) return { exists: false, value: undefined };
      current = current[token.index];
    }
  }
  return { exists: true, value: current };
}

function compare(actual, operator, expected, assertion) {
  switch (operator) {
    case "equals": return Object.is(actual, expected) || (actual !== undefined && expected !== undefined && JSON.stringify(actual) === JSON.stringify(expected));
    case "notEquals": return !(Object.is(actual, expected) || (actual !== undefined && expected !== undefined && JSON.stringify(actual) === JSON.stringify(expected)));
    case "greaterThan": return typeof actual === "number" && actual > expected;
    case "greaterThanOrEqual": return typeof actual === "number" && actual >= expected;
    case "lessThan": return typeof actual === "number" && actual < expected;
    case "lessThanOrEqual": return typeof actual === "number" && actual <= expected;
    case "between": return typeof actual === "number" && Array.isArray(expected) && actual >= expected[0] && actual <= expected[1];
    case "contains": return typeof actual === "string" ? actual.includes(String(expected)) : Array.isArray(actual) ? actual.some((item) => Object.is(item, expected)) : false;
    case "startsWith": return typeof actual === "string" && actual.startsWith(String(expected));
    case "endsWith": return typeof actual === "string" && actual.endsWith(String(expected));
    case "matches": return typeof actual === "string" && assertion.regex instanceof RegExp && assertion.regex.test(actual);
    default: return false;
  }
}

function actualType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function evaluateOne(response, assertion) {
  const type = assertion.type;
  const path = assertion.path;
  let actual;
  let expected = assertion.expected;
  let operator = assertion.operator || "equals";
  let passed = false;
  let description = assertion.description || type;

  switch (type) {
    case "status":
      actual = response?.status;
      passed = Number.isInteger(actual) && compare(actual, operator, expected, assertion);
      break;
    case "statusRange":
      actual = response?.status;
      expected = assertion.expected;
      passed = Number.isInteger(actual) && Array.isArray(expected) && expected.length === 2 && actual >= expected[0] && actual <= expected[1];
      break;
    case "header": {
      const name = String(assertion.name || "").toLowerCase();
      actual = response?.headers?.[name];
      passed = actual !== undefined && compare(actual, operator, expected, assertion);
      description = assertion.description || "header " + name;
      break;
    }
    case "text":
      actual = response?.bodyText;
      passed = typeof actual === "string" && compare(actual, operator, expected, assertion);
      break;
    case "contains":
      actual = assertion.target === "text" ? response?.bodyText : resolvePath(response?.json, path || "$").value;
      passed = assertion.target === "text" ? typeof actual === "string" && actual.includes(String(expected)) : Array.isArray(actual) ? actual.includes(expected) : typeof actual === "string" && actual.includes(String(expected));
      break;
    case "json": {
      const resolved = resolvePath(response?.json, path);
      actual = resolved.value;
      passed = resolved.exists && compare(actual, operator, expected, assertion);
      break;
    }
    case "exists": {
      const resolved = resolvePath(response?.json, path);
      actual = resolved.exists;
      expected = assertion.expected === undefined ? true : assertion.expected;
      passed = compare(actual, operator, expected, assertion);
      break;
    }
    case "type": {
      const resolved = resolvePath(response?.json, path);
      actual = resolved.exists ? actualType(resolved.value) : "missing";
      passed = resolved.exists && JSON_TYPES.has(expected) && actual === expected;
      break;
    }
    case "number": {
      const resolved = resolvePath(response?.json, path);
      actual = resolved.value;
      passed = resolved.exists && typeof actual === "number" && Number.isFinite(actual) && compare(actual, operator, expected, assertion);
      break;
    }
    case "arrayLength": {
      const resolved = resolvePath(response?.json, path);
      actual = Array.isArray(resolved.value) ? resolved.value.length : undefined;
      passed = resolved.exists && Array.isArray(resolved.value) && compare(actual, operator, expected, assertion);
      break;
    }
    case "regex": {
      actual = assertion.target === "text" ? response?.bodyText : resolvePath(response?.json, path).value;
      const source = assertion.pattern;
      const flags = assertion.flags || "";
      const re = new RegExp(source, flags);
      passed = typeof actual === "string" && re.test(actual);
      break;
    }
    default:
      throw new ApiAssertionError("UNKNOWN_ASSERTION", "Unsupported assertion type: " + type);
  }

  return Object.freeze({
    type,
    description,
    passed: Boolean(passed),
    actual: actual === undefined ? null : actual,
    expected: expected === undefined ? null : expected,
    operator,
    path: path || null
  });
}

function validateAssertion(assertion, index) {
  if (!isRecord(assertion)) throw new TypeError("Assertion " + index + " must be a plain object");
  if (!ASSERTION_TYPES.has(assertion.type)) throw new TypeError("Assertion " + index + " has an unsupported type");
  if (assertion.description !== undefined && (typeof assertion.description !== "string" || assertion.description.length > 300)) {
    throw new TypeError("Assertion description must be a string of at most 300 characters");
  }
  if (assertion.operator !== undefined && !OPERATORS.has(assertion.operator)) throw new TypeError("Assertion operator is unsupported");
  if (["json", "exists", "type", "number", "arrayLength"].includes(assertion.type)) safeJsonPath(assertion.path);
  if (assertion.type === "header" && (typeof assertion.name !== "string" || !/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]{1,128}$/u.test(assertion.name))) {
    throw new TypeError("Header assertion requires a valid header name");
  }
  if (assertion.type === "status" && (!Number.isInteger(assertion.expected) || assertion.expected < 100 || assertion.expected > 599)) {
    throw new TypeError("Status assertion expected value must be an HTTP status code");
  }
  if (assertion.type === "statusRange" && (!Array.isArray(assertion.expected) || assertion.expected.length !== 2 || assertion.expected.some((n) => !Number.isInteger(n) || n < 100 || n > 599) || assertion.expected[0] > assertion.expected[1])) {
    throw new TypeError("Status range must be an ordered pair of HTTP status codes");
  }
  if (assertion.type === "type" && !JSON_TYPES.has(assertion.expected)) throw new TypeError("Type assertion expected must be one of " + [...JSON_TYPES].join(", "));
  if (assertion.type === "regex") {
    if (typeof assertion.pattern !== "string" || assertion.pattern.length > 500) throw new TypeError("Regex pattern must be a string of at most 500 characters");
    if (typeof assertion.flags !== "string" || /[^imsu]/u.test(assertion.flags) || new Set(assertion.flags).size !== assertion.flags.length) throw new TypeError("Regex flags may only use unique i, m, s and u flags");
    new RegExp(assertion.pattern, assertion.flags || "");
  }
  if (assertion.operator === "between" && (!Array.isArray(assertion.expected) || assertion.expected.length !== 2 || assertion.expected.some((v) => typeof v !== "number") || assertion.expected[0] > assertion.expected[1])) {
    throw new TypeError("between operator requires an ordered numeric pair");
  }
}

export function createApiAssertionsEngine() {
  function evaluate(response, assertions, options = {}) {
    if (!isRecord(response)) throw new TypeError("response must be a plain object");
    if (!Array.isArray(assertions) || assertions.length < 1 || assertions.length > 1000) {
      throw new TypeError("assertions must contain between 1 and 1000 entries");
    }
    if (!isRecord(options) || Object.keys(options).some((key) => key !== "stopOnFailure")) throw new TypeError("Unsupported evaluation options");
    const stopOnFailure = options.stopOnFailure === true;
    const results = [];
    for (let index = 0; index < assertions.length; index += 1) {
      validateAssertion(assertions[index], index);
      const result = evaluateOne(response, assertions[index]);
      results.push(Object.freeze({ index, ...result }));
      if (stopOnFailure && !result.passed) break;
    }
    const passed = results.filter((item) => item.passed).length;
    const failed = results.length - passed;
    return Object.freeze({
      engineId: API_ASSERTIONS_ENGINE_ID,
      version: API_ASSERTIONS_ENGINE_VERSION,
      passed: failed === 0 && results.length === assertions.length,
      total: results.length,
      passedCount: passed,
      failedCount: failed,
      passRate: results.length ? Math.round((passed / results.length) * 10000) / 100 : 0,
      results: Object.freeze(results)
    });
  }
  return Object.freeze({
    engineId: API_ASSERTIONS_ENGINE_ID,
    version: API_ASSERTIONS_ENGINE_VERSION,
    evaluate
  });
}
