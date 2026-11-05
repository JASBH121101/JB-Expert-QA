import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createSecurityGuard } from "@jb/security-guard";

async function withGuard(options, run) {
  const events = [];
  const guard = createSecurityGuard({
    ...options,
    onEvent(event) {
      events.push(event);
      options?.onEvent?.(event);
    }
  });
  const server = createServer((request, response) => {
    guard.middleware(request, response, () => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("application handler reached");
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    await run({
      events,
      guard,
      server,
      request(path, options = {}) {
        return new Promise((resolve, reject) => {
          const outgoing = httpRequest({
            host: "127.0.0.1",
            port: server.address().port,
            path,
            method: options.method ?? "GET",
            headers: options.headers ?? {}
          }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => { body += chunk; });
            response.on("end", () => resolve({
              statusCode: response.statusCode,
              body,
              headers: response.headers
            }));
          });
          outgoing.once("error", reject);
          if (options.body !== undefined) outgoing.write(options.body);
          outgoing.end();
        });
      }
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("monitor mode reports a SQL injection signature but keeps the request flowing", async () => {
  await withGuard({ mode: "monitor", rateLimit: { enabled: false } }, async ({ events, guard, request }) => {
    const response = await request("/search?q=%27%20OR%201%3D1");

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "application handler reached");
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "observed");
    assert.ok(events[0].ruleIds.includes("JBG-SQLI-001"));
    assert.equal(JSON.stringify(events).includes("1%3D1"), false);
    assert.equal(JSON.stringify(events).includes("OR 1=1"), false);
    assert.equal(guard.getStats().observed, 1);
    assert.equal(guard.getStats().blocked, 0);
  });
});

test("balanced mode blocks a high-confidence XSS request with a generic response", async () => {
  await withGuard({ mode: "balanced", rateLimit: { enabled: false } }, async ({ events, guard, request }) => {
    const response = await request("/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E");

    assert.equal(response.statusCode, 403);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.headers["content-type"], /application\/json/);
    assert.equal(JSON.parse(response.body).error, "request_blocked");
    assert.equal(response.body.includes("script"), false);
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "blocked");
    assert.ok(events[0].ruleIds.includes("JBG-XSS-001"));
    assert.equal(guard.getStats().blocked, 1);
  });
});

test("balanced mode detects encoded path traversal", async () => {
  await withGuard({ mode: "balanced", rateLimit: { enabled: false } }, async ({ events, request }) => {
    const response = await request("/files/%2e%2e/%2e%2e/private.txt");

    assert.equal(response.statusCode, 403);
    assert.ok(events[0].ruleIds.includes("JBG-PATH-001"));
  });
});

test("rate limiting ignores spoofed forwarded headers by default", async () => {
  await withGuard({
    mode: "balanced",
    rateLimit: { enabled: true, max: 1, windowMs: 60_000, maxKeys: 10 }
  }, async ({ events, request, guard }) => {
    const first = await request("/health", {
      headers: { "x-forwarded-for": "198.51.100.10" }
    });
    const second = await request("/health", {
      headers: { "x-forwarded-for": "203.0.113.20" }
    });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 429);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].ruleIds, ["JBG-RATE-001"]);
    assert.equal(guard.getStats().blocked, 1);
    assert.equal(guard.getStats().rateLimitKeys, 1);
  });
});

test("content-length limits are enforced before an application body parser", async () => {
  await withGuard({
    mode: "balanced",
    maxBodyBytes: 10,
    rateLimit: { enabled: false }
  }, async ({ events, request }) => {
    const response = await request("/upload", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "11"
      },
      body: "01234567890"
    });

    assert.equal(response.statusCode, 413);
    assert.ok(events[0].ruleIds.includes("JBG-HTTP-003"));
  });
});

test("strict mode also blocks medium-severity header-limit findings", async () => {
  await withGuard({
    mode: "strict",
    maxHeaderCount: 3,
    rateLimit: { enabled: false }
  }, async ({ events, request }) => {
    const response = await request("/headers", {
      headers: {
        "x-one": "1",
        "x-two": "2",
        "x-three": "3",
        "x-four": "4"
      }
    });

    assert.equal(response.statusCode, 431);
    assert.ok(events[0].ruleIds.includes("JBG-HTTP-001"));
  });
});

test("event logger failures do not interrupt request processing", async () => {
  const guard = createSecurityGuard({
    mode: "monitor",
    rateLimit: { enabled: false },
    onEvent() { throw new Error("logger unavailable"); }
  });

  let continued = false;
  const request = {
    url: "/?q=%3Cscript%3E",
    method: "GET",
    headers: {},
    rawHeaders: [],
    socket: { remoteAddress: "127.0.0.1" }
  };
  const response = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    end() { this.writableEnded = true; }
  };

  guard.middleware(request, response, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(guard.getStats().observed, 1);
});

