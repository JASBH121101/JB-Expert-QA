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
      if (result.enforced) response.setHeader("Retry-After", String(result.retryAfterSeconds));
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
      ip: { maxFailures: 3, lockoutMs: 1000, maxLockoutMs: 8000 },
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


test("rate-limit table saturation fails closed without evicting live client buckets", async () => {
  await withGuard({
    mode: "balanced",
    rateLimit: { max: 100, windowMs: 60_000, maxKeys: 1 },
    keyGenerator: (request) => request.headers["x-test-client"] ?? "missing"
  }, async ({ events, request, guard }) => {
    assert.equal((await request("/ok", {
      headers: { "x-test-client": "client-a" }
    })).statusCode, 200);
    const saturated = await request("/ok", {
      headers: { "x-test-client": "client-b" }
    });
    assert.equal(saturated.statusCode, 429);
    assert.equal(JSON.parse(saturated.body).error, "request_blocked");
    const repeated = await request("/ok", {
      headers: { "x-test-client": "client-c" }
    });
    assert.equal(repeated.statusCode, 429);
    assert.ok(events.some((event) => event.ruleIds.includes("JBG-RATE-002")));
    assert.equal(events.filter((event) => event.ruleIds.includes("JBG-RATE-002")).length, 1);
    assert.equal(guard.getStats().rateLimitKeys, 1);
  });
});

test("authentication bucket saturation preserves existing lockout state and fails closed for new identities", () => {
  const guard = createSecurityGuard({ mode: "balanced", rateLimit: { enabled: false } });
  const auth = guard.createAuthProtection({
    identityKeyGenerator: (request) => request.account,
    clientKeyGenerator: (request) => request.client,
    maxTrackedKeys: 1,
    policies: {
      ip: { maxFailures: 2, lockoutMs: 1000, maxLockoutMs: 2000 },
      accountIp: { maxFailures: 2, lockoutMs: 1000, maxLockoutMs: 2000 },
      account: { maxFailures: 2, lockoutMs: 1000, maxLockoutMs: 2000 }
    },
    clock: () => 10_000
  });
  auth.recordFailure({ account: "account-a", client: "client-a" });
  auth.recordFailure({ account: "account-b", client: "client-b" });
  auth.recordFailure({ account: "account-c", client: "client-c" });
  assert.equal(auth.getStatus({ account: "account-d", client: "client-d" }).blocked, true);
  assert.equal(auth.getStats().trackedIpKeys, 1);
  assert.equal(auth.getStats().trackedAccountIpKeys, 1);
  assert.equal(auth.getStats().trackedAccountKeys, 1);
  auth.reset();
  assert.equal(auth.getStatus({ account: "account-d", client: "client-d" }).blocked, false);
});

test("authentication storage reclaims expired buckets but never evicts live ones", () => {
  let now = 1_000;
  const guard = createSecurityGuard({ mode: "balanced", rateLimit: { enabled: false } });
  const auth = guard.createAuthProtection({
    identityKeyGenerator: (request) => request.account,
    clientKeyGenerator: (request) => request.client,
    maxTrackedKeys: 1,
    resetAfterMs: 1_000,
    clock: () => now,
    policies: {
      ip: { maxFailures: 5, lockoutMs: 1000, maxLockoutMs: 2000 },
      accountIp: { maxFailures: 5, lockoutMs: 1000, maxLockoutMs: 2000 },
      account: { maxFailures: 5, lockoutMs: 1000, maxLockoutMs: 2000 }
    }
  });
  auth.recordFailure({ account: "expired-account", client: "expired-client" });
  now += 1_001;
  auth.recordFailure({ account: "new-account", client: "new-client" });
  assert.equal(auth.getStats().trackedIpKeys, 1);
  assert.equal(auth.getStats().trackedAccountIpKeys, 1);
  assert.equal(auth.getStats().trackedAccountKeys, 1);
  assert.equal(auth.getStatus({ account: "third-account", client: "third-client" }).blocked, false);
});


function invokeGuardDirect(guard, request) {
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
  guard.middleware(request, response, () => { continued += 1; });
  return { response, headers, continued };
}

test("repeated URL decoding cannot hide path traversal signatures", async () => {
  await withGuard({ mode: "balanced", rateLimit: { enabled: false } }, async ({ events, request }) => {
    const response = await request("/files/%2525252e%2525252e%2525252fprivate.txt");
    assert.equal(response.statusCode, 403);
    assert.ok(events[0].ruleIds.includes("JBG-PATH-001"));
  });
});

test("malformed and encoded control characters are rejected before routing", async () => {
  await withGuard({ mode: "balanced", rateLimit: { enabled: false } }, async ({ events, request }) => {
    const malformed = await request("/search?q=%ZZ");
    assert.equal(malformed.statusCode, 400);
    assert.ok(events.some((event) => event.ruleIds.includes("JBG-REQ-003")));

    const encodedControl = await request("/search?q=%250d%250aInjected");
    assert.equal(encodedControl.statusCode, 400);
    assert.ok(events.some((event) => event.ruleIds.includes("JBG-REQ-004")));
  });
});

test("ambiguous HTTP message framing is rejected when the adapter exposes raw headers", () => {
  const guard = createSecurityGuard({ mode: "balanced", rateLimit: { enabled: false } });
  const result = invokeGuardDirect(guard, {
    url: "/submit", method: "POST",
    headers: { "content-length": "5", "transfer-encoding": "chunked" },
    rawHeaders: ["Host", "example.test", "Content-Length", "5", "Transfer-Encoding", "chunked"],
    socket: { remoteAddress: "192.0.2.20" }
  });
  assert.equal(result.response.statusCode, 400);
  assert.equal(result.continued, 0);
  assert.equal(JSON.parse(result.response.body).error, "request_blocked");
  assert.ok(result.headers.has("cache-control"));
  assert.ok(guard.getStats().byRule["JBG-HTTP-005"] >= 1);
});

