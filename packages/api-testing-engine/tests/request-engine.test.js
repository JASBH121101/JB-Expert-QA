import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  API_TESTING_ENGINE_ID,
  ApiTestingError,
  createApiRequestEngine
} from "../src/index.js";

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    server,
    origin: "http://127.0.0.1:" + address.port,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

function createEngine(origin, options = {}) {
  return createApiRequestEngine({ allowedOrigins: [origin], ...options });
}

test("engine exposes its identity and requires an exact HTTP(S) origin allowlist", () => {
  assert.equal(API_TESTING_ENGINE_ID, "jb.api-testing-engine");
  assert.throws(() => createApiRequestEngine(), /allowedOrigins/u);
  assert.throws(() => createApiRequestEngine({ allowedOrigins: [] }), /allowedOrigins/u);
  assert.throws(() => createApiRequestEngine({ allowedOrigins: ["https://example.test/api"] }), /exact HTTP\(S\) origins/u);
  assert.throws(() => createApiRequestEngine({ allowedOrigins: ["https://user:pass@example.test"] }), /exact HTTP\(S\) origins/u);
  assert.throws(() => createApiRequestEngine({ allowedOrigins: ["ftp://example.test"] }), /exact HTTP\(S\) origins/u);
});

test("GET returns status, headers, timing, byte count and parsed JSON", async () => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "x-fixture": "ok" });
    response.end(JSON.stringify({ id: 7, active: true }));
  });
  try {
    const result = await createEngine(fixture.origin).request({
      method: "GET",
      url: fixture.origin + "/users/7"
    });
    assert.equal(result.engineId, API_TESTING_ENGINE_ID);
    assert.equal(result.status, 200);
    assert.equal(result.ok, true);
    assert.deepEqual(result.json, { id: 7, active: true });
    assert.equal(result.jsonParsed, true);
    assert.equal(result.headers["x-fixture"], "ok");
    assert.equal(result.bytesReceived, Buffer.byteLength(result.bodyText));
    assert.ok(result.durationMs >= 0);
  } finally {
    await fixture.close();
  }
});

test("POST JSON serializes the request and sets Content-Type", async () => {
  const fixture = await listen(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      method: request.method,
      contentType: request.headers["content-type"],
      payload: JSON.parse(Buffer.concat(chunks).toString("utf8"))
    }));
  });
  try {
    const result = await createEngine(fixture.origin).request({
      method: "POST",
      url: fixture.origin + "/items",
      json: { name: "sample", quantity: 2 }
    });
    assert.equal(result.status, 201);
    assert.deepEqual(result.json.payload, { name: "sample", quantity: 2 });
    assert.equal(result.json.method, "POST");
    assert.match(result.json.contentType, /application\/json/u);
  } finally {
    await fixture.close();
  }
});

test("authorization is sent and sensitive response headers are redacted", async () => {
  const fixture = await listen((request, response) => {
    response.writeHead(200, {
      "content-type": "text/plain",
      "x-api-key": "response-secret",
      "set-cookie": "session=secret-value; HttpOnly"
    });
    response.end(request.headers.authorization || "missing");
  });
  try {
    const result = await createEngine(fixture.origin).request({
      method: "GET",
      url: fixture.origin,
      headers: { authorization: "Bearer fixture-token" }
    });
    assert.equal(result.bodyText, "Bearer fixture-token");
    assert.equal(result.headers["x-api-key"], "[REDACTED]");
    assert.equal(result.headers["set-cookie"], "[REDACTED]");
  } finally {
    await fixture.close();
  }
});

test("an origin outside the allowlist is blocked before fetch", async () => {
  let calls = 0;
  const fixture = await listen((_request, response) => response.end("unused"));
  try {
    const guarded = createEngine("https://api.example.test", {
      fetchImpl: async () => {
        calls += 1;
        return new Response("unexpected");
      }
    });
    await assert.rejects(
      guarded.request({ method: "GET", url: fixture.origin + "/private" }),
      (error) => error instanceof ApiTestingError && error.code === "ORIGIN_NOT_ALLOWED"
    );
    assert.equal(calls, 0);
  } finally {
    await fixture.close();
  }
});

test("unsafe protocols, credentials, fragments and relative URLs are rejected", async () => {
  const guarded = createEngine("https://api.example.test", { fetchImpl: async () => new Response("unused") });
  for (const url of [
    "file:///etc/passwd",
    "ftp://api.example.test/resource",
    "https://user:password@api.example.test/resource",
    "https://api.example.test/resource#fragment",
    "/relative/path"
  ]) {
    await assert.rejects(guarded.request({ method: "GET", url }));
  }
});

test("unsupported methods and extra request fields are rejected", async () => {
  const guarded = createEngine("https://api.example.test", { fetchImpl: async () => new Response("unused") });
  await assert.rejects(
    guarded.request({ method: "TRACE", url: "https://api.example.test/" }),
    /request.method/u
  );
  await assert.rejects(
    guarded.request({ method: "GET", url: "https://api.example.test/", shell: "echo no" }),
    /unsupported fields/u
  );
});

