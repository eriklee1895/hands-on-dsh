import json
from pathlib import Path

import pytest

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 only
    import tomli as tomllib


PROJECT_ROOT = Path(__file__).parents[1]
REPOSITORY_ROOT = PROJECT_ROOT.parents[1]


def test_project_targets_python_310_without_runtime_sdk_dependency() -> None:
    config = tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text())

    assert config["project"]["requires-python"] == ">=3.10"
    assert config["project"]["dependencies"] == []
    assert config["tool"]["ruff"]["target-version"] == "py310"
    assert any(
        dependency.startswith("tomli>=2,<3") for dependency in config["dependency-groups"]["dev"]
    )


def test_versions_pin_release_source_and_wire_identities() -> None:
    versions = json.loads((PROJECT_ROOT / "versions.json").read_text())

    assert versions == {
        "dsh": {
            "release": "0.1.1-rc.2",
            "tag": "dsh-v0.1.1-rc.2",
            "commit": "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
        },
        "acp": {"sdk": "0.25.1", "protocol": 1},
        "wire": {
            "sdkServerInfoVersion": "0.0.1",
            "acpAgentInfoVersion": "0.0.1",
        },
    }


def test_committed_fixture_has_protocol_neutral_three_line_transcript() -> None:
    records = [
        json.loads(line)
        for line in (PROJECT_ROOT / "fixtures" / "committed-answer.jsonl").read_text().splitlines()
    ]

    assert records == [
        {
            "kind": "user_message",
            "content": [{"type": "text", "text": "fixture prompt"}],
        },
        {
            "kind": "assistant_message",
            "content": [{"type": "text", "text": "fixture answer"}],
        },
        {"kind": "turn_end", "reason": {"kind": "completed"}},
    ]


def test_live_child_environment_is_an_explicit_allowlist(tmp_path: Path) -> None:
    from protocol_labs.live import build_live_child_env

    parent = {
        "PATH": "/bin",
        "HOME": "/home/learner",
        "LANG": "en_US.UTF-8",
        "SSL_CERT_FILE": "/certs/ca.pem",
        "DEEPSEEK_API_KEY": "private-key",
        "DEEPSEEK_BASE_URL": "https://api.example.invalid",
        "HTTPS_PROXY": "https://proxy.example.invalid",
        "AWS_SECRET_ACCESS_KEY": "cloud-secret",
        "DSH_SNAPSHOT": "record",
        "UNRELATED": "must-not-cross",
    }
    workspace = tmp_path / "workspace"
    sessions = tmp_path / "sdk-sessions"
    snapshot_sessions = tmp_path / "acp-sessions"
    home = tmp_path / "home"
    dsh_home = tmp_path / "dsh-home"

    child = build_live_child_env(
        parent,
        workspace=workspace,
        session_root=sessions,
        snapshot_sessions_root=snapshot_sessions,
        home=home,
        dsh_home=dsh_home,
    )

    assert child == {
        "PATH": "/bin",
        "HOME": str(home),
        "LANG": "en_US.UTF-8",
        "SSL_CERT_FILE": "/certs/ca.pem",
        "DEEPSEEK_API_KEY": "private-key",
        "DEEPSEEK_BASE_URL": "https://api.example.invalid",
        "DSH_MODEL": "deepseek-v4-flash",
        "DSH_CONTEXT_WINDOW": "1000000",
        "DSH_SYSTEM_PROMPT": "Do not use tools. Answer the user's request briefly and factually.",
        "DSH_PERMISSION_MODE": "workspace-write",
        "DSH_CWD": str(workspace),
        "DSH_SESSION_ROOT": str(sessions),
        "DSH_SNAPSHOT_SESSIONS_ROOT": str(snapshot_sessions),
        "DSH_HOME": str(dsh_home),
    }
    assert "DSH_SNAPSHOT" not in child


def test_live_child_environment_requires_parent_credential(tmp_path: Path) -> None:
    from protocol_labs.live import LiveEnvironmentError, build_live_child_env

    with pytest.raises(LiveEnvironmentError, match="DEEPSEEK_API_KEY"):
        build_live_child_env(
            {"PATH": "/bin"},
            workspace=tmp_path / "workspace",
            session_root=tmp_path / "sdk-sessions",
            snapshot_sessions_root=tmp_path / "acp-sessions",
            home=tmp_path / "home",
            dsh_home=tmp_path / "dsh-home",
        )


def test_final_docs_cover_source_commands_matrix_and_indexes() -> None:
    lab_readme = (PROJECT_ROOT / "README.md").read_text()
    comparison_path = REPOSITORY_ROOT / "docs" / "comparisons" / "sdk-jsonrpc-vs-acp.md"
    comparison = comparison_path.read_text()
    labs_index = (REPOSITORY_ROOT / "labs" / "README.md").read_text()
    comparisons_index = (REPOSITORY_ROOT / "docs" / "comparisons" / "README.md").read_text()
    root_readme = (REPOSITORY_ROOT / "README.md").read_text()

    assert (
        "uv run --env-file ../../.env python -m protocol_labs.sdk_jsonrpc --server source"
        in lab_readme
    )
    assert "uv run --env-file ../../.env python -m protocol_labs.acp --server source" in lab_readme
    assert "DSH_SOURCE_ROOT" in lab_readme
    assert "DSH_SDK_SERVER_ARGV" in lab_readme
    assert "DSH_ACP_SERVER_ARGV" in lab_readme
    assert "agent/inbox/spliced" in lab_readme
    assert "session/request_permission" in lab_readme
    assert "-32601" in lab_readme and "-32602" in lab_readme and "-32603" in lab_readme
    assert "--allow-version-mismatch" in lab_readme
    assert "danger-full-access" in lab_readme
    assert "SDK minimal config" in lab_readme
    assert "SIGTERM" in lab_readme and "SIGKILL" in lab_readme
    assert "source mode、真实模型和上游 keyless tests 不在当前验证范围内" not in lab_readme

    for heading in ("方法与方向", "事件与输出", "控制能力", "错误", "打包与启动", "适用场景"):
        assert heading in comparison
    for token in (
        "session/prompt",
        "session.event",
        "session/cancel",
        "session/request_permission",
        "authoritative business Run",
        "DSH 的 ACP 投影",
    ):
        assert token in comparison
    assert "[protocol-semantics](protocol-semantics/README.md)" in labs_index
    assert "[SDK JSON-RPC 与 ACP](sdk-jsonrpc-vs-acp.md)" in comparisons_index
    assert "[x] 理解 ACP 初始化、session、prompt、cancel 与 permission 语义" in root_readme
    assert "编辑器式 ACP Web 客户端" not in root_readme


def test_new_docs_use_valid_relative_links_and_no_personal_paths() -> None:
    import re

    paths = [
        PROJECT_ROOT / "README.md",
        REPOSITORY_ROOT / "docs" / "comparisons" / "sdk-jsonrpc-vs-acp.md",
        REPOSITORY_ROOT / "labs" / "README.md",
        REPOSITORY_ROOT / "docs" / "comparisons" / "README.md",
        REPOSITORY_ROOT / "README.md",
    ]
    link_pattern = re.compile(r"\[[^]]+\]\(([^)]+)\)")
    for path in paths:
        text = path.read_text()
        assert "/Users/" not in text
        for target in link_pattern.findall(text):
            if "://" in target or target.startswith("#"):
                continue
            relative = target.split("#", 1)[0]
            assert (path.parent / relative).exists(), f"broken link in {path}: {target}"
