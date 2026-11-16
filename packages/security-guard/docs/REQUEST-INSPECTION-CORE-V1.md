# Request inspection Core v1 bridge (Node.js)

The main `createSecurityGuard()` middleware can publish normalized Core v1 threat signals and local rate-limit decisions through an opt-in `coreContract`. The bridge is observational: it does not replace request inspection, change the configured monitor/enforce mode, or create a threat assessment.

## Configuration

```js
const guard = createSecurityGuard({
  mode: "balanced",
  rateLimit: { enabled: true, max: 120, windowMs: 60_000 },
  coreContract: {
    tenantId: "tenant-01",
    applicationId: "catalog-api",
    policyId: "catalog-request-local",
    scope: "request",
    identityType: "ip",
    identityKeyId: "request-client-hmac-2026-01",
    identitySecret: process.env.JB_REQUEST_INSPECTION_HMAC_SECRET
  },
  onCoreSignal(signal) {
    // Validated jb.security.threat-signal/v1 evidence.
  },
  onCoreDecision: ({ check, decision }) => {
    // Local limiter check and normalized rate-limit decision.
  },
  onCoreEvent(event) {
    // Sanitized jb.security.event/v1 incident event for an exceeded local quota.
  }
});
```

The contract requires tenant/application identifiers, an identity key ID, and a stable secret with at least 32 bytes. `identityType` defaults to `ip`; change it when the configured `keyGenerator` returns a different trusted identity class. Never derive identities from untrusted browser-supplied headers. The key ID must match the secret version managed by the host application.

## Threat signals

When the existing request inspector detects findings, the bridge emits `jb.security.threat-signal/v1` records through `onCoreSignal`. The signal carries the finding rule ID, existing severity, a normalized threat type, evidence count, detection timestamp, and (when a client identity is available) a tenant/application-scoped HMAC subject key.

- SQL injection signatures map to `sql_injection`.
- Local request-limit findings map to `api_abuse`.
- Other request-target, XSS, path, and HTTP framing findings map to `anomaly`; Core v1 has no dedicated path-traversal or XSS threat type.
- Signals are emitted alongside the existing incident event. Repeated local-rate-limit-only findings are still deduplicated using the middleware's existing per-window incident suppression.

The current rule confidence values are explicitly heuristic weights, not statistically calibrated probabilities: SQLi/XSS signatures use 0.65, path traversal signatures use 0.70, request-target structural checks use 0.95, and HTTP structural checks/local rate-limit findings use 0.98. These values must not be interpreted as measured precision or recall. A future calibrated detector can replace them only with a separately validated scoring model.

No raw request URL, query string, header, body, IP address, session identifier, filename, or credential is copied into the Core signal. The raw client identity is used only as HMAC input. No route template is emitted because this middleware has no trusted route-template resolver.

## Local rate-limit Core output

When the built-in local limiter is enabled and Core mode is configured, every request produces a validated `rate-limit.check/v1` and `rate-limit.decision/v1` pair through `onCoreDecision`.

- Below quota: `allowed=true`, `exceeded=false`, `status=null`.
- Exceeded in monitor mode, or when the severity policy does not enforce high findings: `allowed=true`, `exceeded=true`, `enforced=false`, `status=null`.
- Exceeded in an enforcing mode: `allowed=false`, `exceeded=true`, `enforced=true`, `status=429`.

An exceeded local quota also emits one sanitized `category=rate_limit` Core event per incident window through `onCoreEvent`. The Core Retry-After value is capped at 60 seconds by the v1 wire contract. It is telemetry for the local limiter and does not change the middleware's current response headers or timing.

**This is a process-local in-memory limiter, not a globally consistent distributed counter.** Each Node process maintains its own buckets. Use the existing distributed-rate-limit adapter with a real atomic shared store when cross-instance quota consistency is required.

## What the bridge deliberately does not do

- It does not turn a threat signal into a block decision. Existing `mode` and `blockSeverities` remain authoritative.
- It does not generate `threat-assessment/v1`: no calibrated multi-signal aggregator or server-owned threat policy is implemented in this middleware yet.
- It does not create an event sink, change production configuration, deploy middleware, or provision shared storage.
- It does not change existing `onEvent` payloads or the behavior when `coreContract` is omitted.

Use `onCoreSignal` as evidence input for a separately governed assessment pipeline. Do not automatically block an actor based on one heuristic signal.
