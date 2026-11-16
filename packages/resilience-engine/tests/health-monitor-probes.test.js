import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createHealthMonitor } from "../src/health-monitor.js";
import { createHealthMonitorProbeAdapter } from "../src/adapters/health-monitor-probes.js";

function makeMonitor() {
  const calls = [];
  const monitor = {
    observe(input) {
      calls.push(input);
      return Object.freeze({ ...input, recovery: null });
    }
  };
  return { monitor, calls };
}

function customProbe(id, serviceId, run, overrides = {}) {
  return { id, serviceId, type: "custom", run, ...overrides };
}

test("HTTP probe checks an allowlisted origin and submits only bounded GET/HEAD options", async () => {
  const { monitor, calls } = makeMonitor();
  let request;
  const adapter = createHealthMonitorProbeAdapter({
    monitor,
    allowedHttpOrigins: ["https://health.example.test"],
    probes: [{
      id: "catalog-http",
      serviceId: "catalog",
      type: "http",
      url: "https://health.example.test/ready",
      expectedStatus: [200, 204]
    }],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(null, { status: 204 });
    },
    clock: () => 1_800_000_000_000
  });

  const result = await adapter.probeService({ serviceId: "catalog" });
  assert.equal(result.healthy, true);
  assert.equal(result.probes[0].outcome, "healthy");
  assert.equal(result.probes[0].statusCode, 204);
  assert.equal(request.url, "https://health.example.test/ready");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.redirect, "manual");
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(calls, [{ serviceId: "catalog", healthy: true, securityThreatActive: false }]);
  assert.deepEqual(adapter.listServiceIds(), ["catalog"]);
});

test("HTTP redirects are never followed and make the probe unhealthy", async () => {
  const { monitor } = makeMonitor();
  let redirectMode;
  const adapter = createHealthMonitorProbeAdapter({
    monitor,
    allowedHttpOrigins: ["https://health.example.test"],
    probes: [{
      id: "catalog-http",
      serviceId: "catalog",
      type: "http",
      url: "https://health.example.test/ready"
    }],
    fetchImpl: async (_url, options) => {
      redirectMode = options.redirect;
      return new Response(null, { status: 302, headers: { location: "https://other.example.test/" } });
    }
  });
  const result = await adapter.probeService({ serviceId: "catalog" });
  assert.equal(redirectMode, "manual");
  assert.equal(result.healthy, false);
  assert.equal(result.probes[0].reason, "redirect-disallowed");
  assert.equal(result.probes[0].statusCode, 302);
});

test("HTTP unexpected status fails and response body is not consumed", async () => {
  const { monitor } = makeMonitor();
  let bodyCancelled = false;
  const adapter = createHealthMonitorProbeAdapter({
    monitor,
    allowedHttpOrigins: ["https://health.example.test"],
    probes: [{
      id: "catalog-http",
      serviceId: "catalog",
      type: "http",
      url: "https://health.example.test/ready",
      expectedStatus: [200]
    }],
    fetchImpl: async () => ({
      status: 503,
      body: { cancel: async () => { bodyCancelled = true; } }
    })
  });
  const result = await adapter.probeService({ serviceId: "catalog" });
  assert.equal(result.healthy, false);
  assert.equal(result.probes[0].reason, "unexpected-http-status");
  assert.equal(bodyCancelled, true);
});

test("HTTP probe enforces abortable timeout", async () => {
  const { monitor } = makeMonitor();
  let signal;
  const adapter = createHealthMonitorProbeAdapter({
    monitor,
    allowedHttpOrigins: ["https://health.example.test"],
    probes: [{
      id: "catalog-http",
      serviceId: "catalog",
      type: "http",
      url: "https://health.example.test/ready",
      timeoutMs: 50
    }],
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
  });
  const result = await adapter.probeService({ serviceId: "catalog" });
  assert.equal(result.healthy, false);
  assert.equal(result.probes[0].outcome, "timed_out");
  assert.equal(result.probes[0].reason, "timeout");
  assert.equal(signal.aborted, true);
});

