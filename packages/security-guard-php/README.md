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


## Private image upload inspection (Laravel/PHP)

The PHP adapter also provides a fail-closed image upload inspection pipeline:

- `UploadInspector` validates server-detected MIME type, extension, image signature/dimensions, actual byte size, and SHA-256.
- `LocalPrivateUploadStore` writes to a server-owned private quarantine directory and atomically promotes only the exact scanned object to a private approved directory.
- `ClamAvScanner` uses the locally installed `clamscan` executable without invoking a shell. Scanner errors, missing ClamAV, unavailable versions, timeouts, or unknown verdicts leave the file quarantined; only an explicit clean verdict is eligible for promotion.
- The Laravel service provider binds these services automatically. Configure `JB_SECURITY_GUARD_UPLOAD_STORAGE_ROOT`, `JB_SECURITY_GUARD_CLAMAV_BINARY`, and `JB_SECURITY_GUARD_UPLOAD_SCAN_TIMEOUT_MS`. The default storage root is `storage/app/private/jb-security-guard` and the adapter rejects a root inside `public_path()`.

Inject `JB\\SecurityGuard\\UploadInspection\\UploadInspector` into the controller and pass the temporary uploaded-file path, original filename, and client MIME hint to `inspect()`. A result with `status=quarantined` is not approved and must not be linked to a product. A result with `status=approved` returns a private relative storage path, not a public URL. The host application must authorize any image-serving route and must not expose the approved directory as a static web directory.

This PHP image pipeline currently allows JPEG, PNG, and WebP only. It is a PHP/Laravel upload adapter, not full feature parity with the Node Security Guard runtime. Image decode/re-encode (content disarm), a production retention scheduler, and explicit HTTP delivery authorization remain host-application responsibilities. ClamAV is an optional free local dependency; when it is not installed the pipeline deliberately refuses to approve uploads.
