import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).parents[1]


def _launch_api():
    from protocol_labs.launch import LaunchError, resolve_launch

    return LaunchError, resolve_launch


def test_launch_module_exists_before_resolver_behavior() -> None:
    assert (PROJECT_ROOT / "src" / "protocol_labs" / "launch.py").is_file()


def test_fake_launch_uses_current_python_module_without_shell() -> None:
    _, resolve_launch = _launch_api()

    spec = resolve_launch("fake", protocol="sdk", env={})

    assert spec.mode == "fake"
    assert spec.argv == (
        sys.executable,
        "-m",
        "protocol_labs.sdk_jsonrpc.fake_server",
    )
    assert spec.cwd is None
    assert spec.version_evidence["dshRelease"] == "0.1.1-rc.2"


@pytest.mark.parametrize(
    "raw",
    [
        "python server.py",
        "[]",
        '["python", 3]',
        '["", "server.py"]',
        '{"argv":["python"]}',
    ],
)
def test_command_launch_rejects_shell_strings_and_invalid_json_arrays(raw: str) -> None:
    LaunchError, resolve_launch = _launch_api()

    with pytest.raises(LaunchError):
        resolve_launch(
            "command",
            protocol="sdk",
            env={"DSH_SDK_SERVER_ARGV": raw},
        )


def test_command_launch_accepts_strict_argv_and_absolute_existing_cwd(
    tmp_path: Path,
) -> None:
    _, resolve_launch = _launch_api()
    argv = [sys.executable, "-m", "example_server"]

    spec = resolve_launch(
        "command",
        protocol="sdk",
        env={
            "DSH_SDK_SERVER_ARGV": json.dumps(argv),
            "DSH_SDK_SERVER_CWD": str(tmp_path),
        },
    )

    assert spec.argv == tuple(argv)
    assert spec.cwd == tmp_path
    assert not hasattr(spec, "owns_cwd")


def test_command_launch_allows_empty_nonzero_arguments() -> None:
    _, resolve_launch = _launch_api()

    spec = resolve_launch(
        "command",
        protocol="sdk",
        env={"DSH_SDK_SERVER_ARGV": '["python", "", "--flag"]'},
    )

    assert spec.argv == ("python", "", "--flag")


@pytest.mark.parametrize("cwd", ["relative", "/definitely/missing/protocol-lab"])
def test_command_launch_rejects_non_absolute_or_missing_cwd(cwd: str) -> None:
    LaunchError, resolve_launch = _launch_api()

    with pytest.raises(LaunchError):
        resolve_launch(
            "command",
            protocol="sdk",
            env={
                "DSH_SDK_SERVER_ARGV": '["python"]',
                "DSH_SDK_SERVER_CWD": cwd,
            },
        )


def test_source_launch_builds_absolute_tsx_argv_and_uses_isolated_cwd(
    tmp_path: Path,
) -> None:
    _, resolve_launch = _launch_api()
    root = tmp_path / "source"
    isolated = tmp_path / "isolated"
    tsx = root / "node_modules" / ".bin" / "tsx"
    entry = root / "packages" / "examples" / "jsonrpc-demo" / "src" / "bin.ts"
    config = root / "examples" / "jsonrpc-agent" / "minimal.cordis.yml"
    for path in (tsx, entry, config):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture")
    isolated.mkdir()
    observed: list[Path] = []

    def validate(source_root: Path, versions: dict[str, object]) -> dict[str, object]:
        observed.append(source_root)
        assert versions["dsh"]["commit"] == ("b150a551b8d465e31e418e1b2eaf5e79bbb7d28e")
        return {"trackedClean": True, "head": versions["dsh"]["commit"]}

    spec = resolve_launch(
        "source",
        protocol="sdk",
        env={"DSH_SOURCE_ROOT": str(root)},
        isolated_cwd=isolated,
        source_validator=validate,
    )

    assert observed == [root]
    assert spec.argv == (str(tsx), str(entry), str(config))
    assert spec.cwd == isolated
    assert spec.cwd != root
    assert not hasattr(spec, "owns_cwd")
    assert spec.source_evidence["trackedClean"] is True


def test_source_launch_requires_caller_owned_isolated_cwd(tmp_path: Path) -> None:
    LaunchError, resolve_launch = _launch_api()
    root = tmp_path / "source"
    tsx = root / "node_modules" / ".bin" / "tsx"
    entry = root / "packages" / "examples" / "jsonrpc-demo" / "src" / "bin.ts"
    config = root / "examples" / "jsonrpc-agent" / "minimal.cordis.yml"
    for artifact in (tsx, entry, config):
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text("fixture")
    validated = False

    def validate(*_args) -> dict[str, object]:
        nonlocal validated
        validated = True
        return {}

    with pytest.raises(LaunchError, match="isolated source cwd"):
        resolve_launch(
            "source",
            protocol="sdk",
            env={"DSH_SOURCE_ROOT": str(root)},
            source_validator=validate,
        )

    assert validated is False


