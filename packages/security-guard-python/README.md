# JB Security Guard Python adapter

Python 3.11+ Core v1 identity helpers and an async client for the authenticated Node.js universal rate-limit endpoint. The package does not add a second independently maintained rate-limit store: all runtimes share the central service policy and atomic store.

## Core v1 HMAC conformance

`derive_identity_key()` implements the same UTF-8 domain-separated HMAC-SHA-256 message used by Node and PHP.

```python
from jb_security_guard import derive_identity_key

digest = derive_identity_key(
    secret=identity_secret_bytes,
    key_id="k2026-01",
    tenant_id="tenant-demo",
    application_id="catalog-api",
    identity_type="account",
    canonical_identity="user-123",  # Resolve only in trusted server-side code.
)
```

## FastAPI integration

The adapter is ASGI middleware and does not require FastAPI at import time:

```python
from fastapi import FastAPI, Request
from jb_security_guard import UniversalRateLimitClient
from jb_security_guard.fastapi import SecurityGuardRateLimitMiddleware

app = FastAPI()
guard_client = UniversalRateLimitClient(
    endpoint="https://guard.example/__jb/security-guard/v1/check",
    client_id="catalog-api",
    client_secret=settings.JB_SECURITY_GUARD_CLIENT_SECRET,
    failure_mode="closed",
)

def trusted_identity(scope):
    # Implement this with authenticated server-side state.
    # Never use request body, query parameters, cookies, or untrusted
    # X-Forwarded-For values as the identity source.
    user = scope.get("user")
    user_id = getattr(user, "id", None)
    if user_id is not None:
        return str(user_id)
    client = scope.get("client")
    if client and client.host:
        return client.host
    raise RuntimeError("Trusted identity unavailable")

app.add_middleware(
    SecurityGuardRateLimitMiddleware,
    client=guard_client,
    identity_resolver=trusted_identity,
    policy="public",
    scope="catalog-read",
)
```

The client is asynchronous, uses HTTPS with certificate verification and does not follow redirects or retry requests. Keep credentials on the application server. Use `failure_mode="closed"` unless a documented risk decision explicitly approves fail-open.

## Validation boundary

The Python package includes strict rate-limit check, decision and policy normalizers plus the same length-prefixed counter-key format as Node/PHP. Its unit tests consume the same HMAC known-answer fixture. The FastAPI middleware only adapts the central endpoint response; it does not create or migrate policy, secrets, databases or counters.
