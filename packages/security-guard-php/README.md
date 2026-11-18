# JB Security Guard PHP adapter

Standalone PHP 8.2+ client for the JB Security Guard Core v1 identity contract and authenticated universal rate-limit endpoint. The package has no mandatory external dependency; Laravel integration is optional and uses the host application's Laravel components.

## Core v1 HMAC conformance

`CoreV1::deriveIdentityKey()` implements the same UTF-8, domain-separated HMAC-SHA-256 message as the Node and Python adapters. Pass a stable identity resolved by trusted server code, not a browser-supplied identity.

```php
use JB\SecurityGuard\CoreV1;

$key = CoreV1::deriveIdentityKey(
    $identitySecret,
    'k2026-01',
    'tenant-demo',
    'catalog-api',
    'account',
    'user-123'
);
```

## Laravel setup

Install this package through Composer, register `JB\SecurityGuard\Laravel\SecurityGuardServiceProvider` when package auto-discovery is not enabled, then publish `jb-security-guard-config`. Configure:

- `JB_SECURITY_GUARD_ENDPOINT`: absolute HTTPS endpoint of the Node service.
- `JB_SECURITY_GUARD_CLIENT_ID` and `JB_SECURITY_GUARD_CLIENT_SECRET`: server-only client credentials.
- `JB_SECURITY_GUARD_FAILURE_MODE`: `closed` by default; set `open` only after a documented risk decision.
- `identity_resolver`: replace the default trusted user-ID/IP resolver with the application's server-owned identity strategy.

Use route middleware with explicit, server-registered policy and scope names:

```php
Route::get('/catalog', CatalogController::class)
    ->middleware('jb.security.rate-limit:public,catalog-read');
```

Register the middleware alias `jb.security.rate-limit` to `JB\SecurityGuard\Laravel\RateLimitMiddleware::class` in the Laravel application's middleware configuration. The alias is intentionally host-registered; the package does not mutate application routes.

The client does not retry requests, because retries can consume extra quota. Authentication failures always fail closed, even when transport outage mode is explicitly configured as fail-open. Raw endpoint errors and credentials are never included in returned decisions.

## Validation boundary

The PHP package validates Core v1 rate-limit check, decision and policy objects and constructs the same length-prefixed counter key as Node. It calls the central server for quota decisions rather than implementing a second, divergent rate-limit store.


## PHP upload quarantine contract

The PHP package also provides a runtime-native upload inspection orchestrator:

- `UploadInspectionService`
- `UploadQuarantineStorage`
- `UploadMalwareScanner`

The service accepts a server-side temporary file path (for example, Laravel's `UploadedFile::getRealPath()`), streams it into a quarantine adapter under an opaque server-generated ID, enforces a byte limit, checks a narrow file-signature allowlist, and calculates SHA-256. It then asks the scanner to consume the quarantined object and requires a structurally valid `clean`, `malicious` or `unknown` verdict whose reported digest and byte count match the ingested object; only `clean` is eligible for promotion. After the complete scan is verified, it creates the shared upload-inspection attestation v1 and calls the storage adapter's atomic promotion method with the expected digest, size and attestation.

The storage adapter contract is security-critical:

- `createQuarantineStream($uploadId)` must write only to private quarantine storage.
- `openQuarantineStream($uploadId)` must return the complete quarantined object.
- `promote($uploadId, $expectedSha256, $expectedSize, $attestation)` must atomically verify the exact bytes and that the attestation binds the same upload ID, SHA-256, byte count and `clean` verdict, then persist both the attestation and exact object in a **private approved namespace**. Do not commit the object and attestation in separate transactions; do not publish a public URL.
- `delete($uploadId)` must be idempotent and operate only on the opaque server-generated ID.

The scanner must consume the entire stream sequentially, enforce its own execution deadline, and return `verdict`, `sha256`, `size`, `engine` and `version`. The service emits the normalized `jb.security.upload-inspection.attestation/v1` only after exact content digest/size and complete-stream validation. A clean attestation is returned on success; a valid malicious/unknown attestation is available as `UploadInspectionException::$attestation` for audit linkage only. No attestation is exposed for incomplete streams or digest/size mismatches. This is schema-validated scanner evidence, not a cryptographic signature or publication authorization. The service also verifies that the scan stream's read position reached the exact ingested byte count; a clean result returned without consuming the complete stream is rejected as `SCAN_INCOMPLETE` and retained in private quarantine. The service binds `uploadId`, `size`, `sha256` and `detectedMimeType` into the scanner metadata. The language-neutral mapping is documented in `packages/security-guard-core/docs/UPLOAD-INSPECTION-CONTRACT-V1.md`, with schemas and shared conformance vectors under `packages/security-guard-core/contracts/upload-inspection/v1/` and `packages/security-guard-core/tests/fixtures/upload-inspection/`. The service has no bundled antivirus engine or production storage implementation. An unknown verdict, scanner outage, incomplete stream, invalid result or digest mismatch never approves an object; uncertain objects remain in quarantine. A malicious verdict is rejected and the staging object is deleted. Forensic retention, when required, must be performed by a separate bounded and access-controlled recorder.

The built-in signature allowlist is JPEG, PNG, GIF, WebP and PDF. Signature identification is not full format validation, image sanitization, or proof that a file is safe. The host application must decode and re-encode uploaded images with a maintained image library before publication, serve approved files through authorization-aware routes, set explicit content types and `X-Content-Type-Options: nosniff`, and use safe content disposition. PDFs should be attachments by default. Do not use Laravel's `public` disk for incoming or quarantined uploads.

Example wiring (the adapters are supplied by the host application):

```php
$inspector = new UploadInspectionService(
    $privateQuarantineStorage,
    $versionedMalwareScanner,
    maxBytes: 5 * 1024 * 1024,
);

$result = $inspector->inspect(
    $uploadedFile->getRealPath(),
    $uploadedFile->getClientOriginalName(),
    $uploadedFile->getClientMimeType(),
);

// Persist result.uploadId and result.sha256 against the authenticated actor.
// Publish/serve the object only after the application's own authorization
// and image-processing steps have completed.
```

The PHP test suite exercises clean promotion, extension mismatch, oversized streams, unknown and malicious verdicts, digest mismatch, and scanner unavailability using test-only adapters. These tests verify the orchestration contract, not a production antivirus or storage provider.
