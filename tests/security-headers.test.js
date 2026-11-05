import test from "node:test";
import assert from "node:assert/strict";
import { createSecurityGuard, createSecurityHeaders } from "@jb/security-guard";

function responseStub() {
  const headers = new Map();
  const removed = [];
  return {
    headers,
    removed,
    setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); },
    removeHeader(name) { removed.push(name.toLowerCase()); headers.delete(name.toLowerCase()); }
  };
}
function runMiddleware(middleware, request) {
  const response = responseStub();
  let continued = 0;
  middleware(request, response, () => { continued += 1; });
  return { response, continued };
}

test("Guard exposes secure baseline response headers and removes the server banner", () => {
  const guard = createSecurityGuard({ mode: "monitor", rateLimit: { enabled: false } });
  const { response, continued } = runMiddleware(guard.securityHeaders, {
    socket: { encrypted: false }, headers: { "x-forwarded-proto": "https" }
  });
  assert.equal(continued, 1);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(response.headers.has("strict-transport-security"), false);
  assert.deepEqual(response.removed, ["x-powered-by"]);
  assert.equal(response.headers.has("content-security-policy"), false);
});

test("HSTS is sent only on secure requests and supports a trusted proxy resolver", () => {
  const direct = createSecurityHeaders();
  const tls = runMiddleware(direct.middleware, { socket: { encrypted: true } });
  assert.equal(tls.response.headers.get("strict-transport-security"), "max-age=31536000");
  const behindProxy = createSecurityHeaders({
    isSecureRequest: (request) => request.headers["x-forwarded-proto"] === "https",
    hsts: { includeSubDomains: true, maxAgeSeconds: 31_536_000 }
  });
  const proxied = runMiddleware(behindProxy.middleware, {
    socket: { encrypted: false }, headers: { "x-forwarded-proto": "https" }
  });
  assert.equal(proxied.response.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains");
});

test("CSP is only emitted when explicitly configured and rejects header injection", () => {
  const configured = createSecurityHeaders({
    contentSecurityPolicy: "default-src 'self'; object-src 'none'; base-uri 'self'",
    frameOptions: "DENY", hsts: { enabled: false }
  });
  const result = runMiddleware(configured.middleware, { socket: { encrypted: false } });
  assert.equal(result.response.headers.get("content-security-policy"),
    "default-src 'self'; object-src 'none'; base-uri 'self'");
  assert.equal(result.response.headers.get("x-frame-options"), "DENY");
  assert.throws(() => createSecurityHeaders({
    contentSecurityPolicy: "default-src 'self'\r\nSet-Cookie: attacker=true"
  }), /single-line string/);
  assert.throws(() => createSecurityHeaders({ hsts: { preload: true } }), /preload requires/);
  assert.throws(() => createSecurityHeaders({
    contentSecurityPolicy: "default-src 'self'",
    contentSecurityPolicyReportOnly: "default-src 'none'"
  }), /either enforced CSP or report-only CSP/);
});

test("security header configuration rejects unknown or invalid policy values", () => {
  assert.throws(() => createSecurityHeaders({ unknown: true }), /Unknown securityHeaders option/);
  assert.throws(() => createSecurityHeaders({ frameOptions: "ALLOWALL" }), /frameOptions/);
  assert.throws(() => createSecurityHeaders({ referrerPolicy: "unsafe" }), /referrerPolicy/);
  assert.throws(() => createSecurityHeaders({ isSecureRequest: true }), /isSecureRequest/);
});
