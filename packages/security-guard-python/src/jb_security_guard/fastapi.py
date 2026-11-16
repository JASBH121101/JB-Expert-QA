from __future__ import annotations

import inspect
import json
from collections.abc import Callable
from typing import Any

from .client import UniversalRateLimitClient


class SecurityGuardRateLimitMiddleware:
    """ASGI middleware for FastAPI/Starlette using a trusted identity resolver."""

    def __init__(
        self,
        app: Callable,
        *,
        client: UniversalRateLimitClient,
        identity_resolver: Callable,
        policy: str,
        scope: str,
    ) -> None:
        if not callable(app) or not isinstance(client, UniversalRateLimitClient):
            raise TypeError("app and UniversalRateLimitClient are required")
        if not callable(identity_resolver):
            raise TypeError("identity_resolver must be callable")
        if not policy or not scope:
            raise ValueError("policy and scope are required")
        self.app = app
        self.client = client
        self.identity_resolver = identity_resolver
        self.policy = policy
        self.scope = scope

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        try:
            identity = self.identity_resolver(scope)
            if inspect.isawaitable(identity):
                identity = await identity
            if not isinstance(identity, str):
                raise TypeError("trusted identity resolver must return a string")
            decision = await self.client.check(identity, self.scope, self.policy)
        except Exception:
            decision = {
                "allowed": False,
                "status": 503,
                "retryAfterSeconds": 5,
            }

        if decision["allowed"]:
            await self.app(scope, receive, send)
            return

        status = decision.get("status") or 503
        retry = decision.get("retryAfterSeconds")
        payload = {
            "error": "rate_limit_exceeded" if status == 429 else "security_rate_limit_unavailable",
            "message": "Too many requests. Try again later." if status == 429
            else "Request temporarily unavailable due to a security control.",
        }
        headers = [
            (b"content-type", b"application/json; charset=utf-8"),
            (b"cache-control", b"no-store"),
            (b"x-content-type-options", b"nosniff"),
        ]
        if retry is not None:
            headers.append((b"retry-after", str(int(retry)).encode("ascii")))
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body, "more_body": False})
