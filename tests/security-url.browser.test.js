import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { auditSecurityUrl } from "../src/adapters/filesystem/audit-security-url.js";

test("runtime URL auditor refuses private destinations unless a local test opts in", async () => {
  await assert.rejects(
    auditSecurityUrl("http://127.0.0.1/"),
    /Private, loopback, link-local, or reserved IP destinations are blocked/
  );
});

test("runtime URL auditor can inspect a controlled local HTTP fixture without exploit requests", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()"
    });
    response.end("<!doctype html><html><head><title>Fixture</title></head><body>Security QA fixture</body></html>");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    const report = await auditSecurityUrl("http://127.0.0.1:" + address.port + "/", {
      allowPrivateNetworks: true,
      timeout: 15000
    });
    assert.equal(report.target.status, 200);
    assert.equal(report.runtimeAssessment.mode, "passive-browser-observation");
    assert.equal(report.runtimeAssessment.exploitPayloadsSent, false);
    assert.equal(report.runtimeAssessment.authenticatedSessionUsed, false);
    assert.ok(report.diagnostics.some((item) => item.id === "SEC-RUNTIME-HTTPS-001"));
    assert.equal(report.runtimeAssessment.databaseConnections, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("runtime URL auditor caps redirect chains before following excessive hops", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body><script>fetch('/redirect/0').catch(() => {});</script>Fixture</body></html>");
      return;
    }
    if (request.url?.startsWith("/redirect/")) {
      const hop = Number(request.url.split("/").at(-1));
      response.writeHead(302, { location: "/redirect/" + (hop + 1) });
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    const report = await auditSecurityUrl("http://127.0.0.1:" + address.port + "/", {
      allowPrivateNetworks: true,
      timeout: 15000
    });
    assert.ok(report.runtimeAssessment.blockedRequests.some((item) =>
      item.reason.includes("redirect chain exceeded the 10-hop safety limit")
    ));
    assert.equal(report.target.status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
