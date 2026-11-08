import test from "node:test";
import assert from "node:assert/strict";
import { createCsrfProtection, createSecurityGuard } from "@jb/security-guard";

const SECRET = "csrf-test-secret-material-with-at-least-32-bytes";

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

test("Guard factory exposes session-bound CSRF tokens", () => {
  const guard = createSecurityGuard({ mode: "balanced", rateLimit: { enabled: false } });
  const csrf = guard.createCsrfProtection({
    secret: SECRET,
    sessionKeyGenerator: (request) => request.sessionId
  });
  const request = { sessionId: "session-alpha" };
  const token = csrf.createToken(request);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(csrf.verifyToken(request, token), true);

  const allowed = invoke(csrf.middleware, {
    ...request,
    method: "POST",
    headers: { [csrf.headerName]: token }
  });
  assert.equal(allowed.continued, 1);
  assert.equal(allowed.response.statusCode, 200);
});

test("CSRF tokens cannot be reused across different sessions", () => {
  const csrf = createCsrfProtection({
    secret: SECRET,
    sessionKeyGenerator: (request) => request.sessionId
  });
  const token = csrf.createToken({ sessionId: "session-alpha" });
  assert.equal(csrf.verifyToken({ sessionId: "session-beta" }, token), false);

  const result = invoke(csrf.middleware, {
    sessionId: "session-beta",
    method: "POST",
    headers: { [csrf.headerName]: token }
  });
  assert.equal(result.response.statusCode, 403);
  assert.equal(result.continued, 0);
});

test("missing, malformed, array and incorrect CSRF headers are rejected", () => {
  const csrf = createCsrfProtection({
    secret: SECRET,
    sessionKeyGenerator: (request) => request.sessionId
  });
  const token = csrf.createToken({ sessionId: "session-gamma" });

  for (const headers of [
    {},
    { [csrf.headerName]: "wrong" },
    { [csrf.headerName]: [token, token] },
    { [csrf.headerName]: "" }
  ]) {
    const result = invoke(csrf.middleware, {
      sessionId: "session-gamma",
      method: "DELETE",
      headers
    });
    assert.equal(result.response.statusCode, 403);
    assert.equal(result.continued, 0);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
});

test("CSRF events never reveal session identifiers or token values", () => {
  const events = [];
  const csrf = createCsrfProtection({
    secret: SECRET,
    sessionKeyGenerator: (request) => request.sessionId,
    onEvent(event) { events.push(event); }
  });
  const token = csrf.createToken({ sessionId: "private-session-id" });
  invoke(csrf.middleware, {
    sessionId: "private-session-id",
    method: "PATCH",
    headers: {}
  });
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("private-session-id"), false);
  assert.equal(serialized.includes(token), false);
  assert.equal(events[0].ruleIds[0], "JBG-CSRF-TOKEN-001");
});

test("safe methods do not require CSRF tokens", () => {
  const csrf = createCsrfProtection({
    secret: SECRET,
    sessionKeyGenerator: (request) => request.sessionId
  });
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const result = invoke(csrf.middleware, { method, headers: {} });
    assert.equal(result.continued, 1);
  }
});

test("CSRF configuration requires a strong secret and stable session resolver", () => {
  assert.throws(() => createCsrfProtection({
    secret: "weak", sessionKeyGenerator: () => "session"
  }), /at least 32 bytes/);
  assert.throws(() => createCsrfProtection({ secret: SECRET }), /sessionKeyGenerator is required/);
  assert.throws(() => createCsrfProtection({
    secret: SECRET,
    sessionKeyGenerator: () => "session",
    headerName: "x bad"
  }), /valid lowercase X-/);
  assert.throws(() => createCsrfProtection({
    secret: SECRET,
    sessionKeyGenerator: () => "session",
    unknown: true
  }), /Unknown CSRF protection option/);
  const csrf = createCsrfProtection({
    secret: SECRET,
    sessionKeyGenerator: () => null
  });
  assert.equal(csrf.verifyToken({}, "A".repeat(43)), false);
});
