"""Resolve fake, pinned published-package, and explicit command launches."""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).parents[2]
VERSIONS_PATH = PROJECT_ROOT / "versions.json"


class LaunchError(ValueError):
    """Launch configuration is absent or incompatible with the pinned package."""


@dataclass(frozen=True)
class LaunchSpec:
    """Resolved process arguments and sanitized version evidence."""

    mode: str
    argv: tuple[str, ...]
    cwd: Path | None
    version_evidence: dict[str, object]
    package_evidence: dict[str, object]


def load_versions() -> dict[str, Any]:
    """Load the checked-in release and wire identity pins."""
    value = json.loads(VERSIONS_PATH.read_text())
    if not isinstance(value, dict):
        raise LaunchError("versions.json must contain an object")
    return value


def resolve_launch(
    mode: str,
    *,
    protocol: str,
    env: Mapping[str, str] | None = None,
    isolated_cwd: Path | None = None,
    package_root: Path = PROJECT_ROOT,
) -> LaunchSpec:
    """Resolve one protocol server without shell evaluation."""
    if protocol not in {"sdk", "acp"}:
        raise LaunchError("protocol must be sdk or acp")
    variables = os.environ if env is None else env
    versions = load_versions()
    version_evidence = _version_evidence(versions)
    if mode == "fake":
        return LaunchSpec(
            mode=mode,
            argv=(sys.executable, "-m", f"protocol_labs.{_module_name(protocol)}.fake_server"),
            cwd=None,
            version_evidence=version_evidence,
            package_evidence={},
        )
    if mode == "command":
        prefix = "DSH_SDK_SERVER" if protocol == "sdk" else "DSH_ACP_SERVER"
        return LaunchSpec(
            mode=mode,
            argv=_parse_command_argv(variables.get(f"{prefix}_ARGV")),
            cwd=_optional_existing_absolute_directory(variables.get(f"{prefix}_CWD")),
            version_evidence=version_evidence,
            package_evidence={},
        )
    if mode != "package":
        raise LaunchError("server mode must be fake, package, or command")
    if isolated_cwd is None or not isolated_cwd.is_absolute() or not isolated_cwd.is_dir():
        raise LaunchError("isolated package cwd must be an absolute existing directory")
    bin_path, installed_version = _installed_dsh_bin(package_root, versions)
    profile = "sdk-minimal" if protocol == "sdk" else "acp"
    return LaunchSpec(
        mode=mode,
        argv=("node", str(bin_path), "--profile", profile),
        cwd=isolated_cwd,
        version_evidence=version_evidence,
        package_evidence={"dshVersion": installed_version, "profile": profile, "conforming": True},
    )


def _installed_dsh_bin(root: Path, versions: dict[str, Any]) -> tuple[Path, str]:
    manifest_path = root / "node_modules" / "@deepseek-ai" / "dsh" / "package.json"
    try:
        manifest = json.loads(manifest_path.read_text())
    except (FileNotFoundError, json.JSONDecodeError) as error:
        raise LaunchError("install this project's pinned @deepseek-ai/dsh package first") from error
    expected = versions["dsh"]["release"]
    if (
        not isinstance(manifest, dict)
        or manifest.get("name") != "@deepseek-ai/dsh"
        or manifest.get("version") != expected
    ):
        raise LaunchError("installed @deepseek-ai/dsh metadata does not match versions.json")
    bin_value = manifest.get("bin")
    if not isinstance(bin_value, dict) or not isinstance(bin_value.get("dsh"), str):
        raise LaunchError("installed @deepseek-ai/dsh has no public dsh bin")
    package_dir = manifest_path.parent.resolve()
    bin_path = (package_dir / bin_value["dsh"]).resolve()
    if not bin_path.is_relative_to(package_dir) or not bin_path.is_file():
        raise LaunchError("installed @deepseek-ai/dsh public bin is missing or outside its package")
    return bin_path, expected


def _version_evidence(versions: dict[str, Any]) -> dict[str, object]:
    return {
        "dshRelease": versions["dsh"]["release"],
        "dshTag": versions["dsh"]["tag"],
        "dshCommit": versions["dsh"]["commit"],
        "sdkServerInfoVersion": versions["wire"]["sdkServerInfoVersion"],
        "acpSdkVersion": versions["acp"]["sdk"],
        "acpProtocolVersion": versions["acp"]["protocol"],
        "acpAgentInfoVersion": versions["wire"]["acpAgentInfoVersion"],
    }


def _module_name(protocol: str) -> str:
    return "sdk_jsonrpc" if protocol == "sdk" else "acp"


def _parse_command_argv(raw: str | None) -> tuple[str, ...]:
    if raw is None:
        raise LaunchError("command argv environment variable is required")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise LaunchError("command argv must be a JSON string array") from error
    if (
        not isinstance(value, list)
        or not value
        or any(not isinstance(item, str) for item in value)
        or not value[0]
    ):
        raise LaunchError("command argv must be a JSON string array with non-empty argv[0]")
    return tuple(value)


def _optional_existing_absolute_directory(raw: str | None) -> Path | None:
    if raw is None:
        return None
    path = Path(raw)
    if not path.is_absolute() or not path.is_dir():
        raise LaunchError("server cwd must be an absolute existing directory")
    return path
