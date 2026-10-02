"""Loopback authenticated entry point with operator-configured per-tenant storage."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI

from .app import create_app
from .tenancy import create_tenant_app


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Tenant configuration contains a duplicate key")
        result[key] = value
    return result


def _credentials(value: str | None) -> tuple[list[str], dict[str, str]]:
    if not value:
        raise ValueError("Set RECOVERABLE_AGENT_TENANTS before starting the authenticated service")
    try:
        config = json.loads(value, object_pairs_hook=_unique_object)
    except (ValueError, TypeError):
        raise ValueError("Invalid tenant configuration JSON") from None
    if not isinstance(config, dict) or not config:
        raise ValueError("Tenant configuration must be a nonempty object")
    credentials: dict[str, str] = {}
    for tenant, settings in config.items():
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", tenant):
            raise ValueError("Invalid tenant identifier")
        if not isinstance(settings, dict) or set(settings) != {"token_sha256"}:
            raise ValueError("Each tenant requires only token_sha256")
        digests = settings["token_sha256"]
        if not isinstance(digests, list) or not digests:
            raise ValueError("token_sha256 must be a nonempty list")
        for digest in digests:
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError("Invalid credential digest")
            if digest in credentials:
                raise ValueError("Credential digests must be unique")
            credentials[digest] = tenant
    return list(config), credentials


def create_from_env() -> FastAPI:
    """Validate configuration and construct tenant apps without starting their runtimes."""
    tenants, credentials = _credentials(os.environ.get("RECOVERABLE_AGENT_TENANTS"))
    configured_root = Path(os.environ.get("RECOVERABLE_AGENT_TENANT_ROOT", ".data/tenants"))
    if configured_root.is_symlink():
        raise ValueError("Tenant storage root cannot be a symbolic link")
    root = configured_root.resolve()
    if root.exists() and not root.is_dir():
        raise ValueError("Tenant storage root must be a directory")
    # Resolve every destination before constructing a coordinator for any tenant.
    paths = {tenant: root / tenant for tenant in tenants}
    for directory in paths.values():
        for path in (
            directory,
            directory / "service.db",
            directory / "workspace",
            directory / "dsh-home",
        ):
            if path.is_symlink() or path.resolve() != path:
                raise ValueError("Tenant storage destinations cannot traverse symbolic links")
        for path in (directory, directory / "workspace", directory / "dsh-home"):
            if path.exists() and not path.is_dir():
                raise ValueError("Tenant storage directories must be directories")
        database = directory / "service.db"
        if database.exists() and not database.is_file():
            raise ValueError("Tenant database must be a regular file")
        if database.exists() and database.stat().st_nlink != 1:
            raise ValueError("Tenant databases cannot have hard links")
    apps = {
        tenant: create_app(
            database_path=directory / "service.db",
            workspace=directory / "workspace",
            dsh_home=directory / "dsh-home",
        )
        for tenant, directory in paths.items()
    }
    return create_tenant_app(apps, credentials)


def main() -> None:
    """Serve only the authenticated application on loopback port 8001."""
    uvicorn.run(
        "recoverable_agent_service.tenant_server:create_from_env",
        factory=True,
        host="127.0.0.1",
        port=8001,
        access_log=False,
    )


if __name__ == "__main__":
    main()
