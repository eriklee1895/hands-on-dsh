"""Credential-minimal environment and process evidence for published-profile probes."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

INHERITED_ENV_NAMES = (
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
)


class LiveEnvironmentError(ValueError):
    """The parent process lacks the credential required for a package probe."""


def build_live_child_env(
    parent: Mapping[str, str],
    *,
    home: Path,
    dsh_home: Path,
) -> dict[str, str]:
    """Build the complete child environment from an explicit allowlist."""
    api_key = parent.get("DEEPSEEK_API_KEY")
    if not api_key:
        raise LiveEnvironmentError("DEEPSEEK_API_KEY is required for package mode")
    child = {name: parent[name] for name in INHERITED_ENV_NAMES if parent.get(name)}
    child["DEEPSEEK_API_KEY"] = api_key
    base_url = parent.get("DEEPSEEK_BASE_URL")
    if base_url:
        child["DEEPSEEK_BASE_URL"] = base_url
    child["HOME"] = str(home)
    child["DSH_HOME"] = str(dsh_home)
    return child


def process_group_exists(group_id: int) -> bool:
    """Return whether a POSIX process group still exists."""
    try:
        os.killpg(group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True