test("TCP probe connects only to an explicitly allowlisted target", async () => {
  const server = createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    const { monitor } = makeMonitor();
    const adapter = createHealthMonitorProbeAdapter({
      monitor,
      allowedTcpTargets: ["127.0.0.1:" + address.port],
      probes: [{
        id: "database-tcp",
        serviceId: "catalog",
        type: "tcp",
        host: "127.0.0.1",
        port: address.port
      }]
    });
    const result = await adapter.probeService({ serviceId: "catalog" });
    assert.equal(result.healthy, true);
    assert.equal(result.probes[0].outcome, "healthy");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("required failures mark a service unhealthy while optional failures remain advisory", async () => {
  const { monitor, calls } = makeMonitor();
  const adapter = createHealthMonitorProbeAdapter({
    monitor,
    probes: [
      customProbe("required-db", "catalog", async () => ({ healthy: true })),
      customProbe("optional-cache", "catalog", async () => ({ healthy: false }), { required: false })
    ]
  });
  const result = await adapter.probeService({ serviceId: "catalog" });
  assert.equal(result.healthy, true);
  assert.deepEqual(result.failedRequiredProbes, []);
  assert.equal(result.probes[1].healthy, false);
  assert.deepEqual(calls, [{ serviceId: "catalog", healthy: true, securityThreatActive: false }]);
});

test("required probe failures are passed to the existing monitor without executing recovery", async () => {
  let recoveryEvaluations = 0;
  const monitor = createHealthMonitor({
    engine: {
      evaluateRecovery() {
        recoveryEvaluations += 1;
        return { eligible: false, reason: "laboratory-only" };
      }
    },
    clock: () => 1_800_000_000_000
  });
  let executeRecoveryCalls = 0;
  const adapter = createHealthMonitorProbeAdapter({
    monitor,
    probes: [customProbe("required-db", "catalog", async () => ({ healthy: false }))]
  });
  const result = await adapter.probeService({ serviceId: "catalog" });
  assert.equal(result.healthy, false);
  assert.deepEqual(result.failedRequiredProbes, ["required-db"]);
  assert.equal(result.observation.recovery.eligible, false);
  assert.equal(recoveryEvaluations, 1);
  assert.equal(executeRecoveryCalls, 0);
});

test("security threat state is forwarded to the monitor and suppresses recovery evaluation", async () => {
  let evaluations = 0;
  const monitor = createHealthMonitor({
    engine: {
      evaluateRecovery() {
        evaluations += 1;
        return { eligible: true };
      }
    },
    clock: () => 1_800_000_000_000
  });
  const adapter = createHealthMonitorProbeAdapter({
    monitor,
    probes: [customProbe("required-db", "catalog", async () => false)]
  });
  const result = await adapter.probeService({
    serviceId: "catalog",
    securityThreatActive: true
  });
  assert.equal(result.healthy, false);
  assert.equal(result.securityThreatActive, true);
  assert.equal(result.observation.recovery.reason, "security-threat-active");
  assert.equal(evaluations, 0);
});

test("custom probe timeout aborts the host callback signal", async () => {
  const { monitor } = makeMonitor();
  let signal;
  const adapter = createHealthMonitorProbeAdapter({
    monitor,
    probes: [customProbe("required-db", "catalog", ({ signal: provided }) => {
      signal = provided;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }, { timeoutMs: 50 })]
  });
  const result = await adapter.probeService({ serviceId: "catalog" });
  assert.equal(result.probes[0].reason, "timeout");
  assert.equal(result.probes[0].outcome, "timed_out");
  assert.equal(signal.aborted, true);
});

test("probe concurrency never exceeds its configured bound", async () => {
  const { monitor } = makeMonitor();
  let active = 0;
  let peak = 0;
  const probes = Array.from({ length: 6 }, (_, index) =>
    customProbe("probe-" + index, "catalog", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return true;
    })
  );
  const adapter = createHealthMonitorProbeAdapter({
    monitor,
    probes,
    maxConcurrentProbes: 2
  });
  const result = await adapter.probeService({ serviceId: "catalog" });
  assert.equal(result.healthy, true);
  assert.equal(peak, 2);
});

test("configuration rejects unsafe origins, methods, redirects and unallowlisted TCP targets", () => {
  const { monitor } = makeMonitor();
  const base = {
    monitor,
    allowedHttpOrigins: ["https://health.example.test"]
  };
  assert.throws(() => createHealthMonitorProbeAdapter({
    ...base,
    probes: [{
      id: "bad-origin", serviceId: "catalog", type: "http",
      url: "https://evil.example.test/ready"
    }]
  }), /allowlist/);
  assert.throws(() => createHealthMonitorProbeAdapter({
    ...base,
    probes: [{
      id: "bad-method", serviceId: "catalog", type: "http",
      url: "https://health.example.test/ready", method: "POST"
    }]
  }), /GET\/HEAD/);
  assert.throws(() => createHealthMonitorProbeAdapter({
    ...base,
    probes: [{
      id: "bad-redirect", serviceId: "catalog", type: "http",
      url: "https://health.example.test/ready", followRedirects: true
    }]
  }), /unsupported fields/);
  assert.throws(() => createHealthMonitorProbeAdapter({
    monitor,
    probes: [{
      id: "bad-tcp", serviceId: "catalog", type: "tcp",
      host: "127.0.0.1", port: 5432
    }]
  }), /allowlist/);
});

test("unencrypted HTTP is restricted to explicitly allowlisted loopback origins", () => {
  const { monitor } = makeMonitor();
  assert.throws(() => createHealthMonitorProbeAdapter({
    monitor,
    allowedHttpOrigins: ["http://health.example.test"],
    probes: [{
      id: "public-http", serviceId: "catalog", type: "http",
      url: "http://health.example.test/ready"
    }]
  }), /loopback/);
  assert.throws(() => createHealthMonitorProbeAdapter({
    monitor,
    allowedHttpOrigins: ["http://127.0.0.1:8080"],
    probes: [{
      id: "local-http", serviceId: "catalog", type: "http",
      url: "http://127.0.0.1:8080/ready"
    }]
  }), /loopback/);
  const adapter = createHealthMonitorProbeAdapter({
    monitor,
    allowedHttpOrigins: ["http://127.0.0.1:8080"],
    allowInsecureHttpOrigins: ["http://127.0.0.1:8080"],
    probes: [{
      id: "local-http", serviceId: "catalog", type: "http",
      url: "http://127.0.0.1:8080/ready"
    }],
    fetchImpl: async () => new Response(null, { status: 200 })
  });
  assert.equal(typeof adapter.probeService, "function");
});

test("invalid configuration, unknown service and invalid calls fail closed", async () => {
  const { monitor } = makeMonitor();
  assert.throws(() => createHealthMonitorProbeAdapter({ monitor, probes: [] }), /1 and 64/);
  assert.throws(() => createHealthMonitorProbeAdapter({
    monitor,
    probes: [customProbe("duplicate", "catalog", async () => true), customProbe("duplicate", "catalog", async () => true)]
  }), /duplicated/);
  assert.throws(() => createHealthMonitorProbeAdapter({
    monitor,
    probes: [customProbe("optional-only", "catalog", async () => true, { required: false })]
  }), /at least one required/);
  assert.throws(() => createHealthMonitorProbeAdapter({
    monitor,
    probes: [customProbe("unknown-field", "catalog", async () => true, { runShell: "true" })]
  }), /unsupported fields/);
  assert.throws(() => createHealthMonitorProbeAdapter({
    monitor,
    probes: [customProbe("bad-timeout", "catalog", async () => true, { timeoutMs: 25 })]
  }), /50 and 10000/);
  const adapter = createHealthMonitorProbeAdapter({
    monitor,
    probes: [customProbe("required-db", "catalog", async () => true)]
  });
  await assert.rejects(adapter.probeService({ serviceId: "unknown" }), /unknown or invalid/);
  await assert.rejects(adapter.probeService({ serviceId: "catalog", securityThreatActive: "yes" }), /must be boolean/);
});

test("custom probe exceptions become bounded unhealthy results rather than escaping", async () => {
  const { monitor } = makeMonitor();
  const adapter = createHealthMonitorProbeAdapter({
    monitor,
    probes: [customProbe("required-db", "catalog", async () => {
      throw new Error("private database detail");
    })]
  });
  const result = await adapter.probeService({ serviceId: "catalog" });
  assert.equal(result.healthy, false);
  assert.equal(result.probes[0].reason, "custom-check-failed");
  assert.equal(JSON.stringify(result).includes("private database detail"), false);
});
