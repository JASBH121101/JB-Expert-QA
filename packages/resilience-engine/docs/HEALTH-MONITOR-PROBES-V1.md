# JB Resilience Health Monitor Probe Adapter v1

**Status:** laboratory implementation pending certification  
**Package:** \`@jb/resilience-engine/adapters/health-monitor-probes\`

## Purpose and boundary

The adapter turns host-configured read-only checks into bounded observations for the existing \`createHealthMonitor()\` state machine. It fills the gap between a host's infrastructure/dependency checks and the monitor's existing boolean observation API.

It does not decide whether an action is authorized, call \`executeRecovery()\`, restart services, change firewall state, write to databases, or mutate monitored applications. A negative check may cause the existing monitor to return a recovery proposal; proposals remain subject to the current policy and execution controls.

## Probe types

- **HTTP:** allowlisted HTTP(S) URL origin, GET or HEAD only, manual redirect mode, and explicitly configured successful status codes. Response bodies are not read.
- **TCP:** outbound connection check to an exact allowlisted \`host:port\` target. No application payload is sent.
- **Custom:** host-owned read-only callback with a bounded timeout and an AbortSignal. The callback receives only the service ID, probe ID, observation timestamp and signal. The host callback must honor cancellation to stop its own work after timeout.

Each service must have at least one required probe. A failed required probe marks the service unhealthy. Failed optional probes are returned as advisory results but do not make the aggregate service status unhealthy.

## Network safety

- HTTP origins are exact allowlist entries; URLs outside them are rejected at construction.
- HTTP credentials and fragments are prohibited.
- Only GET and HEAD are accepted. Redirects are configured as \`manual\` and any 3xx response is treated as unhealthy.
- Cleartext HTTP is rejected except for explicit loopback-only origins (\`localhost\`, \`127.0.0.1\`, \`::1\`) that appear in both allowlists.
- TCP targets must appear in an exact hostname/port allowlist.
- No arbitrary headers, request body, DNS discovery, URL supplied at probe time, shell command, dynamic module path, or automatic retry is supported.

The host is responsible for controlling DNS resolution and egress policy for allowlisted hosts. An allowlist is configuration control, not a substitute for network segmentation or an egress firewall.

## Resource limits

- Up to 64 probes total.
- Up to 16 probes per service.
- Up to 16 concurrent probes globally across simultaneous service checks.
- Per-probe timeout from 50 ms to 10 seconds; default 3 seconds.
- HTTP expected status list has at most 16 distinct 2xx codes.
- The HTTP implementation does not consume response bodies.
- Probe failures return bounded reason codes; raw exception text and response content are not included in results.

## Example

\`\`\`js
import { createHealthMonitor } from "@jb/resilience-engine";
import {
  createHealthMonitorProbeAdapter
} from "@jb/resilience-engine/adapters/health-monitor-probes";

const monitor = createHealthMonitor({
  engine: resilienceEngine,
  clock: Date.now
});

const probes = createHealthMonitorProbeAdapter({
  monitor,
  allowedHttpOrigins: ["https://catalog.internal.example"],
  allowedTcpTargets: ["postgres.internal.example:5432"],
  probes: [
    {
      id: "catalog-readiness",
      serviceId: "catalog-api",
      type: "http",
      url: "https://catalog.internal.example/ready",
      method: "GET",
      expectedStatus: [200]
    },
    {
      id: "catalog-database-port",
      serviceId: "catalog-api",
      type: "tcp",
      host: "postgres.internal.example",
      port: 5432
    }
  ]
});

const observation = await probes.probeService({
  serviceId: "catalog-api",
  securityThreatActive: false
});
\`\`\`

The host owns scheduling and supplies the current security threat state. This adapter does not create background timers or poll automatically. Call \`probeService()\` when the host's scheduler requests an observation.

## Failure behaviour

Timeouts, network errors, non-2xx status, redirects and custom callback failures produce unhealthy probe results. They do not throw raw transport details to the caller. Configuration errors and unknown service IDs are rejected. The adapter never converts a failed or unavailable probe into a healthy result.

When multiple service checks run concurrently, a shared semaphore limits total active probes across all calls. The per-service worker loop preserves result ordering.

## Explicit limitations

This v1 does not include:

- database-specific SQL health checks or credential management;
- authentication headers, client certificates or secret retrieval;
- distributed scheduling, adaptive polling or jitter;
- persistent health-observation storage;
- automatic remediation or operating-system actions;
- telemetry export or alert delivery;
- production deployment or service installation.

Database readiness may be represented by an explicitly allowlisted TCP check or a host-owned custom read-only callback. A successful TCP connection proves only that the port accepted a connection; it does not prove application-level or SQL query health.

## Laboratory certification

Unit tests use fake HTTP responses, custom callbacks and a loopback-only temporary TCP listener. They verify allowlist enforcement, timeout/cancellation, redirect rejection, required/optional aggregation, security-threat propagation, bounded global concurrency and failure sanitization. No external endpoint or production service is contacted.