test("conflicting duplicate Content-Length headers are rejected", () => {
  const guard = createSecurityGuard({ mode: "balanced", rateLimit: { enabled: false } });
  const result = invokeGuardDirect(guard, {
    url: "/submit", method: "POST",
    headers: { "content-length": "5, 6" },
    rawHeaders: ["Host", "example.test", "Content-Length", "5", "Content-Length", "6"],
    socket: { remoteAddress: "192.0.2.21" }
  });
  assert.equal(result.response.statusCode, 400);
  assert.equal(result.continued, 0);
  assert.ok(guard.getStats().byRule["JBG-HTTP-006"] >= 1);
});

test("security configuration fails fast on misspelled or unsupported options", () => {
  assert.throws(() => createSecurityGuard({ maxHeaderByes: 123 }), /Unknown Security Guard option/);
  assert.throws(() => createSecurityGuard({ rateLimit: { maxKeeys: 10 } }), /Unknown rateLimit option/);
  assert.throws(() => createSecurityGuard({ securityHeaders: { unexpected: true } }),
    /Unknown securityHeaders option/);
});

test("authentication configuration rejects unknown options, duplicate severities and invalid clocks", () => {
  const guard = createSecurityGuard({ mode: "balanced", rateLimit: { enabled: false } });
  assert.throws(() => guard.createAuthProtection({
    identityKeyGenerator: () => "account", maxTrackdKeys: 10
  }), /Unknown authentication protection option/);
  assert.throws(() => guard.createAuthProtection({
    identityKeyGenerator: () => "account", blockSeverities: ["high", "high"]
  }), /unique supported severity names/);
  const invalidClock = guard.createAuthProtection({
    identityKeyGenerator: () => "account", clock: () => Number.NaN
  });
  assert.throws(() => invalidClock.recordFailure({
    socket: { remoteAddress: "192.0.2.22" }
  }), /non-negative safe integer timestamp/);
});

test("normalizes Unicode compatibility forms before high-confidence request inspection", async () => {
  await withGuard({ mode: "balanced", rateLimit: { enabled: false } }, async ({ events, request }) => {
    const fullWidthXss = await request("/search?q=%EF%BC%9Cscript%EF%BC%9Ealert(1)");
    assert.equal(fullWidthXss.statusCode, 403);
    assert.ok(events[0].ruleIds.includes("JBG-XSS-001"));
  });
});

test("does not block ordinary search text containing common SQL vocabulary", async () => {
  await withGuard({ mode: "balanced", rateLimit: { enabled: false } }, async ({ events, request }) => {
    const response = await request("/search?q=select%20a%20perfume%20with%20union%20of%20floral%20notes");
    assert.equal(response.statusCode, 200);
    assert.equal(events.length, 0);
  });
});
\n

test("normalizes full-width separators before path traversal inspection", async () => {
  await withGuard({ mode: "balanced", rateLimit: { enabled: false } }, async ({ events, request }) => {
    const response = await request("/files/%EF%BC%8E%EF%BC%8E%EF%BC%8Fprivate.txt");
    assert.equal(response.statusCode, 403);
    assert.ok(events[0].ruleIds.includes("JBG-PATH-001"));
  });
});

test("normalizes full-width SQL operators while preserving benign Unicode searches", async () => {
  await withGuard({ mode: "balanced", rateLimit: { enabled: false } }, async ({ events, request }) => {
    const attack = await request("/search?q=%EF%BC%87%20%EF%BC%AF%EF%BC%B2%20%EF%BC%91%EF%BC%9D%EF%BC%91");
    assert.equal(attack.statusCode, 403);
    assert.ok(events[0].ruleIds.includes("JBG-SQLI-001"));

    const ordinary = await request("/search?q=caf%C3%A9%20select%20floral%20notes");
    assert.equal(ordinary.statusCode, 200);
    assert.equal(events.length, 1);
  });
});


test("benign marketplace and application traffic stays unblocked across a normal-input corpus", async () => {
  const benignPaths = [
    "/search?q=select+the+best+perfume",
    "/search?q=union+of+floral+notes",
    "/search?q=O%27Reilly+travel+adapter",
    "/search?q=drop+off+delivery+point",
    "/search?q=and+or+but",
    "/products/iphone-18-pro?color=black&storage=256",
    "/search?q=caf%C3%A9+con+leche",
    "/search?q=東京+camera",
    "/catalog/perfumes?sort=price-asc&page=2",
    "/catalog/phones?brand=samsung&min=100&max=500",
    "/checkout?step=shipping&method=pickup",
    "/help?topic=account+recovery",
    "/search?q=100%25+cotton+shirt",
    "/search?q=rock+%26+roll+headphones",
    "/search?q=kids%27+school+backpack",
    "/products/laptop?description=select+your+preferred+storage",
    "/search?q=union+membership+benefits",
    "/search?q=drop+shipping+explained",
    "/search?q=or+and+not+keywords",
    "/health?verbose=false&format=json"
  ];

  await withGuard({ mode: "balanced", rateLimit: { enabled: false } }, async ({ events, request }) => {
    for (const path of benignPaths) {
      const response = await request(path);
      assert.equal(response.statusCode, 200, "Benign request must remain available: " + path);
    }
    assert.equal(events.length, 0, "Normal corpus must not generate security incidents");
  });
});
