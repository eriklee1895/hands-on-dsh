"""Create local demo verifier/client environment files without displaying credentials."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from pathlib import Path


def main() -> None:
    tokens = {tenant: secrets.token_urlsafe(32) for tenant in ("alpha", "beta")}
    config = {
        tenant: {"token_sha256": [hashlib.sha256(token.encode("ascii")).hexdigest()]}
        for tenant, token in tokens.items()
    }
    files = {
        Path(".env.tenants-server"): "RECOVERABLE_AGENT_TENANTS='"
        + json.dumps(config, separators=(",", ":"))
        + "'\nRECOVERABLE_AGENT_TENANT_ROOT=.data/tenants\n",
        Path(".env.tenants-client"): "".join(
            f"TENANT_{tenant.upper()}_TOKEN={token}\n" for tenant, token in tokens.items()
        ),
    }
    created: list[Path] = []
    try:
        for path, content in files.items():
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            created.append(path)
            with os.fdopen(descriptor, "w") as stream:
                stream.write(content)
    except BaseException:
        for path in created:
            path.unlink()
        raise
    print("Created .env.tenants-server and .env.tenants-client (mode 0600).")


if __name__ == "__main__":
    main()
