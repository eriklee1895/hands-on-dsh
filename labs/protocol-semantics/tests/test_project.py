import json
import re
from pathlib import Path

import pytest

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 only
    import tomli as tomllib

PROJECT_ROOT = Path(__file__).parents[1]


def test_project_targets_python_310_without_runtime_sdk_dependency() -> None:
    config = tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text())
    assert config["project"]["requires-python"] == ">=3.10"
    assert config["project"]["dependencies"] == []
    assert config["tool"]["ruff"]["target-version"] == "py310"


def test_versions_pin_published_dsh_acp_and_wire_identities() -> None:
    versions = json.loads((PROJECT_ROOT / "versions.json").read_text())
    assert versions == {
        "dsh": {
            "release": "0.1.7-rc.2",
            "tag": "dsh-v0.1.7-rc.2",
            "commit": "477b4f420553e8a52c2fbccc464d7561b239c443",
        },
        "acp": {"sdk": "1.4.0", "protocol": 1},
        "wire": {"sdkServerInfoVersion": "0.0.1", "acpAgentInfoVersion": "0.0.1"},
    }
    manifest = json.loads((PROJECT_ROOT / "package.json").read_text())
    assert manifest["dependencies"] == {"@deepseek-ai/dsh": "0.1.7-rc.2"}
    assert manifest["packageManager"] == "pnpm@12.3.4"
    lock = (PROJECT_ROOT / "pnpm-lock.yaml").read_text()
    assert "'@agentclientprotocol/sdk@1.4.0':" in lock
    assert "'@deepseek-ai/dsh-acp@0.1.7-rc.2':" in lock


def test_committed_fixture_has_protocol_neutral_three_line_transcript() -> None:
    records = [
        json.loads(line)
        for line in (PROJECT_ROOT / "fixtures" / "committed-answer.jsonl").read_text().splitlines()
    ]
    assert records == [
        {"kind": "user_message", "content": [{"type": "text", "text": "fixture prompt"}]},
        {"kind": "assistant_message", "content": [{"type": "text", "text": "fixture answer"}]},
        {"kind": "turn_end", "reason": {"kind": "completed"}},
    ]


def test_live_child_environment_is_explicit_allowlist(tmp_path: Path) -> None:
    from protocol_labs.live import build_live_child_env

    parent = {
        "PATH": "/bin",
        "HOME": "/home/learner",
        "LANG": "en_US.UTF-8",
        "DEEPSEEK_API_KEY": "test-key",
        "DEEPSEEK_BASE_URL": "https://example.invalid",
        "HTTPS_PROXY": "https://proxy.invalid",
        "AWS_SECRET_ACCESS_KEY": "cloud-secret",
    }
    child = build_live_child_env(parent, home=tmp_path / "home", dsh_home=tmp_path / "dsh-home")
    assert child == {
        "PATH": "/bin",
        "LANG": "en_US.UTF-8",
        "DEEPSEEK_API_KEY": "test-key",
        "DEEPSEEK_BASE_URL": "https://example.invalid",
        "HOME": str(tmp_path / "home"),
        "DSH_HOME": str(tmp_path / "dsh-home"),
    }


def test_live_child_environment_requires_parent_credential(tmp_path: Path) -> None:
    from protocol_labs.live import LiveEnvironmentError, build_live_child_env

    with pytest.raises(LiveEnvironmentError, match="DEEPSEEK_API_KEY"):
        build_live_child_env({}, home=tmp_path / "home", dsh_home=tmp_path / "dsh-home")


def test_readme_has_current_package_commands_and_local_links() -> None:
    path = PROJECT_ROOT / "README.md"
    text = path.read_text()
    assert "--server package" in text
    assert "session/resume" in text
    assert "session/set_config_option" in text
    assert "0.1.7-rc.2" in text
    assert "DSH_SOURCE_ROOT" not in text
    assert "/Users/" not in text
    for target in re.findall(r"\[[^]]+\]\(([^)]+)\)", text):
        if "://" in target or target.startswith("#"):
            continue
        assert (path.parent / target.split("#", 1)[0]).exists(), target