test("GET and HEAD requests cannot contain a body", async () => {
  const guarded = createEngine("https://api.example.test", { fetchImpl: async () => new Response("unused") });
  await assert.rejects(
    guarded.request({ method: "GET", url: "https://api.example.test/", body: "x" }),
    /cannot contain a body/u
  );
  await assert.rejects(
    guarded.request({ method: "HEAD", url: "https://api.example.test/", json: {} }),
    /cannot contain a body/u
  );
});

test("request bodies are bounded and JSON input rejects unsafe values", async () => {
  const guarded = createEngine("https://api.example.test", {
    maxRequestBytes: 20,
    fetchImpl: async () => new Response("unused")
  });
  await assert.rejects(
    guarded.request({ method: "POST", url: "https://api.example.test/", body: "x".repeat(21) }),
    (error) => error.code === "REQUEST_TOO_LARGE"
  );
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(
    guarded.request({ method: "POST", url: "https://api.example.test/", json: cyclic }),
    /circular data/u
  );
  await assert.rejects(
    guarded.request({ method: "POST", url: "https://api.example.test/", json: { value: Number.NaN } }),
    /non-finite/u
  );
  await assert.rejects(
    guarded.request({ method: "POST", url: "https://api.example.test/", json: { get value() { return "unsafe"; } } }),
    /accessors/u
  );
});

test("transport and proxy headers cannot be overridden", async () => {
  const guarded = createEngine("https://api.example.test", { fetchImpl: async () => new Response("unused") });
  for (const name of ["host", "connection", "content-length", "transfer-encoding", "proxy-authorization"]) {
    await assert.rejects(
      guarded.request({
        method: "GET",
        url: "https://api.example.test/",
        headers: { [name]: "override" }
      }),
      /forbidden header/u
    );
  }
});

test("redirect response is returned without following the Location", async () => {
  let targetCalls = 0;
  const fixture = await listen((request, response) => {
    if (request.url === "/start") {
      response.writeHead(302, { location: "/target" });
      response.end();
      return;
    }
    if (request.url === "/target") targetCalls += 1;
    response.end("target");
  });
  try {
    const result = await createEngine(fixture.origin).request({
      method: "GET",
      url: fixture.origin + "/start"
    });
    assert.equal(result.status, 302);
    assert.equal(result.ok, false);
    assert.equal(targetCalls, 0);
  } finally {
    await fixture.close();
  }
});

test("response body size is bounded", async () => {
  const guarded = createEngine("https://api.example.test", {
    maxResponseBytes: 8,
    fetchImpl: async () => new Response("x".repeat(9), { headers: { "content-type": "text/plain" } })
  });
  await assert.rejects(
    guarded.request({ method: "GET", url: "https://api.example.test/" }),
    (error) => error instanceof ApiTestingError && error.code === "RESPONSE_TOO_LARGE"
  );
});

test("malformed JSON preserves HTTP status and reports the parse error", async () => {
  const guarded = createEngine("https://api.example.test", {
    fetchImpl: async () => new Response("{invalid", {
      status: 502,
      headers: { "content-type": "application/json" }
    })
  });
  const result = await guarded.request({ method: "GET", url: "https://api.example.test/" });
  assert.equal(result.status, 502);
  assert.equal(result.jsonParsed, false);
  assert.match(result.jsonParseError, /invalid JSON/u);
});

test("timeout aborts a stalled local request", async () => {
  const fixture = await listen((_request, response) => {
    setTimeout(() => {
      if (!response.destroyed) response.end("late");
    }, 150);
  });
  try {
    const guarded = createEngine(fixture.origin, { timeoutMs: 20 });
    await assert.rejects(
      guarded.request({ method: "GET", url: fixture.origin + "/slow" }),
      (error) => error instanceof ApiTestingError && error.code === "REQUEST_TIMEOUT"
    );
  } finally {
    await fixture.close();
  }
});

test("external AbortSignal cancels an in-flight request", async () => {
  const fixture = await listen((_request, response) => {
    setTimeout(() => {
      if (!response.destroyed) response.end("late");
    }, 150);
  });
  const controller = new AbortController();
  try {
    const pending = createEngine(fixture.origin).request(
      { method: "GET", url: fixture.origin + "/slow" },
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      pending,
      (error) => error instanceof ApiTestingError && error.code === "REQUEST_ABORTED"
    );
  } finally {
    await fixture.close();
  }
});

test("sensitive URL query parameters are redacted in returned URLs", async () => {
  const guarded = createEngine("https://api.example.test", {
    fetchImpl: async () => new Response("ok", { status: 200 })
  });
  const result = await guarded.request({
    method: "GET",
    url: "https://api.example.test/items?api_key=top-secret&search=normal"
  });
  assert.doesNotMatch(result.url, /top-secret/u);
  assert.match(result.url, /api_key=%5BREDACTED%5D/u);
  assert.match(result.url, /search=normal/u);
});
