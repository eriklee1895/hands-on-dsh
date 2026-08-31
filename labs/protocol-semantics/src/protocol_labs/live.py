"""Credential-minimal environment and process evidence for live source probes."""

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
SYSTEM_PROMPT = "Do not use tools. Answer the user's request briefly and factually."


class LiveEnvironmentError(ValueError):
    """The parent process lacks the credential required for a live probe."""


def build_live_child_env(
    parent: Mapping[str, str],
    *,
    workspace: Path,
    session_root: Path,
    snapshot_sessions_root: Path,
    home: Path,
    dsh_home: Path,
) -> dict[str, str]:
    """Build the complete child environment from an explicit allowlist.

    Args:
        parent: Parent environment already populated by the caller's env-file tool.
        workspace: Disposable workspace for model tool access.
        session_root: Disposable SDK JSONL persistence root.
        snapshot_sessions_root: Disposable ACP persistence root.
        home: Disposable process home directory.
        dsh_home: Disposable DSH-specific home directory.

    Returns:
        A complete child environment with fixed live-lab values.
    """
    api_key = parent.get("DEEPSEEK_API_KEY")
    if not api_key:
        raise LiveEnvironmentError("DEEPSEEK_API_KEY is required for source mode")
    child = {name: parent[name] for name in INHERITED_ENV_NAMES if parent.get(name)}
    child["DEEPSEEK_API_KEY"] = api_key
    base_url = parent.get("DEEPSEEK_BASE_URL")
    if base_url:
        child["DEEPSEEK_BASE_URL"] = base_url
    child.update(
        {
            "DSH_MODEL": "deepseek-v4-flash",
            "DSH_CONTEXT_WINDOW": "1000000",
            "DSH_SYSTEM_PROMPT": SYSTEM_PROMPT,
            "DSH_PERMISSION_MODE": "workspace-write",
            "DSH_CWD": str(workspace),
            "DSH_SESSION_ROOT": str(session_root),
            "DSH_SNAPSHOT_SESSIONS_ROOT": str(snapshot_sessions_root),
            "HOME": str(home),
            "DSH_HOME": str(dsh_home),
        }
    )
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
