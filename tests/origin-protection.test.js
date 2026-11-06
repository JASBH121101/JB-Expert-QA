import test from "node:test";
import assert from "node:assert/strict";
import { createOriginProtection, createSecurityGuard } from "@jb/security-guard";

function invoke(middleware, request) {
  const headers = new Map();
  const response = {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); },
    end(body) { this.body = body; this.writableEnded = true; },
    destroy() { this.destroyed = true; }
  };
  let continued = 0;
  middleware(request, response, () => { continued += 1; });
  return { response, headers, continued };
}

test("Guard factory exposes strict origin protection for browser routes", () => {
  const guard = createSecurityGuard({ mode: "balanced", rateLimit: { enabled: false } });
  const origin = guard.createOriginProtection({
    allowedOrigins: ["https://app.example.test"]
  });
  const result = invoke(origin.middleware, {
    method: "POST",
    headers: { origin: "https://app.example.test" }
  });
  assert.equal(result.continued, 1);
  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(origin.getStats(), { requests: 1, allowed: 1, blocked: 0 });
});

test("untrusted, null, malformed and missing origins are rejected for unsafe methods", () => {
  const events = [];
  const origin = createOriginProtection({
    allowedOrigins: ["https://app.example.test"],
    onEvent(event) { events.push(event); }
  });
  for (const value of [
    "https://attacker.example",
    "null",
    "not-a-url",
    undefined
  ]) {
    const headers = value === undefined ? {} : { origin: value };
    const result = invoke(origin.middleware, { method: "POST", headers });
    assert.equal(result.response.statusCode, 403);
    assert.equal(result.continued, 0);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(JSON.parse(result.response.body).error, "request_origin_rejected");
  }
  assert.equal(events.length, 4);
  assert.ok(events.every((event) => event.ruleIds.includes("JBG-CSRF-ORIGIN-001")));
  assert.equal(JSON.stringify(events).includes("attacker.example"), false);
});

test("safe methods bypass origin checks and remain available without Origin", () => {
  const origin = createOriginProtection({
    allowedOrigins: ["https://app.example.test"]
  });
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const result = invoke(origin.middleware, { method, headers: {} });
    assert.equal(result.continued, 1);
    assert.equal(result.response.statusCode, 200);
  }
});

test("Referer fallback is opt-in and checks only the exact origin", () => {
  const strict = createOriginProtection({
    allowedOrigins: ["https://app.example.test"]
  });
  const strictResult = invoke(strict.middleware, {
    method: "PATCH",
    headers: { referer: "https://app.example.test/account/profile" }
  });
  assert.equal(strictResult.response.statusCode, 403);

  const compatible = createOriginProtection({
    allowedOrigins: ["https://app.example.test"],
    allowRefererFallback: true
  });
  const result = invoke(compatible.middleware, {
    method: "PATCH",
    headers: { referer: "https://app.example.test/account/profile" }
  });
  assert.equal(result.continued, 1);

  const blocked = invoke(compatible.middleware, {
    method: "DELETE",
    headers: { referer: "https://attacker.example/forged" }
  });
  assert.equal(blocked.response.statusCode, 403);
});

test("origin policy rejects wildcard, path, insecure remote and unknown options", () => {
  assert.throws(() => createOriginProtection({ allowedOrigins: ["*"] }), /valid absolute origins|HTTPS/);
  assert.throws(() => createOriginProtection({ allowedOrigins: ["https://app.example.test/path"] }), /only scheme, host/);
  assert.throws(() => createOriginProtection({ allowedOrigins: ["http://app.example.test"] }), /HTTPS/);
  assert.throws(() => createOriginProtection({
    allowedOrigins: ["https://app.example.test"], trustAllSubdomains: true
  }), /Unknown origin protection option/);
  assert.throws(() => createOriginProtection({ allowedOrigins: [] }), /between 1 and 100/);
});

test("localhost HTTP is allowed for development but never broad wildcard hosts", () => {
  const origin = createOriginProtection({ allowedOrigins: ["http://localhost:3000"] });
  const result = invoke(origin.middleware, {
    method: "POST", headers: { origin: "http://localhost:3000" }
  });
  assert.equal(result.continued, 1);
});


test("permissive missing-origin mode never treats duplicate or foreign headers as absent", () => {
  const origin = createOriginProtection({
    allowedOrigins: ["https://app.example.test"],
    allowMissingOrigin: true,
    allowRefererFallback: true
  });

  const duplicate = invoke(origin.middleware, {
    method: "POST",
    headers: { origin: ["https://app.example.test", "https://attacker.example"] }
  });
  assert.equal(duplicate.response.statusCode, 403);

  const foreignReferer = invoke(origin.middleware, {
    method: "POST",
    headers: { referer: "https://attacker.example/forged" }
  });
  assert.equal(foreignReferer.response.statusCode, 403);

  const trulyMissing = invoke(origin.middleware, {
    method: "POST",
    headers: {}
  });
  assert.equal(trulyMissing.continued, 1);
});
