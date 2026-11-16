# Protection-module security events — Core v1 (Node.js)

The CSRF, origin, and upload protection modules can emit the language-neutral `jb.security.event/v1` contract through an opt-in `coreContract` and `onCoreEvent` callback. This bridge is additive: legacy `onEvent` callbacks and enforcement behavior remain in place when Core mode is disabled.

## CSRF protection

CSRF Core telemetry emits only when an unsafe request is rejected. Since the module already resolves the session identifier to validate a synchronizer token, it can derive a tenant/application-scoped HMAC subject key using the same stable secret. Configure a key ID to make rotation traceable:

```js
const csrf = guard.createCsrfProtection({
  secret: process.env.JB_CSRF_SECRET,
  sessionKeyGenerator: (request) => request.session.id,
  coreContract: {
    tenantId: "tenant-01",
    applicationId: "browser-api",
    subjectKeyId: "csrf-session-hmac-2026-01"
  },
  onCoreEvent(event) {
    // Validated, sanitized jb.security.event/v1.
  }
});
```

The event uses category `csrf`, rule `JBG-CSRF-TOKEN-001`, action `blocked`, outcome `denied`, and scope `csrf_token`. The session identifier and supplied token are never copied into the event. If the session resolver cannot provide a value, the event remains valid but omits the subject key. A key ID is required whenever the CSRF Core bridge is configured.

## Origin protection

Origin Core telemetry emits only for rejected unsafe requests:

```js
const origin = guard.createOriginProtection({
  allowedOrigins: ["https://app.example.com"],
  coreContract: {
    tenantId: "tenant-01",
    applicationId: "browser-api"
  },
  onCoreEvent(event) {}
});
```

The event uses category `origin`, rule `JBG-CSRF-ORIGIN-001`, action `blocked`, outcome `denied`, and scope `origin_check`. Raw `Origin` and `Referer` header values are deliberately not included. The current module does not resolve a trusted subject identity, so its event has no subject key.

## Upload inspection

Upload Core telemetry reports terminal inspection outcomes and quarantine cleanup failures:

```js
const inspector = guard.createUploadInspector({
  store,
  scanner,
  coreContract: {
    tenantId: "tenant-01",
    applicationId: "catalog-api"
  },
  onCoreEvent(event) {}
});
```

- An upload is reported as `promoted/success` only after the store confirms promotion of the exact scanned object.
- Unknown or otherwise non-clean verdicts that remain in quarantine are reported as `quarantined/observed`; they are not reported as approved.
- Rejections are reported as `rejected/denied`. A malware verdict uses critical severity and rule `JBG-MALWARE-001`.
- Quarantine deletion failures are reported as `rejected/error` with rule `JBG-UPLOAD-CLEANUP-001`.

Upload events use category `upload`. They do not include file names, declared MIME values, content hashes, scanner output, file content, or provider details. The internally generated upload UUID is used only as the event correlation ID.

## Callback and deployment boundaries

- `onCoreEvent` is optional and must be a function when supplied.
- Synchronous callback errors and asynchronous callback rejections are swallowed; telemetry cannot change CSRF/origin enforcement or upload disposition.
- Without `coreContract`, Core events are inactive and legacy module behavior is preserved.
- The Core event is an audit/telemetry record, not an authorization decision.
- Tenant and application identifiers must be assigned by trusted server configuration. Do not accept them from browser input.
- This integration does not deploy middleware, configure a production event sink, create credentials, or provision shared storage.
