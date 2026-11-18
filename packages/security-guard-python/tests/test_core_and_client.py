from __future__ import annotations

import asyncio
import json
import pathlib
import unittest

from jb_security_guard import (
    UniversalRateLimitClient,
    create_rate_limit_counter_key,
    derive_identity_key,
    normalize_rate_limit_check,
    normalize_rate_limit_decision,
    normalize_rate_limit_policy,
    validate_upload_inspection_attestation_v1,
)
from jb_security_guard.fastapi import SecurityGuardRateLimitMiddleware


ROOT = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads(
    (ROOT / "packages/security-guard-core/tests/fixtures/identity-key-derivation.v1.json")
    .read_text(encoding="utf-8")
)
REQUEST_ID = "b37a5d9e-40c4-4d3b-bf9c-62d79ecf9f3a"
DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"


class CoreV1Tests(unittest.TestCase):
    def test_hmac_matches_shared_node_known_answer_vector(self):
        actual = derive_identity_key(
            secret=bytes.fromhex(FIXTURE["secretHex"]),
            key_id=FIXTURE["keyId"],
            tenant_id=FIXTURE["tenantId"],
            application_id=FIXTURE["applicationId"],
            identity_type=FIXTURE["identityType"],
            canonical_identity=FIXTURE["canonicalIdentity"],
        )
        self.assertEqual(actual, FIXTURE["expectedKey"])

    def test_hmac_is_domain_separated_and_validates_identity(self):
        params = {
            "secret": bytes(range(32)), "key_id": "k2026-01",
            "tenant_id": "tenant-demo", "application_id": "catalog-api",
            "identity_type": "account", "canonical_identity": "user-123",
        }
        expected = derive_identity_key(**params)
        self.assertNotEqual(expected, derive_identity_key(**{**params, "tenant_id": "tenant-other"}))
        self.assertNotEqual(expected, derive_identity_key(**{**params, "application_id": "admin-api"}))
        self.assertNotEqual(expected, derive_identity_key(**{**params, "identity_type": "session"}))
        with self.assertRaises(ValueError):
            derive_identity_key(**{**params, "secret": b"x" * 31})
        with self.assertRaises(ValueError):
            derive_identity_key(**{**params, "canonical_identity": "user\x00123"})

    def test_check_and_decision_normalizers_preserve_fail_open(self):
        request = normalize_rate_limit_check({
            "schema": "jb.security.rate-limit.check/v1",
            "requestId": REQUEST_ID,
            "tenantId": "tenant-demo",
            "applicationId": "catalog-api",
            "policyId": "public-api",
            "scope": "catalog:list",
            "identity": {"type": "anonymous", "key": DIGEST, "keyId": "k2026-01"},
        })
        self.assertEqual(request["identity"]["type"], "anonymous")
        fail_open = normalize_rate_limit_decision({
            "schema": "jb.security.rate-limit.decision/v1",
            "requestId": REQUEST_ID,
            "tenantId": "tenant-demo",
            "applicationId": "catalog-api",
            "policyId": "public-api",
            "scope": "catalog:list",
            "allowed": True, "exceeded": False, "enforced": False,
            "unavailable": True, "status": None, "retryAfterSeconds": None,
        })
        self.assertTrue(fail_open["allowed"])
        self.assertTrue(fail_open["unavailable"])
        with self.assertRaises(ValueError):
            normalize_rate_limit_decision({**fail_open, "enforced": True})

    def test_policy_and_counter_keys_are_strict(self):
        policy = normalize_rate_limit_policy({
            "schema": "jb.security.policy.rate-limit/v1",
            "id": "public", "tenantId": "tenant-demo", "applicationId": "catalog-api",
            "version": 1, "enabled": True, "mode": "enforce", "failureMode": "closed",
            "limits": [
                {"id": "login-ip", "identityType": "ip", "scope": "login", "windowSeconds": 60, "maxRequests": 10}
            ],
        })
        self.assertEqual(len(policy["limits"]), 1)
        key = create_rate_limit_counter_key({
            "tenantId": "tenant-demo", "applicationId": "catalog-api",
            "policyId": "public-api", "scope": "catalog:list",
            "identityType": "account", "keyId": "k2026-01", "identityKey": DIGEST,
        })
        expected = (
            "15:jbsg-counter-v1" + "11:tenant-demo" + "11:catalog-api"
            + "10:public-api" + "12:catalog:list" + "7:account" + "8:k2026-01" + "64:" + DIGEST
        )
        self.assertEqual(key, expected)
        with self.assertRaises(TypeError):
            normalize_rate_limit_check({"schema": "bad"})
        with self.assertRaises(ValueError):
            normalize_rate_limit_policy({
                "schema": "jb.security.policy.rate-limit/v1",
                "id": "public", "tenantId": "tenant-demo", "applicationId": "catalog-api",
                "version": 1, "enabled": True, "mode": "enforce", "failureMode": "closed",
                "limits": [
                    {"id": "same", "identityType": "ip", "scope": "login", "windowSeconds": 60, "maxRequests": 10},
                    {"id": "same", "identityType": "ip", "scope": "other", "windowSeconds": 60, "maxRequests": 10},
                ],
            })


    def test_upload_attestation_matches_shared_cross_runtime_vectors(self):
        fixture_root = ROOT / "packages/security-guard-core/tests/fixtures/upload-inspection"
        for fixture_name in (
            "attestation-clean.valid.json",
            "attestation-malicious.valid.json",
            "attestation-unknown.valid.json",
        ):
            with self.subTest(fixture=fixture_name):
                fixture = json.loads((fixture_root / fixture_name).read_text(encoding="utf-8"))
                normalized = validate_upload_inspection_attestation_v1(fixture)
                self.assertEqual(normalized["verdict"], fixture["verdict"])

        clean = json.loads(
            (fixture_root / "attestation-clean.valid.json").read_text(encoding="utf-8")
        )
        for mutation in (
            {"sha256": "A" * 64},
            {"size": 0},
            {"size": 104857601},
            {"mimeType": "application/x-msdownload"},
            {"verdict": "no_match"},
            {"extra": "must-be-rejected"},
            {"uploadId": "D47A5D9E40C44D3BBF9C62D79ECF9F3A"},
        ):
            with self.subTest(mutation=mutation):
                with self.assertRaises((TypeError, ValueError)):
                    validate_upload_inspection_attestation_v1({**clean, **mutation})


class UniversalClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_client_maps_allow_and_uses_server_only_credentials(self):
        captured = {}

        async def transport(url, headers, body, timeout):
            captured.update(url=url, headers=headers, body=body, timeout=timeout)
            return {"status": 200, "headers": {}, "body": json.dumps({
                "allowed": True, "policy": "public", "scope": "catalog-read"
            })}

        client = UniversalRateLimitClient(
            "https://guard.example/check", "catalog-api",
            "python-client-secret-at-least-32-bytes", transport=transport,
        )
        result = await client.check("user-123", "catalog-read", "public")
        self.assertTrue(result["allowed"])
        self.assertTrue(captured["headers"]["Authorization"].startswith("Bearer "))
        self.assertNotIn("python-client-secret", captured["body"].decode("utf-8"))

        boundary = await client.check("€" * 512, "catalog-read", "public")
        self.assertTrue(boundary["allowed"])
        with self.assertRaises(ValueError):
            await client.check("€" * 513, "catalog-read", "public")

    async def test_client_rejects_url_userinfo_query_and_fragment(self):
        for endpoint in (
            "https://user:password@guard.example/check",
            "https://guard.example/check?token=secret",
            "https://guard.example/check#fragment",
        ):
            with self.subTest(endpoint=endpoint):
                with self.assertRaises(ValueError):
                    UniversalRateLimitClient(
                        endpoint, "catalog-api", "python-client-secret-at-least-32-bytes"
                    )

    async def test_client_rejects_oversized_transport_response(self):
        async def oversized(*args):
            return {"status": 200, "headers": {}, "body": "x" * 16385}

        client = UniversalRateLimitClient(
            "https://guard.example/check", "catalog-api",
            "python-client-secret-at-least-32-bytes", failure_mode="open", transport=oversized,
        )
        result = await client.check("user-123", "catalog-read", "public")
        self.assertFalse(result["allowed"])
        self.assertTrue(result["enforced"])

    async def test_client_maps_429_and_fail_open_or_closed_outages(self):
        async def limited(*args):
            return {"status": 429, "headers": {"retry-after": "17"}, "body": "{}"}

        limited_client = UniversalRateLimitClient(
            "https://guard.example/check", "catalog-api",
            "python-client-secret-at-least-32-bytes", transport=limited,
        )
        limited = await limited_client.check("user-123", "catalog-read", "public")
        self.assertEqual(limited["status"], 429)
        self.assertEqual(limited["retryAfterSeconds"], 17)

        async def unavailable(*args):
            raise RuntimeError("private backend detail")

        closed_client = UniversalRateLimitClient(
            "https://guard.example/check", "catalog-api",
            "python-client-secret-at-least-32-bytes", transport=unavailable,
        )
        closed = await closed_client.check("user-123", "catalog-read", "public")
        self.assertFalse(closed["allowed"])
        self.assertEqual(closed["status"], 503)

        open_client = UniversalRateLimitClient(
            "https://guard.example/check", "catalog-api",
            "python-client-secret-at-least-32-bytes", failure_mode="open", transport=unavailable,
        )
        opened = await open_client.check("user-123", "catalog-read", "public")
        self.assertTrue(opened["allowed"])
        self.assertFalse(opened["enforced"])
        self.assertTrue(opened["unavailable"])

    async def test_authentication_failure_never_fails_open(self):
        async def unauthorized(*args):
            return {"status": 401, "headers": {}, "body": '{"error":"unauthorized"}'}

        client = UniversalRateLimitClient(
            "https://guard.example/check", "catalog-api",
            "python-client-secret-at-least-32-bytes", failure_mode="open", transport=unauthorized,
        )
        result = await client.check("user-123", "catalog-read", "public")
        self.assertFalse(result["allowed"])
        self.assertTrue(result["enforced"])

    async def test_asgi_middleware_blocks_and_passes_allowed_requests(self):
        calls = []
        async def transport(url, headers, body, timeout):
            payload = json.loads(body.decode("utf-8"))
            return {
                "status": 429 if payload["identity"] == "blocked-user" else 200,
                "headers": {"retry-after": "9"},
                "body": json.dumps({
                    "allowed": payload["identity"] != "blocked-user",
                    "policy": payload["policy"],
                    "scope": payload["scope"],
                }),
            }

        client = UniversalRateLimitClient(
            "https://guard.example/check", "catalog-api",
            "python-client-secret-at-least-32-bytes", transport=transport,
        )

        async def app(scope, receive, send):
            calls.append("app")
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok", "more_body": False})

        middleware = SecurityGuardRateLimitMiddleware(
            app, client=client, identity_resolver=lambda scope: scope["user_id"],
            policy="public", scope="catalog-read",
        )

        async def invoke(identity):
            messages = []
            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}
            async def send(message):
                messages.append(message)
            await middleware(
                {"type": "http", "method": "GET", "path": "/catalog", "user_id": identity},
                receive, send,
            )
            return messages

        allowed = await invoke("allowed-user")
        blocked = await invoke("blocked-user")
        self.assertEqual(allowed[0]["status"], 200)
        self.assertEqual(blocked[0]["status"], 429)
        self.assertIn((b"retry-after", b"9"), blocked[0]["headers"])
        self.assertEqual(calls, ["app"])


    async def test_asgi_middleware_skips_static_assets_before_calling_the_rate_limit_service(self):
        transport_calls = []
        app_calls = []

        async def transport(url, headers, body, timeout):
            transport_calls.append(json.loads(body.decode("utf-8")))
            return {
                "status": 200,
                "headers": {},
                "body": json.dumps({
                    "allowed": True,
                    "policy": "public",
                    "scope": "catalog-read",
                }),
            }

        client = UniversalRateLimitClient(
            "https://guard.example/check", "catalog-api",
            "python-client-secret-at-least-32-bytes", transport=transport,
        )

        async def app(scope, receive, send):
            app_calls.append(scope["path"])
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok", "more_body": False})

        middleware = SecurityGuardRateLimitMiddleware(
            app, client=client, identity_resolver=lambda scope: "trusted-user",
            policy="public", scope="catalog-read",
        )

        async def invoke(path, method="GET"):
            messages = []

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(message):
                messages.append(message)

            await middleware(
                {"type": "http", "method": method, "path": path, "user_id": "trusted-user"},
                receive, send,
            )
            return messages

        for path in (
            "/assets/site.css",
            "/assets/site.js",
            "/media/perfume.webp",
            "/images/perfume.jpg",
            "/fonts/site.woff2",
        ):
            self.assertEqual((await invoke(path))[0]["status"], 200)

        self.assertEqual(len(transport_calls), 0)
        self.assertEqual((await invoke("/catalog"))[0]["status"], 200)
        self.assertEqual(len(transport_calls), 1)
        self.assertEqual(app_calls[-1], "/catalog")

        await invoke("/api/catalog.js")
        self.assertEqual(
            len(transport_calls), 2,
            "dynamic GET routes must not bypass rate limits because of a static-looking extension",
        )
        await invoke("/api/upload.js", method="POST")
        self.assertEqual(len(transport_calls), 3, "POST requests are never skipped by extension")

    async def test_asgi_static_asset_exclusions_can_be_disabled_or_reconfigured(self):
        calls = []

        async def transport(url, headers, body, timeout):
            calls.append(json.loads(body.decode("utf-8")))
            return {
                "status": 200,
                "headers": {},
                "body": json.dumps({
                    "allowed": True,
                    "policy": "public",
                    "scope": "catalog-read",
                }),
            }

        client = UniversalRateLimitClient(
            "https://guard.example/check", "catalog-api",
            "python-client-secret-at-least-32-bytes", transport=transport,
        )

        async def app(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok", "more_body": False})

        middleware = SecurityGuardRateLimitMiddleware(
            app, client=client, identity_resolver=lambda scope: "trusted-user",
            policy="public", scope="catalog-read",
            excluded_extensions=(".css",),
            excluded_prefixes=(),
        )

        async def invoke(path):
            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(message):
                return None

            await middleware(
                {"type": "http", "method": "GET", "path": path, "user_id": "trusted-user"},
                receive, send,
            )

        await invoke("/assets/site.css")
        await invoke("/assets/site.js")
        self.assertEqual(
            len(calls), 2,
            "an empty trusted-prefix list disables all static exclusions, even for matching extensions",
        )


if __name__ == "__main__":
    unittest.main()
