import test from "node:test";
import assert from "node:assert/strict";
import { redactUrlForReport, redactUrlsInText } from "../src/core/redaction.js";

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

test("malformed URLs are omitted instead of echoing possible credentials", () => {
  const malformed = "https://user:password-secret@%zz/path?access_token=leaked-token";
  const result = redactUrlForReport(malformed);
  assert.equal(result, "[unparseable URL omitted]");
  assert.equal(result.includes("password-secret"), false);
  assert.equal(result.includes("leaked-token"), false);
  assert.equal(redactUrlsInText("Request failed: " + malformed).includes("leaked-token"), false);
});
