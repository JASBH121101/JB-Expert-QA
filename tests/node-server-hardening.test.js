import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { configureNodeHttpServer } from "@jb/security-guard";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
}

function readResponse(outgoing) {
  return new Promise((resolve, reject) => {
    outgoing.once("error", (error) => {
      if (error.code === "ECONNRESET") return;
      reject(error);
    });
    outgoing.once("response", (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve({
        statusCode: incoming.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: incoming.headers
      }));
      incoming.on("error", reject);
    });
  });
}

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
  assert.equal(server.listeners("request")[0] !== undefined, true);
  server.close();
});

test("server hardening validates configuration and must run before listen", () => {
  const server = createServer();
  assert.throws(() => configureNodeHttpServer(server, { headersTimeout: 40_000 }), /headersTimeout must be lower/);
  assert.throws(() => configureNodeHttpServer(server, { maxHeaderCount: 10 }), /Unknown server hardening option/);
  assert.throws(() => configureNodeHttpServer(server, { maxBodyBytes: 0 }), /maxBodyBytes/);
  assert.throws(() => configureNodeHttpServer(server, { handleExpectContinue: "yes" }), /handleExpectContinue/);
  assert.throws(() => configureNodeHttpServer({ listening: true, on() {}, emit() {}, prependListener() {}, listenerCount() { return 0; } }),
    /before calling listen/);
  server.close();
});

test("oversized Content-Length requests are rejected before application body handling", async () => {
  let applicationReached = false;
  const server = createServer((request, response) => {
    applicationReached = true;
    request.on("end", () => response.end("accepted"));
    request.resume();
  });
  configureNodeHttpServer(server, { maxBodyBytes: 5 });
  await listen(server);

  try {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: server.address().port,
      path: "/upload",
      method: "POST",
      headers: { "Content-Length": "10" }
    });
    const resultPromise = readResponse(outgoing);
    outgoing.end("0123456789");
    const result = await resultPromise;

    assert.equal(result.statusCode, 413);
    assert.equal(result.headers.connection, "close");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(result.body).error, "request_body_too_large");
    assert.equal(applicationReached, false);
  } finally {
    await close(server);
  }
});

test("chunked bodies are counted and rejected after the configured streamed byte limit", async () => {
  let applicationCompleted = false;
  let applicationBytes = 0;
  const server = createServer((request, response) => {
    request.on("data", (chunk) => { applicationBytes += chunk.length; });
    request.on("end", () => {
      applicationCompleted = true;
      response.end("accepted");
    });
  });
  configureNodeHttpServer(server, { maxBodyBytes: 5 });
  await listen(server);

  try {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: server.address().port,
      path: "/chunked",
      method: "POST",
      headers: { "Transfer-Encoding": "chunked" }
    });
    const resultPromise = readResponse(outgoing);
    outgoing.write("1234");
    outgoing.end("5678");
    const result = await resultPromise;

    assert.equal(result.statusCode, 413);
    assert.equal(result.headers.connection, "close");
    assert.equal(JSON.parse(result.body).error, "request_body_too_large");
    assert.equal(applicationCompleted, false);
    assert.ok(applicationBytes <= 5, "the chunk that would cross the limit must not reach application listeners");
  } finally {
    await close(server);
  }
});

test("chunked requests exactly at maxBodyBytes are accepted", async () => {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => response.end(body));
  });
  configureNodeHttpServer(server, { maxBodyBytes: 5 });
  await listen(server);

  try {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: server.address().port,
      path: "/exact",
      method: "POST",
      headers: { "Transfer-Encoding": "chunked" }
    });
    const resultPromise = readResponse(outgoing);
    outgoing.end("12345");
    const result = await resultPromise;
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, "12345");
  } finally {
    await close(server);
  }
});

test("oversized Expect: 100-continue requests are rejected before the body is accepted", async () => {
  let applicationCompleted = false;
  const server = createServer((request, response) => {
    request.on("end", () => {
      applicationCompleted = true;
      response.end("accepted");
    });
    request.resume();
  });
  configureNodeHttpServer(server, { maxBodyBytes: 5 });
  await listen(server);

  try {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: server.address().port,
      path: "/upload",
      method: "POST",
      headers: { Expect: "100-continue", "Content-Length": "10" }
    });
    const resultPromise = readResponse(outgoing);
    outgoing.flushHeaders();
    outgoing.on("continue", () => outgoing.end("0123456789"));
    const result = await resultPromise;

    assert.equal(result.statusCode, 413);
    assert.equal(JSON.parse(result.body).error, "request_body_too_large");
    assert.equal(applicationCompleted, false);
  } finally {
    await close(server);
  }
});

test("valid Expect: 100-continue requests continue through the ordinary application handler", async () => {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => response.end(body));
  });
  configureNodeHttpServer(server, { maxBodyBytes: 10 });
  await listen(server);

  try {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: server.address().port,
      path: "/upload",
      method: "POST",
      headers: { Expect: "100-continue", "Content-Length": "4" }
    });
    const resultPromise = readResponse(outgoing);
    outgoing.flushHeaders();
    outgoing.on("continue", () => outgoing.end("safe"));
    const result = await resultPromise;
    assert.deepEqual({ statusCode: result.statusCode, body: result.body }, { statusCode: 200, body: "safe" });
  } finally {
    await close(server);
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
