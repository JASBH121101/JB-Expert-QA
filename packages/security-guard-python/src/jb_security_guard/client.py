from __future__ import annotations

import asyncio
import json
import ssl
import urllib.error
import urllib.request
from collections.abc import Awaitable, Callable, Mapping
from typing import Any
from urllib.parse import urlsplit


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class UniversalRateLimitClient:
    def __init__(
        self,
        endpoint: str,
        client_id: str,
        client_secret: str,
        *,
        failure_mode: str = "closed",
        timeout_seconds: float = 2.5,
        transport: Callable[..., Awaitable[Mapping[str, Any]]] | None = None,
    ) -> None:
        parsed = urlsplit(endpoint)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("endpoint must be an absolute HTTPS URL without embedded credentials")
        if not client_id or len(client_id) > 96 or any(ch not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:_-" for ch in client_id):
            raise ValueError("client_id has an invalid format")
        if not 32 <= len(client_secret.encode("utf-8")) <= 512:
            raise ValueError("client_secret must contain 32-512 bytes")
        if failure_mode not in ("open", "closed"):
            raise ValueError("failure_mode must be open or closed")
        if not 0.1 <= timeout_seconds <= 15:
            raise ValueError("timeout_seconds must be from 0.1 to 15")
        self._endpoint = endpoint
        self._client_id = client_id
        self._client_secret = client_secret
        self._failure_mode = failure_mode
        self._timeout = timeout_seconds
        self._transport = transport

    async def check(self, identity: str, scope: str, policy: str) -> dict[str, Any]:
        if not isinstance(identity, str) or not identity or "\x00" in identity:
            raise ValueError("identity must be non-empty and contain no NUL")
        try:
            identity_bytes = identity.encode("utf-8", errors="strict")
        except UnicodeEncodeError as exc:
            raise ValueError("identity must be valid UTF-8") from exc
        if len(identity) > 512 or len(identity_bytes) > 2048:
            raise ValueError("identity exceeds the Core v1 length limit")
        for value, label in ((scope, "scope"), (policy, "policy")):
            if not isinstance(value, str) or not value or len(value) > 96 or any(
                ch not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:_-" for ch in value
            ):
                raise ValueError(f"{label} must be a safe identifier")

        body = json.dumps(
            {"identity": identity, "scope": scope, "policy": policy},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-JB-Client-ID": self._client_id,
            "Authorization": "Bearer " + self._client_secret,
        }
        try:
            if self._transport is not None:
                response = await asyncio.wait_for(
                    self._transport(self._endpoint, headers, body, self._timeout),
                    timeout=self._timeout,
                )
            else:
                response = await asyncio.wait_for(
                    asyncio.to_thread(self._send_http, self._endpoint, headers, body, self._timeout),
                    timeout=self._timeout + 0.25,
                )
        except Exception:
            return self._unavailable()

        if not isinstance(response, Mapping):
            return self._deny()
        status = response.get("status")
        raw_headers = response.get("headers", {})
        response_body = response.get("body", b"")
        if type(status) is not int or not isinstance(raw_headers, Mapping):
            return self._deny()
        if isinstance(response_body, bytes):
            try:
                response_body = response_body.decode("utf-8")
            except UnicodeDecodeError:
                return self._deny()
        if not isinstance(response_body, str):
            return self._deny()

        if status == 200:
            try:
                payload = json.loads(response_body)
            except (ValueError, TypeError):
                return self._deny()
            if not isinstance(payload, dict) or payload.get("allowed") is not True:
                return self._deny()
            if payload.get("policy") != policy or payload.get("scope") != scope:
                return self._deny()
            return self._decision(True, False, False, False, None, None)
        if status == 429:
            retry = raw_headers.get("retry-after", raw_headers.get("Retry-After", "60"))
            try:
                retry_value = max(1, min(60, int(retry)))
            except (TypeError, ValueError):
                retry_value = 60
            return self._decision(False, True, True, False, 429, retry_value)
        if status == 503:
            return self._unavailable()
        # Authentication/configuration errors are never fail-open.
        return self._deny()

    def _decision(self, allowed, exceeded, enforced, unavailable, status, retry):
        return {
            "allowed": allowed,
            "exceeded": exceeded,
            "enforced": enforced,
            "unavailable": unavailable,
            "status": status,
            "retryAfterSeconds": retry,
        }

    def _unavailable(self):
        if self._failure_mode == "open":
            return self._decision(True, False, False, True, None, None)
        return self._decision(False, False, True, True, 503, 5)

    def _deny(self):
        return self._decision(False, False, True, True, 503, 5)

    def _send_http(self, endpoint, headers, body, timeout):
        request = urllib.request.Request(endpoint, data=body, headers=dict(headers), method="POST")
        opener = urllib.request.build_opener(
            _NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        )
        try:
            with opener.open(request, timeout=timeout) as response:
                return {
                    "status": response.status,
                    "headers": dict(response.headers.items()),
                    "body": response.read(16_385),
                }
        except urllib.error.HTTPError as response:
            return {
                "status": response.code,
                "headers": dict(response.headers.items()),
                "body": response.read(16_385),
            }
