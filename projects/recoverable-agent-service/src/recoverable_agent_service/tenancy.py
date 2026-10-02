"""Credential-selected routing for independent tenant applications."""

from __future__ import annotations

import hashlib
import re
import secrets
from collections.abc import Mapping
from contextlib import AsyncExitStack, asynccontextmanager
from urllib.parse import parse_qsl

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

TENANT_ID = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
TOKEN_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
BEARER = re.compile(rb"(?i:Bearer) +([A-Za-z0-9_-]{32,256})\Z")
FORBIDDEN_QUERY_KEYS = frozenset({"tenant_id", "session_id", "dsh_session_id", "access_token"})
FORBIDDEN_HEADERS = frozenset({b"x-tenant-id", b"x-session-id"})


def _validate_config(
    tenants: Mapping[str, FastAPI], credentials: Mapping[str, str]
) -> tuple[dict[str, FastAPI], dict[str, str]]:
    """Copy and validate a closed routing table without echoing its values."""
    try:
        child_apps = dict(tenants)
        verifiers = dict(credentials)
    except (TypeError, ValueError):
        raise ValueError("invalid tenant configuration") from None
    if not child_apps or not verifiers:
        raise ValueError("invalid tenant configuration")
    if any(
        not isinstance(tenant_id, str)
        or TENANT_ID.fullmatch(tenant_id) is None
        or not isinstance(child, FastAPI)
        for tenant_id, child in child_apps.items()
    ):
        raise ValueError("invalid tenant configuration")
    if len({id(child) for child in child_apps.values()}) != len(child_apps):
        raise ValueError("invalid tenant configuration")
    if any(
        not isinstance(digest, str)
        or TOKEN_DIGEST.fullmatch(digest) is None
        or not isinstance(tenant_id, str)
        or tenant_id not in child_apps
        for digest, tenant_id in verifiers.items()
    ):
        raise ValueError("invalid tenant configuration")
    if set(child_apps) != set(verifiers.values()):
        raise ValueError("invalid tenant configuration")
    return child_apps, verifiers


class _TenantDispatch:
    """Authenticate HTTP before selecting a child ASGI app."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        tenants: Mapping[str, FastAPI],
        credentials: Mapping[str, str],
    ) -> None:
        self.app = app
        self.tenants = dict(tenants)
        self.credentials = dict(credentials)

    @staticmethod
    def _response_headers(headers: list[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
        retained = [
            (key, value) for key, value in headers if key.lower() not in {b"cache-control", b"vary"}
        ]
        vary_parts = [value for key, value in headers if key.lower() == b"vary"]
        vary = b", ".join(vary_parts)
        if b"authorization" not in {part.strip().lower() for part in vary.split(b",")}:
            vary = b"Authorization" if not vary else vary + b", Authorization"
        return [*retained, (b"cache-control", b"no-store"), (b"vary", vary)]

    async def _reply(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
        status_code: int,
        detail: str,
        *,
        challenge: bool = False,
    ) -> None:
        headers = {"WWW-Authenticate": "Bearer"} if challenge else None
        await JSONResponse({"detail": detail}, status_code=status_code, headers=headers)(
            scope, receive, send
        )

    @staticmethod
    def _has_selector(scope: Scope, headers: list[tuple[bytes, bytes]]) -> bool:
        if any(key.lower() in FORBIDDEN_HEADERS for key, _value in headers):
            return True
        try:
            query = scope.get("query_string", b"").decode("ascii")
        except UnicodeDecodeError:
            return True
        return any(
            key.casefold() in FORBIDDEN_QUERY_KEYS
            for key, _value in parse_qsl(query, keep_blank_values=True)
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def secured_send(message: dict[str, object]) -> None:
            if message["type"] == "http.response.start":
                raw_headers = message.get("headers", [])
                message = {
                    **message,
                    "headers": self._response_headers(list(raw_headers)),
                }
            await send(message)

        headers = list(scope.get("headers", []))
        authorization = [value for key, value in headers if key.lower() == b"authorization"]
        match = BEARER.fullmatch(authorization[0].strip()) if len(authorization) == 1 else None
        if match is None:
            await self._reply(scope, receive, secured_send, 401, "Unauthorized", challenge=True)
            return
        digest = hashlib.sha256(match.group(1)).hexdigest()
        tenant_id: str | None = None
        for configured, candidate_tenant in self.credentials.items():
            if secrets.compare_digest(digest, configured):
                tenant_id = candidate_tenant
        if tenant_id is None:
            await self._reply(scope, receive, secured_send, 401, "Unauthorized", challenge=True)
            return
        if self._has_selector(scope, headers):
            await self._reply(scope, receive, secured_send, 400, "Tenant selectors are not allowed")
            return
        child_scope = dict(scope)
        child_scope["headers"] = [
            (key, value) for key, value in headers if key.lower() != b"authorization"
        ]
        await self.tenants[tenant_id](child_scope, receive, secured_send)


def create_tenant_app(tenants: Mapping[str, FastAPI], credentials: Mapping[str, str]) -> FastAPI:
    """Own all tenant lifespans and route each authenticated HTTP request."""
    child_apps, verifiers = _validate_config(tenants, credentials)

    @asynccontextmanager
    async def lifespan(_outer: FastAPI):
        async with AsyncExitStack() as stack:
            for child in child_apps.values():
                await stack.enter_async_context(child.router.lifespan_context(child))
            yield

    outer = FastAPI(lifespan=lifespan)
    outer.add_middleware(_TenantDispatch, tenants=child_apps, credentials=verifiers)
    return outer
