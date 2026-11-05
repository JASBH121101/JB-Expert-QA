import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { configureNodeHttpServer } from "@jb/security-guard";

test("Node HTTP server receives conservative timeout and connection limits", () => {
  const server = createServer();
  const result = configureNodeHttpServer(server);

  assert.equal(result.server, server);
  assert.equal(server.headersTimeout, 10_000);
  assert.equal(server.requestTimeout, 30_000);
  assert.equal(server.keepAliveTimeout, 5_000);
  assert.equal(server.timeout, 60_000);
  assert.equal(server.maxRequestsPerSocket, 100);
  assert.equal(server.maxHeadersCount, 100);
  assert.equal(server.listenerCount("checkContinue"), 1);
  server.close();
});

test("server hardening validates configuration and must run before listen", () => {
  const server = createServer();
  assert.throws(() => configureNodeHttpServer(server, { headersTimeout: 40_000 }), /headersTimeout must be lower/);
  assert.throws(() => configureNodeHttpServer(server, { maxHeaderCount: 10 }), /Unknown server hardening option/);
  assert.throws(() => configureNodeHttpServer(server, { maxBodyBytes: 0 }), /maxBodyBytes/);
  assert.throws(() => configureNodeHttpServer(server, { handleExpectContinue: "yes" }), /handleExpectContinue/);
  assert.throws(() => configureNodeHttpServer({ listening: true, on() {}, emit() {}, listenerCount() { return 0; } }),
    /before calling listen/);
  server.close();
});

test("oversized Expect: 100-continue requests are rejected before the body is accepted", async () => {
  let applicationReached = false;
  const server = createServer((request, response) => {
    applicationReached = true;
    response.statusCode = 200;
    response.end("application reached");
  });
  configureNodeHttpServer(server, { maxBodyBytes: 5 });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const response = await new Promise((resolve, reject) => {
      const outgoing = httpRequest({
        host: "127.0.0.1",
        port: server.address().port,
        path: "/upload",
        method: "POST",
        headers: {
          Expect: "100-continue",
          "Content-Length": "10"
        }
      }, (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => { body += chunk; });
        incoming.on("end", () => resolve({ statusCode: incoming.statusCode, body, headers: incoming.headers }));
      });
      outgoing.once("error", reject);
      outgoing.flushHeaders();
      outgoing.on("continue", () => outgoing.end("0123456789"));
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(response.body).error, "request_body_too_large");
    assert.equal(applicationReached, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("valid Expect: 100-continue requests continue through the ordinary application handler", async () => {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.statusCode = 200;
      response.end(body);
    });
  });
  configureNodeHttpServer(server, { maxBodyBytes: 10 });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const response = await new Promise((resolve, reject) => {
      const outgoing = httpRequest({
        host: "127.0.0.1",
        port: server.address().port,
        path: "/upload",
        method: "POST",
        headers: {
          Expect: "100-continue",
          "Content-Length": "4"
        }
      }, (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => { body += chunk; });
        incoming.on("end", () => resolve({ statusCode: incoming.statusCode, body }));
      });
      outgoing.once("error", reject);
      outgoing.flushHeaders();
      outgoing.on("continue", () => outgoing.end("safe"));
    });

    assert.deepEqual(response, { statusCode: 200, body: "safe" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("custom checkContinue listeners are not overwritten and failed configuration is atomic", () => {
  const server = createServer();
  const originalHeadersTimeout = server.headersTimeout;
  server.on("checkContinue", () => {});
  assert.throws(() => configureNodeHttpServer(server), /checkContinue listener already exists/);
  assert.equal(server.headersTimeout, originalHeadersTimeout);
  assert.equal(server.listenerCount("checkContinue"), 1);
  server.close();
});
