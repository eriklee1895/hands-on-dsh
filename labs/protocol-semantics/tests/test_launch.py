import json
import sys
from pathlib import Path

import pytest

from protocol_labs.launch import LaunchError, resolve_launch


def _package(tmp_path: Path, *, version: str = "0.1.7-rc.2", bin_name: str = "lib/bin.js") -> Path:
    installed = tmp_path / "node_modules" / "@deepseek-ai" / "dsh"
    (installed / "lib").mkdir(parents=True)
    (installed / "package.json").write_text(
        json.dumps({"name": "@deepseek-ai/dsh", "version": version, "bin": {"dsh": bin_name}})
    )
    (installed / "lib" / "bin.js").write_text("// fixture\n")
    return installed


def test_fake_launch_uses_current_python_module_without_shell() -> None:
    spec = resolve_launch("fake", protocol="sdk", env={})
    assert spec.argv == (sys.executable, "-m", "protocol_labs.sdk_jsonrpc.fake_server")
    assert spec.cwd is None
    assert spec.version_evidence["dshRelease"] == "0.1.7-rc.2"


@pytest.mark.parametrize("protocol,profile", [("sdk", "sdk-minimal"), ("acp", "acp")])
def test_package_launch_uses_own_pinned_manifest_and_public_profile(
    tmp_path: Path, protocol: str, profile: str
) -> None:
    installed = _package(tmp_path)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    spec = resolve_launch(
        "package", protocol=protocol, isolated_cwd=workspace, package_root=tmp_path
    )
    assert spec.argv == ("node", str(installed / "lib" / "bin.js"), "--profile", profile)
    assert spec.cwd == workspace
    assert spec.package_evidence == {
        "dshVersion": "0.1.7-rc.2",
        "profile": profile,
        "conforming": True,
    }


@pytest.mark.parametrize(
    "mutation",
    ["missing_manifest", "wrong_version", "missing_bin", "escape_bin"],
)
def test_package_launch_rejects_unpinned_or_missing_public_bin(
    tmp_path: Path, mutation: str
) -> None:
    installed = _package(tmp_path, version="0.0.0" if mutation == "wrong_version" else "0.1.7-rc.2")
    if mutation == "missing_manifest":
        (installed / "package.json").unlink()
    elif mutation == "missing_bin":
        (installed / "lib" / "bin.js").unlink()
    elif mutation == "escape_bin":
        metadata = json.loads((installed / "package.json").read_text())
        metadata["bin"]["dsh"] = "../../../../outside.js"
        (installed / "package.json").write_text(json.dumps(metadata))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    with pytest.raises(LaunchError):
        resolve_launch("package", protocol="sdk", isolated_cwd=workspace, package_root=tmp_path)


def test_package_launch_requires_caller_owned_absolute_workspace(tmp_path: Path) -> None:
    _package(tmp_path)
    with pytest.raises(LaunchError, match="isolated package cwd"):
        resolve_launch("package", protocol="sdk", package_root=tmp_path)
    with pytest.raises(LaunchError, match="isolated package cwd"):
        resolve_launch(
            "package", protocol="sdk", package_root=tmp_path, isolated_cwd=Path("relative")
        )


@pytest.mark.parametrize(
    "raw",
    ["python server.py", "[]", '["python", 3]', '["", "server.py"]', '{"argv":["python"]}'],
)
def test_command_launch_rejects_shell_strings_and_invalid_json_arrays(raw: str) -> None:
    with pytest.raises(LaunchError):
        resolve_launch("command", protocol="sdk", env={"DSH_SDK_SERVER_ARGV": raw})


def test_command_launch_accepts_strict_argv_and_existing_absolute_cwd(tmp_path: Path) -> None:
    argv = [sys.executable, "-m", "example_server"]
    spec = resolve_launch(
        "command",
        protocol="sdk",
        env={"DSH_SDK_SERVER_ARGV": json.dumps(argv), "DSH_SDK_SERVER_CWD": str(tmp_path)},
    )
    assert spec.argv == tuple(argv)
    assert spec.cwd == tmp_path
    assert spec.package_evidence == {}


@pytest.mark.parametrize("cwd", ["relative", "/definitely/missing/protocol-lab"])
def test_command_launch_rejects_non_absolute_or_missing_cwd(cwd: str) -> None:
    with pytest.raises(LaunchError):
        resolve_launch(
            "command",
            protocol="sdk",
            env={"DSH_SDK_SERVER_ARGV": '["python"]', "DSH_SDK_SERVER_CWD": cwd},
        )


def test_unknown_mode_is_not_reported_as_pinned_package() -> None:
    with pytest.raises(LaunchError, match="fake, package, or command"):
        resolve_launch("source", protocol="sdk", env={})
