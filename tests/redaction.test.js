import test from "node:test";
import assert from "node:assert/strict";
import { redactUrlForReport, redactUrlsInText } from "../src/core/redaction.js";
import { redactSourceForAI } from "../src/agent/policy.js";

test("URL reports redact sensitive query values and remove fragments", () => {
  const secret = "very-secret-token-value";
  const result = redactUrlForReport(
    "https://example.com/audit?utm_source=qa&access_token=" + secret +
    "&X-Amz-Signature=signature-value#id_token=fragment-token"
  );
  const parsed = new URL(result);
  assert.equal(parsed.searchParams.get("utm_source"), "qa");
  assert.equal(parsed.searchParams.get("access_token"), "[REDACTED]");
  assert.equal(parsed.searchParams.get("X-Amz-Signature"), "[REDACTED]");
  assert.equal(parsed.hash, "");
  assert.equal(result.includes(secret), false);
  assert.equal(result.includes("signature-value"), false);
  assert.equal(result.includes("fragment-token"), false);
});

test("URL text redaction handles inline URLs and non-network resources", () => {
  const result = redactUrlsInText(
    "Request failed: https://example.com/?api_key=inline-secret"
  );
  assert.equal(result.includes("inline-secret"), false);
  assert.equal(redactUrlForReport("data:text/plain,private-content"), "data:[omitted]");
  assert.equal(redactUrlForReport("blob:https://example.com/1234"), "blob:[omitted]");
});


test("redacts WebSocket credentials and secret query values in URL text", () => {
  const result = redactUrlsInText(
    "Socket failed: wss://operator:password@example.com/socket?auth_token=socket-secret"
  );
  assert.equal(result.includes("password"), false);
  assert.equal(result.includes("socket-secret"), false);
  assert.equal(result.includes("operator"), false);
  assert.equal(result.includes("example.com"), true);
});

test("omits malformed absolute URLs rather than echoing possible secrets", () => {
  const result = redactUrlForReport("https://example.com:bad/?access_token=malformed-secret");
  assert.equal(result, "[UNPARSEABLE_URL]");
  assert.equal(result.includes("malformed-secret"), false);
});


test("redacts unquoted environment and YAML secrets before AI source review", () => {
  const source = [
    "API_KEY=plain-env-secret-value",
    "password: plain yaml password with spaces",
    "Authorization: Bearer bearer-secret-value",
    "const token = 'quoted-token-secret';",
    "const ordinary = 'keep this non-secret value';"
  ].join("\n");

  const result = redactSourceForAI(source);
  for (const secret of [
    "plain-env-secret-value",
    "plain yaml password with spaces",
    "bearer-secret-value",
    "quoted-token-secret"
  ]) {
    assert.equal(result.includes(secret), false, secret);
  }
  assert.equal(result.includes("keep this non-secret value"), true);
  assert.equal(result.includes("[REDACTED]"), true);
});