test("custom mode validates severity policy and exposes resettable counters", () => {
  assert.throws(
    () => createSecurityGuard({ mode: "unsupported" }),
    /mode must be one of/
  );
  assert.throws(
    () => createSecurityGuard({ mode: "custom", blockSeverities: ["not-a-severity"] }),
    /blockSeverities/
  );

  const guard = createSecurityGuard({ mode: "custom", rateLimit: { enabled: false } });
  assert.equal(guard.getStats().mode, "custom");
  guard.reset();
  assert.equal(guard.getStats().requests, 0);
  assert.equal(guard.getStats().incidents, 0);
});


async function withAuth(options, run) {
  const events = [];
  const guard = createSecurityGuard({
    mode: options.mode ?? "balanced",
    rateLimit: { enabled: false }
  });
  const auth = guard.createAuthProtection({
    identityKeyGenerator: (request) => request.headers["x-test-account"],
    clientKeyGenerator: (request) => request.headers["x-test-client"] ?? request.socket?.remoteAddress,
    policies: options.policies,
    windowMs: options.windowMs,
    resetAfterMs: options.resetAfterMs,
    maxTrackedKeys: options.maxTrackedKeys,
    keySecret: "test-only-hmac-key-material-32-bytes",
    clock: options.clock,
    onEvent(event) {
      events.push(event);
    }
  });

  const server = createServer((request, response) => {
    auth.middleware(request, response, () => {
      if (request.url === "/success") {
        auth.recordSuccess(request);
        response.statusCode = 204;
        response.end();
        return;
      }

      const result = auth.recordFailure(request);
      response.statusCode = result.enforced ? 429 : 401;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        error: result.enforced ? "authentication_temporarily_unavailable" : "invalid_credentials"
      }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    await run({
      auth,
      events,
      server,
      request(path = "/login", headers = {}) {
        return new Promise((resolve, reject) => {
          const outgoing = httpRequest({
            host: "127.0.0.1",
            port: server.address().port,
            path,
            method: "POST",
            headers: {
              "x-test-account": "customer@example.test",
              ...headers
            }
          }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => { body += chunk; });
            response.on("end", () => resolve({
              statusCode: response.statusCode,
              body,
              headers: response.headers
            }));
          });
          outgoing.once("error", reject);
          outgoing.end();
        });
      }
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const fastPairPolicy = {
  ip: { maxFailures: 100, lockoutMs: 1000, maxLockoutMs: 8000 },
  accountIp: { maxFailures: 3, lockoutMs: 1000, maxLockoutMs: 8000 },
  account: { maxFailures: 100, lockoutMs: 1000, maxLockoutMs: 8000 }
};

test("account and IP combination is throttled after repeated failed logins", async () => {
  await withAuth({ policies: fastPairPolicy }, async ({ auth, events, request }) => {
    assert.equal((await request()).statusCode, 401);
    assert.equal((await request()).statusCode, 401);
    const threshold = await request();

    assert.equal(threshold.statusCode, 429);
    assert.equal(JSON.parse(threshold.body).error, "authentication_temporarily_unavailable");
    assert.ok(Number(threshold.headers["retry-after"]) >= 1);

    const before = auth.getStats().failures;
    const blocked = await request();
    assert.equal(blocked.statusCode, 429);
    assert.equal(auth.getStats().failures, before);
    assert.equal(auth.getStats().blocked, 1);

    assert.equal(events.length, 1);
    assert.equal(events[0].action, "throttle-started");
    assert.ok(events[0].ruleIds.includes("JBG-AUTH-BRUTE-001"));
    assert.deepEqual(events[0].scopes, ["accountIp"]);
  });
});

test("monitor mode observes brute-force lockouts without rejecting authentication requests", async () => {
  await withAuth({
    mode: "monitor",
    policies: {
      ip: { maxFailures: 100, lockoutMs: 1000, maxLockoutMs: 8000 },
      accountIp: { maxFailures: 1, lockoutMs: 1000, maxLockoutMs: 8000 },
      account: { maxFailures: 100, lockoutMs: 1000, maxLockoutMs: 8000 }
    }
  }, async ({ events, request, auth }) => {
    assert.equal((await request()).statusCode, 401);
    const observed = await request();

    assert.equal(observed.statusCode, 401);
    assert.equal(auth.getStats().observed, 1);
    assert.equal(auth.getStats().blocked, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "throttle-observed");
  });
});

test("account-level throttling correlates attempts from different client addresses", async () => {
  await withAuth({
    policies: {
      ip: { maxFailures: 100, lockoutMs: 1000, maxLockoutMs: 8000 },
      accountIp: { maxFailures: 100, lockoutMs: 1000, maxLockoutMs: 8000 },
      account: { maxFailures: 3, lockoutMs: 1000, maxLockoutMs: 8000 }
    }
  }, async ({ events, request }) => {
    assert.equal((await request("/login", { "x-test-client": "192.0.2.1" })).statusCode, 401);
    assert.equal((await request("/login", { "x-test-client": "192.0.2.2" })).statusCode, 401);
    assert.equal((await request("/login", { "x-test-client": "192.0.2.3" })).statusCode, 429);

    const blockedFromNewClient = await request("/login", { "x-test-client": "192.0.2.4" });
    assert.equal(blockedFromNewClient.statusCode, 429);
    assert.ok(events[0].scopes.includes("account"));
  });
});

test("successful authentication clears account and account-IP failures but not the IP bucket", async () => {
  await withAuth({
    policies: {
      ip: { maxFailures: 2, lockoutMs: 1000, maxLockoutMs: 8000 },
      accountIp: { maxFailures: 100, lockoutMs: 1000, maxLockoutMs: 8000 },
      account: { maxFailures: 100, lockoutMs: 1000, maxLockoutMs: 8000 }
    }
  }, async ({ request }) => {
    assert.equal((await request("/login", { "x-test-account": "first@example.test" })).statusCode, 401);
    assert.equal((await request("/success", { "x-test-account": "first@example.test" })).statusCode, 204);

    assert.equal((await request("/login", { "x-test-account": "second@example.test" })).statusCode, 401);
    const stillRateLimitedByIp = await request("/login", { "x-test-account": "second@example.test" });
    assert.equal(stillRateLimitedByIp.statusCode, 429);
  });
});

test("lockout duration increases progressively and expires", async () => {
  let now = 1_000_000;
  await withAuth({
    clock: () => now,
    policies: {
      ip: { maxFailures: 100, lockoutMs: 1000, maxLockoutMs: 4000 },
      accountIp: { maxFailures: 1, lockoutMs: 1000, maxLockoutMs: 4000 },
      account: { maxFailures: 100, lockoutMs: 1000, maxLockoutMs: 4000 }
    }
  }, async ({ auth, request }) => {
    await request();
    assert.equal(auth.getStatus({
      headers: { "x-test-account": "customer@example.test" },
      socket: { remoteAddress: "127.0.0.1" }
    }).retryAfterMs, 1000);

    now += 1001;
    await request();
    assert.equal(auth.getStatus({
      headers: { "x-test-account": "customer@example.test" },
      socket: { remoteAddress: "127.0.0.1" }
    }).retryAfterMs, 2000);
  });
});

test("authentication events do not expose account identifiers or client addresses", async () => {
  await withAuth({ policies: fastPairPolicy }, async ({ events, request }) => {
    for (let index = 0; index < 3; index += 1) {
      await request("/login", {
        "x-test-account": "sensitive-person@example.test",
        "x-test-client": "203.0.113.77"
      });
    }

    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("sensitive-person@example.test"), false);
    assert.equal(serialized.includes("203.0.113.77"), false);
    assert.equal(serialized.includes("test-only-hmac-key-material"), false);
  });
});

test("auth protection validates identity resolver and safely bounds tracked keys", () => {
  const guard = createSecurityGuard({ mode: "balanced", rateLimit: { enabled: false } });
  assert.throws(() => guard.createAuthProtection(), /identityKeyGenerator is required/);
  assert.throws(() => guard.createAuthProtection({
    identityKeyGenerator: () => "user",
    maxTrackedKeys: 0
  }), /maxTrackedKeys/);

  const auth = guard.createAuthProtection({
    identityKeyGenerator: () => "user",
    maxTrackedKeys: 2
  });
  auth.recordFailure({ socket: { remoteAddress: "192.0.2.1" } });
  auth.recordFailure({ socket: { remoteAddress: "192.0.2.2" } });
  auth.recordFailure({ socket: { remoteAddress: "192.0.2.3" } });

  assert.ok(auth.getStats().trackedIpKeys <= 2);
  assert.ok(auth.getStats().trackedAccountKeys <= 2);
  auth.reset();
  assert.equal(auth.getStats().failures, 0);
  assert.equal(auth.getStats().trackedIpKeys, 0);
});
