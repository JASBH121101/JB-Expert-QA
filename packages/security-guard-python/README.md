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

When this middleware is installed globally, GET/HEAD requests bypass the rate-limit service only when both the directory prefix and file extension are allowlisted. Defaults are `/assets/`, `/static/`, `/media/`, `/images/` and `/fonts/` plus common static extensions. A dynamic route such as `/api/catalog.js` remains rate-limited. Configure `excluded_extensions` and `excluded_prefixes` for the host application's actual static paths; an empty tuple disables that exclusion dimension. POST requests are never skipped.

## Validation boundary

The Python package includes strict rate-limit check, decision and policy normalizers plus the same length-prefixed counter-key format as Node/PHP. Its unit tests consume the same HMAC known-answer fixture. The FastAPI middleware only adapts the central endpoint response; it does not create or migrate policy, secrets, databases or counters.

## Upload quarantine orchestration

The Python package now exposes `UploadInspectionService`, `UploadInspectionError`,
`UploadQuarantineStorage` and `UploadMalwareScanner`.

The service streams a bounded source file into host-provided quarantine storage,
calculates SHA-256, checks a narrow JPEG/PNG/GIF/WebP/PDF signature allowlist,
verifies the scanner's explicit verdict, engine/version, byte count and digest,
and only then requests private atomic promotion.

Host adapters must keep quarantine and approved objects private, enforce scanner
deadlines, consume the complete stream, verify exact bytes during promotion, and
make deletion idempotent. The `promote(upload_id, expected_sha256, expected_size,
attestation)` method must atomically verify that the supplied normalized
`jb.security.upload-inspection.attestation/v1` binds the same upload ID, SHA-256,
byte count and `clean` verdict, then persist that attestation with the exact
approved object. Do not persist the attestation in a later, separate transaction. Unknown verdicts, scanner errors, integrity mismatches
and uncertain promotion outcomes never produce an approval. Malicious files,
unknown verdicts and uncertain objects remain quarantined for forensic review. The
request path never serves a quarantined original; disposal requires a separate,
authorized retention/disposition process after the required evidence is preserved.

The validated attestation is also returned in the approved result for application-level audit linkage. It is schema-validated scanner evidence, not a cryptographic scanner signature; production trust remains dependent on an authenticated scanner adapter and the atomic storage implementation.

No antivirus engine or production storage implementation is bundled. Signature
identification is not full format validation or image sanitization. The host
application must decode and re-encode images before publication, authorize every
download, set explicit content types and `X-Content-Type-Options: nosniff`, and
serve PDFs as attachments by default. Never write untrusted uploads directly to
a public web root or public object-store bucket.

Run the Python upload and middleware tests with:

```bash
PYTHONPATH=packages/security-guard-python/src python3 -m unittest discover -s packages/security-guard-python/tests -v
```
