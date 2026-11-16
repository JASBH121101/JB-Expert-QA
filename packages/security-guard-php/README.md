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
