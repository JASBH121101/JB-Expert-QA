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
and binds the scanner handoff to the opaque upload ID, exact byte count, SHA-256
and detected MIME type. A read-only digest-tracking stream independently hashes
and counts the bytes actually delivered to the scanner; a clean result returned
without complete sequential consumption fails closed as SCAN_INCOMPLETE.

Host adapters must keep quarantine and approved objects private, enforce scanner
deadlines, verify exact bytes during atomic promotion, and make deletion idempotent. The `promote(upload_id, expected_sha256, expected_size, attestation)` method must also verify that the shared `jb.security.upload-inspection.attestation/v1` binds the same upload ID, digest, byte count and `clean` verdict, then persist the attestation and approved bytes together in the same atomic commit. Do not persist the attestation after a separate object-promotion transaction.
Unknown verdicts, incomplete scans, scanner errors, integrity mismatches and
uncertain promotion outcomes never produce an approval. A malicious verdict is
rejected and the staging object is deleted; any required forensic retention must
use a separate bounded and access-controlled recorder. A successful clean result
includes the validated attestation for audit linkage; that attestation is normalized
scanner evidence, not a cryptographic scanner signature or publication authorization. Unknown and uncertain
objects remain private in quarantine. The request path never serves a quarantined
original.

The normalized request/result contract and shared cross-runtime vectors are
documented in packages/security-guard-core/docs/UPLOAD-INSPECTION-CONTRACT-V1.md
and packages/security-guard-core/tests/fixtures/upload-inspection/.

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
