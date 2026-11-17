from __future__ import annotations

import inspect
import json
from collections.abc import Callable
from typing import Any

from .client import UniversalRateLimitClient


DEFAULT_STATIC_ASSET_EXTENSIONS = frozenset({
    ".css", ".js", ".mjs", ".cjs",
    ".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".svg", ".ico",
    ".woff", ".woff2", ".ttf", ".eot", ".map",
})
DEFAULT_STATIC_ASSET_PREFIXES = ("/static/", "/assets/", "/media/")


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
        excluded_extensions: tuple[str, ...] | frozenset[str] = tuple(DEFAULT_STATIC_ASSET_EXTENSIONS),
        excluded_prefixes: tuple[str, ...] = DEFAULT_STATIC_ASSET_PREFIXES,
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
        if not isinstance(excluded_extensions, (tuple, frozenset)) or len(excluded_extensions) > 32:
            raise ValueError("excluded_extensions must be a bounded tuple or frozenset")
        if any(
            not isinstance(item, str) or len(item) < 2 or len(item) > 12
            or not item.startswith(".") or not item[1:].isascii() or not item[1:].isalnum()
            for item in excluded_extensions
        ):
            raise ValueError("excluded_extensions must contain file extensions such as .css or .webp")
        normalized_extensions = tuple(item.lower() for item in excluded_extensions)
        if len(set(normalized_extensions)) != len(normalized_extensions):
            raise ValueError("excluded_extensions must contain unique extensions such as .css or .webp")
        if not isinstance(excluded_prefixes, tuple) or len(excluded_prefixes) > 32:
            raise ValueError("excluded_prefixes must be a bounded tuple")
        if any(
            not isinstance(item, str) or not item.startswith("/")
            or "?" in item or "#" in item or ".." in item
            for item in excluded_prefixes
        ) or len(set(excluded_prefixes)) != len(excluded_prefixes):
            raise ValueError("excluded_prefixes must contain unique absolute path prefixes")
        self.excluded_extensions = frozenset(normalized_extensions)
        self.excluded_prefixes = excluded_prefixes
        self.policy = policy
        self.scope = scope

    def _is_static_asset(self, request_scope: dict[str, Any]) -> bool:
        method = request_scope.get("method", "GET")
        if not isinstance(method, str) or method.upper() not in ("GET", "HEAD"):
            return False
        path = request_scope.get("path", "")
        if not isinstance(path, str):
            return False
        normalized_path = path.lower()
        if any(normalized_path.startswith(prefix.lower()) for prefix in self.excluded_prefixes):
            return True
        return any(normalized_path.endswith(extension) for extension in self.excluded_extensions)

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or self._is_static_asset(scope):
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
