import test from "node:test";
import assert from "node:assert/strict";
import {
  API_SECURITY_TESTING_ENGINE_ID,
  ApiSecurityError,
  createApiSecurityTestingEngine
} from "../src/index.js";

const engine = createApiSecurityTestingEngine();

function response(overrides = {}) {
  return {
    method: "GET",
    url: "https://api.example.com/v1/users/42",
    status: 200,
    headers: {
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "content-type": "application/json"
    },
    jsonParsed: true,
    json: { data: { id: 42, active: true } },
    ...overrides
  };
}

test("engine identity and secure API response produce a passing report", () => {
  const report = engine.analyze(response());
  assert.equal(engine.engineId, API_SECURITY_TESTING_ENGINE_ID);
  assert.equal(report.engineId, API_SECURITY_TESTING_ENGINE_ID);
  assert.equal(report.passed, true);
  assert.equal(report.status, "pass");
  assert.equal(report.failedCount, 0);
  assert.ok(report.total >= 4);
});

test("flags plaintext HTTP and supports an explicit localhost-only exception", () => {
  const insecure = engine.analyze(response({ url: "http://api.example.com/v1/users/42" }));
  const transport = insecure.checks.find((item) => item.id === "transport.https");
  assert.equal(transport.status, "fail");
  assert.equal(transport.severity, "high");

  const local = engine.analyze(response({ url: "http://127.0.0.1:4300/v1/users/42" }), {
    allowInsecureLocalhost: true
  });
  assert.equal(local.checks.find((item) => item.id === "transport.https").status, "pass");
});

test("requires HSTS on HTTPS and does not require it for plaintext URLs", () => {
  const missing = engine.analyze(response({ headers: { "x-content-type-options": "nosniff" } }));
  assert.equal(missing.checks.find((item) => item.id === "headers.hsts").status, "fail");

  const http = engine.analyze(response({ url: "http://api.example.com", headers: {} }), {
    requireHttps: false,
    requireHsts: true,
    requireNoSniff: false
  });
  assert.equal(http.checks.some((item) => item.id === "headers.hsts"), false);
});

test("validates the X-Content-Type-Options nosniff header", () => {
  const report = engine.analyze(response({ headers: {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff"
  } }));
  assert.equal(report.checks.find((item) => item.id === "headers.content-type-options").status, "pass");

  const invalid = engine.analyze(response({ headers: { "strict-transport-security": "max-age=31536000" } }));
  assert.equal(invalid.checks.find((item) => item.id === "headers.content-type-options").status, "fail");
});

test("fails wildcard CORS combined with credentialed access at critical severity", () => {
  const report = engine.analyze(response({ headers: {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
    "access-control-allow-credentials": "true"
  } }));
  const cors = report.checks.find((item) => item.id === "cors.wildcard-credentials");
  assert.equal(cors.status, "fail");
  assert.equal(cors.severity, "critical");
  assert.equal(report.bySeverity.critical, 1);
});

test("checks an exact CORS request origin and explicit allowlist", () => {
  const report = engine.analyze(response({ headers: {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "https://client.example.com",
    "vary": "Accept-Encoding, Origin"
  } }), {
    requestOrigin: "https://client.example.com",
    allowedCorsOrigins: ["https://client.example.com"]
  });
  assert.equal(report.checks.find((item) => item.id === "cors.origin-policy").status, "pass");
  assert.equal(report.checks.find((item) => item.id === "cors.vary-origin"), undefined);
});

test("rejects wildcard CORS when an explicit origin allowlist is configured", () => {
  const report = engine.analyze(response({ headers: {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*"
  } }), {
    allowedCorsOrigins: ["https://client.example.com"],
    disallowWildcardCors: false
  });
  assert.equal(report.checks.find((item) => item.id === "cors.origin-policy").status, "fail");
});

test("detects CORS origin mismatch and the opaque null origin", () => {
  const mismatch = engine.analyze(response({ headers: {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "https://other.example.com"
  } }), { requestOrigin: "https://client.example.com" });
  assert.equal(mismatch.checks.find((item) => item.id === "cors.origin-policy").status, "fail");

  const opaque = engine.analyze(response({ headers: {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "null"
  } }));
  assert.equal(opaque.checks.find((item) => item.id === "cors.origin-policy").status, "fail");
});

test("requires no-store for responses explicitly marked sensitive", () => {
  const missing = engine.analyze(response({ headers: {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "cache-control": "public, max-age=600"
  } }), { sensitiveResponse: true });
  assert.equal(missing.checks.find((item) => item.id === "cache.sensitive-response").status, "fail");

  const safe = engine.analyze(response({ headers: {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store"
  } }), { sensitiveResponse: true });
  assert.equal(safe.checks.find((item) => item.id === "cache.sensitive-response").status, "pass");
});

test("checks cookie Secure, HttpOnly and SameSite attributes without exposing values", () => {
  const report = engine.analyze(response({ headers: {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "set-cookie": "session=do-not-disclose-this-value; Path=/; SameSite=Lax"
  } }));
  const cookie = report.checks.find((item) => item.id === "cookies.flags.1");
  assert.equal(cookie.status, "fail");
  assert.deepEqual(cookie.evidence.missingAttributes, ["Secure", "HttpOnly"]);
  assert.equal(JSON.stringify(report).includes("do-not-disclose-this-value"), false);
});

