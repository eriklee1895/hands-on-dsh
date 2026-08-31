"""Strict launch resolution for fake, pinned-source, and explicit commands."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).parents[2]
VERSIONS_PATH = PROJECT_ROOT / "versions.json"
SourceValidator = Callable[[Path, dict[str, Any]], dict[str, object]]
CommandRunner = Callable[[Sequence[str]], str]


class LaunchError(ValueError):
    """Launch configuration is absent, unsafe, or version-incompatible."""


@dataclass(frozen=True)
class LaunchSpec:
    """Resolved process arguments and sanitized version evidence."""

    mode: str
    argv: tuple[str, ...]
    cwd: Path | None
    version_evidence: dict[str, object]
    source_evidence: dict[str, object]


def load_versions() -> dict[str, Any]:
    """Load checked-in release and wire identity pins.

    Returns:
        Parsed version metadata.
    """
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
    source_validator: SourceValidator | None = None,
    allow_version_mismatch: bool = False,
) -> LaunchSpec:
    """Resolve one protocol server without shell evaluation.

    Args:
        mode: One of ``fake``, ``source``, or ``command``.
        protocol: ``sdk`` or ``acp``.
        env: Environment used only for documented launch variables.
        isolated_cwd: Existing isolated directory for source execution.
        source_validator: Injectable pinned-checkout validator.
        allow_version_mismatch: Permit a nonconforming source revision for learning only.

    Returns:
        A validated launch specification.
    """
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
            source_evidence={},
        )
    if mode == "command":
        prefix = "DSH_SDK_SERVER" if protocol == "sdk" else "DSH_ACP_SERVER"
        argv = _parse_command_argv(variables.get(f"{prefix}_ARGV"))
        cwd = _optional_existing_absolute_directory(variables.get(f"{prefix}_CWD"))
        return LaunchSpec(
            mode=mode,
            argv=argv,
            cwd=cwd,
            version_evidence=version_evidence,
            source_evidence={},
        )
    if mode != "source":
        raise LaunchError("server mode must be fake, source, or command")
    source_root = _required_existing_absolute_directory(
        variables.get("DSH_SOURCE_ROOT"), "DSH_SOURCE_ROOT"
    )
    if isolated_cwd is None or not isolated_cwd.is_absolute() or not isolated_cwd.is_dir():
        raise LaunchError("isolated source cwd must be an absolute existing directory")
    argv = _source_argv(source_root, protocol)
    validator = validate_source_checkout if source_validator is None else source_validator
    if source_validator is None:
        source_evidence = validate_source_checkout(
            source_root,
            versions,
            allow_version_mismatch=allow_version_mismatch,
        )
    else:
        source_evidence = validator(source_root, versions)
    return LaunchSpec(
        mode=mode,
        argv=argv,
        cwd=isolated_cwd,
        version_evidence=version_evidence,
        source_evidence=source_evidence,
    )


def validate_source_checkout(
    root: Path,
    versions: dict[str, Any],
    *,
    command_runner: CommandRunner | None = None,
    allow_version_mismatch: bool = False,
) -> dict[str, object]:
    """Validate a clean pinned DSH source checkout without building it.

    Args:
        root: Absolute source checkout path.
        versions: Checked-in version pins.
        allow_version_mismatch: Record differences instead of rejecting them.

    Returns:
        Sanitized revision and package evidence.
    """
    expected = versions["dsh"]
    runner = _run_checked if command_runner is None else command_runner
    status = runner(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"])
    if status:
        raise LaunchError("DSH source checkout has tracked changes")
    head = runner(["git", "-C", str(root), "rev-parse", "HEAD"])
    try:
        tag: str | None = runner(["git", "-C", str(root), "describe", "--tags", "--exact-match"])
    except LaunchError:
        if not allow_version_mismatch:
            raise
        tag = None
    package = json.loads((root / "package.json").read_text())
    acp_version = versions["acp"]["sdk"]
    dependencies = package.get("devDependencies")
    dependency_version = (
        dependencies.get("@agentclientprotocol/sdk") if isinstance(dependencies, dict) else None
    )
    lock_text = (root / "pnpm-lock.yaml").read_text()
    try:
        specifier, installed = _root_acp_lock_versions(lock_text)
    except LaunchError:
        if not allow_version_mismatch:
            raise
        specifier, installed = None, None
    actuals = (
        ("head", expected["commit"], head),
        ("tag", expected["tag"], tag),
        ("packageVersion", expected["release"], package.get("version")),
        ("acpDependencyVersion", acp_version, dependency_version),
        ("acpLockSpecifier", acp_version, specifier),
        ("acpLockVersion", acp_version, installed),
    )
    mismatches = [
        {"field": field, "expected": wanted, "actual": actual}
        for field, wanted, actual in actuals
        if actual != wanted
    ]
    if mismatches and not allow_version_mismatch:
        raise LaunchError("DSH source revision or package versions do not match versions.json")
    if allow_version_mismatch:
        mismatches.insert(
            0,
            {
                "field": "validationMode",
                "expected": "strict",
                "actual": "allow-version-mismatch",
            },
        )
    return {
        "trackedClean": True,
        "head": head,
        "tag": tag,
        "packageVersion": package.get("version"),
        "acpSdkVersion": dependency_version,
        "conforming": not mismatches,
        "mismatches": mismatches,
    }


def _run_checked(argv: Sequence[str]) -> str:
    completed = subprocess.run(argv, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise LaunchError("source checkout validation command failed")
    return completed.stdout.strip()


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


def _root_acp_lock_versions(lock_text: str) -> tuple[str, str]:
    lines = lock_text.splitlines()
    try:
        root_start = lines.index("  .:")
    except ValueError as error:
        raise LaunchError("pnpm lock lacks the root importer") from error
    root_end = len(lines)
    for index in range(root_start + 1, len(lines)):
        line = lines[index]
        if line and not line.startswith(" "):
            root_end = index
            break
        if line.startswith("  ") and not line.startswith("    "):
            root_end = index
            break
    root_importer = "\n".join(lines[root_start:root_end])
    match = re.search(
        r"(?m)^      '@agentclientprotocol/sdk':\n"
        r"^        specifier: ([^\s]+)\n"
        r"^        version: ([^\s]+)$",
        root_importer,
    )
    if match is None:
        raise LaunchError("pnpm lock lacks the root ACP SDK resolution")
    specifier = match.group(1)
    installed = match.group(2).split("(", 1)[0]
    package_key = re.search(r"(?m)^  '@agentclientprotocol/sdk@([^']+)':$", lock_text)
    if package_key is None or package_key.group(1) != installed:
        raise LaunchError("pnpm lock ACP SDK package key does not match its resolution")
    return specifier, installed


def _optional_existing_absolute_directory(raw: str | None) -> Path | None:
    if raw is None:
        return None
    return _required_existing_absolute_directory(raw, "server cwd")


def _required_existing_absolute_directory(raw: str | None, name: str) -> Path:
    if raw is None or not raw:
        raise LaunchError(f"{name} is required")
    path = Path(raw)
    if not path.is_absolute():
        raise LaunchError(f"{name} must be absolute")
    if not path.is_dir():
        raise LaunchError(f"{name} must be an existing directory")
    return path


def _source_argv(root: Path, protocol: str) -> tuple[str, ...]:
    tsx = root / "node_modules" / ".bin" / "tsx"
    if protocol == "sdk":
        values = (
            tsx,
            root / "packages" / "examples" / "jsonrpc-demo" / "src" / "bin.ts",
            root / "examples" / "jsonrpc-agent" / "minimal.cordis.yml",
        )
    else:
        values = (
            tsx,
            root / "packages" / "examples" / "acp-demo" / "src" / "bin.ts",
            Path("--config"),
            root / "examples" / "acp-agent" / "cordis.yml",
        )
    missing = [path for path in values if str(path) != "--config" and not path.is_file()]
    if missing:
        raise LaunchError("pinned source launch files are missing")
    return tuple(str(path) for path in values)