def test_source_launch_rejects_relative_root_before_validation(tmp_path: Path) -> None:
    LaunchError, resolve_launch = _launch_api()

    with pytest.raises(LaunchError, match="absolute"):
        resolve_launch(
            "source",
            protocol="sdk",
            env={"DSH_SOURCE_ROOT": "relative"},
            isolated_cwd=tmp_path,
            source_validator=lambda *_args: {},
        )


def _write_source_validation_fixture(
    root: Path,
    *,
    package_version: str = "0.1.1-rc.2",
    acp_package_version: str = "0.25.1",
    acp_lock_version: str = "0.25.1",
) -> None:
    (root / "package.json").write_text(
        json.dumps(
            {
                "version": package_version,
                "devDependencies": {"@agentclientprotocol/sdk": acp_package_version},
            }
        )
    )
    (root / "pnpm-lock.yaml").write_text(
        "\n".join(
            [
                "lockfileVersion: '9.0'",
                "importers:",
                "  .:",
                "    devDependencies:",
                "      '@agentclientprotocol/sdk':",
                f"        specifier: {acp_lock_version}",
                f"        version: {acp_lock_version}(zod@4.4.3)",
                "packages:",
                f"  '@agentclientprotocol/sdk@{acp_lock_version}':",
                "    resolution: {}",
                "",
            ]
        )
    )


def _source_command_runner(*, head: str, tag: str):
    def run(argv: tuple[str, ...] | list[str]) -> str:
        if "status" in argv:
            return ""
        if argv[-1] == "HEAD":
            return head
        if "--exact-match" in argv:
            return tag
        raise AssertionError(f"unexpected source validation command: {argv}")

    return run


def test_real_source_validator_accepts_exact_release_and_acp_lock_values(
    tmp_path: Path,
) -> None:
    from protocol_labs.launch import load_versions, validate_source_checkout

    _write_source_validation_fixture(tmp_path)
    versions = load_versions()
    result = validate_source_checkout(
        tmp_path,
        versions,
        command_runner=_source_command_runner(
            head=versions["dsh"]["commit"], tag=versions["dsh"]["tag"]
        ),
    )

    assert result["packageVersion"] == "0.1.1-rc.2"
    assert result["acpSdkVersion"] == "0.25.1"


@pytest.mark.parametrize(
    ("mutation", "value"),
    [
        ("head", "0" * 40),
        ("tag", "dsh-v0.1.1-rc.20"),
        ("package", "0.1.1-rc.20"),
        ("acp_package", "0.25.10"),
        ("acp_lock", "0.25.10"),
    ],
)
def test_real_source_validator_rejects_wrong_exact_version_evidence(
    tmp_path: Path, mutation: str, value: str
) -> None:
    from protocol_labs.launch import LaunchError, load_versions, validate_source_checkout

    versions = load_versions()
    _write_source_validation_fixture(
        tmp_path,
        package_version=value if mutation == "package" else "0.1.1-rc.2",
        acp_package_version=value if mutation == "acp_package" else "0.25.1",
        acp_lock_version=value if mutation == "acp_lock" else "0.25.1",
    )
    runner = _source_command_runner(
        head=value if mutation == "head" else versions["dsh"]["commit"],
        tag=value if mutation == "tag" else versions["dsh"]["tag"],
    )

    with pytest.raises(LaunchError):
        validate_source_checkout(tmp_path, versions, command_runner=runner)


def test_source_mismatch_mode_records_absent_tag_and_is_never_conforming(
    tmp_path: Path,
) -> None:
    from protocol_labs.launch import LaunchError, load_versions, validate_source_checkout

    _write_source_validation_fixture(tmp_path, package_version="0.1.1-rc.3")
    versions = load_versions()

    def runner(argv: tuple[str, ...] | list[str]) -> str:
        if "status" in argv:
            return ""
        if argv[-1] == "HEAD":
            return "1" * 40
        if "--exact-match" in argv:
            raise LaunchError("source checkout validation command failed")
        raise AssertionError(f"unexpected source validation command: {argv}")

    evidence = validate_source_checkout(
        tmp_path,
        versions,
        command_runner=runner,
        allow_version_mismatch=True,
    )

    assert evidence["conforming"] is False
    assert evidence["head"] == "1" * 40
    assert evidence["tag"] is None
    assert evidence["mismatches"] == [
        {"field": "validationMode", "expected": "strict", "actual": "allow-version-mismatch"},
        {
            "field": "head",
            "expected": versions["dsh"]["commit"],
            "actual": "1" * 40,
        },
        {"field": "tag", "expected": versions["dsh"]["tag"], "actual": None},
        {
            "field": "packageVersion",
            "expected": versions["dsh"]["release"],
            "actual": "0.1.1-rc.3",
        },
    ]