test("SameSite=None requires Secure even when other cookie policies are disabled", () => {
  const report = engine.analyze(response({ headers: {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "set-cookie": "session=value; HttpOnly; SameSite=None"
  } }), {
    requireSecureCookies: false,
    requireHttpOnlyCookies: false,
    requireSameSiteCookies: false
  });
  const cookie = report.checks.find((item) => item.id === "cookies.flags.1");
  assert.equal(cookie.status, "fail");
  assert.deepEqual(cookie.evidence.missingAttributes, ["Secure (required for SameSite=None)"]);
});

test("server technology headers are warnings by default and failures under strict policy", () => {
  const headers = {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "server": "secret-server-banner",
    "x-powered-by": "Framework 1.2"
  };
  const warning = engine.analyze(response({ headers }));
  const item = warning.checks.find((entry) => entry.id === "headers.technology-disclosure");
  assert.equal(item.status, "warning");
  assert.equal(JSON.stringify(item).includes("secret-server-banner"), false);

  const strict = engine.analyze(response({ headers }), { disallowServerDisclosure: true });
  assert.equal(strict.checks.find((entry) => entry.id === "headers.technology-disclosure").status, "fail");
});

test("detects credential-like response fields without echoing their contents", () => {
  const report = engine.analyze(response({
    json: {
      data: {
        user: { id: 42 },
        password: "not-for-response",
        private_key: "private-key-material"
      }
    }
  }));
  const item = report.checks.find((entry) => entry.id === "data.sensitive-fields");
  assert.equal(item.status, "fail");
  assert.equal(item.severity, "high");
  assert.equal(item.evidence.fieldCount, 2);
  assert.equal(JSON.stringify(report).includes("not-for-response"), false);
  assert.equal(JSON.stringify(report).includes("private-key-material"), false);
});

test("reports authentication token fields as review warnings rather than asserting a vulnerability", () => {
  const report = engine.analyze(response({
    json: { access_token: "short-lived-token" }
  }));
  const item = report.checks.find((entry) => entry.id === "data.authentication-tokens");
  assert.equal(item.status, "warning");
  assert.equal(report.passed, true);
  assert.equal(JSON.stringify(report).includes("short-lived-token"), false);
});

test("validates policy input and rejects unsupported fields and invalid origins", () => {
  assert.throws(() => engine.analyze(response(), { runActiveProbes: true }), /unsupported fields/u);
  assert.throws(() => engine.analyze(response(), { requestOrigin: "https://example.com/path" }), /exact HTTP/u);
  assert.throws(() => engine.analyze(response(), { requireHttps: "yes" }), /must be boolean/u);
  assert.throws(() => engine.analyze(response(), { allowedCorsOrigins: ["https://a.example", "https://a.example"] }), /duplicates/u);
});

test("rejects getters in responses, headers, policy and origin arrays without invoking them", () => {
  let responseGetter = false;
  const unsafeResponse = response();
  Object.defineProperty(unsafeResponse, "url", { enumerable: false, get() { responseGetter = true; return "https://api.example.com"; } });
  assert.throws(() => engine.analyze(unsafeResponse), /getters or setters/u);
  assert.equal(responseGetter, false);

  let headerGetter = false;
  const unsafeHeaders = {};
  Object.defineProperty(unsafeHeaders, "x-test", { enumerable: true, get() { headerGetter = true; return "x"; } });
  assert.throws(() => engine.analyze(response({ headers: unsafeHeaders })), /getters or setters/u);
  assert.equal(headerGetter, false);

  let policyGetter = false;
  const unsafePolicy = {};
  Object.defineProperty(unsafePolicy, "requireHttps", { enumerable: true, get() { policyGetter = true; return true; } });
  assert.throws(() => engine.analyze(response(), unsafePolicy), /getters or setters/u);
  assert.equal(policyGetter, false);

  let arrayGetter = false;
  const origins = ["https://client.example.com"];
  Object.defineProperty(origins, "0", { enumerable: true, configurable: true, get() { arrayGetter = true; return "https://client.example.com"; } });
  assert.throws(() => engine.analyze(response(), { allowedCorsOrigins: origins }), /array accessors/u);
  assert.equal(arrayGetter, false);
});

test("rejects unsafe parsed JSON instead of traversing getters or prototype keys", () => {
  let getterCalled = false;
  const json = {};
  Object.defineProperty(json, "password", { enumerable: true, get() { getterCalled = true; return "secret"; } });
  assert.throws(() => engine.analyze(response({ json })), /getters or setters/u);
  assert.equal(getterCalled, false);
});

test("allows a controlled policy to disable optional checks without generating network traffic", () => {
  const api = createApiSecurityTestingEngine();
  const report = api.analyze(response({ url: "http://127.0.0.1:4300/health", headers: {} }), {
    allowInsecureLocalhost: true,
    requireHsts: false,
    requireNoSniff: false,
    scanSensitiveFields: false
  });
  assert.equal(report.passed, true);
  assert.equal(typeof api.analyze, "function");
});
