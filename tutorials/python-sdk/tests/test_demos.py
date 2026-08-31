from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

from deepseek_harness import Notification

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

REPO_ROOT = Path(__file__).resolve().parents[3]
DEMOS = REPO_ROOT / "tutorials/python-sdk"
TUTORIALS_ROOT = DEMOS / "tutorials"
SCRIPTS = {
    "01_hello.py": "Run one prompt",
    "02_reuse_session.py": "Reuse one runtime",
    "03_stream_events.py": "Stream assistant text",
    "04_workspace_agent.py": "Run an agent against an isolated workspace",
    "05_low_level_client.py": "Drive the runtime through HarnessClient",
    "06_raw_jsonrpc.py": "Drive the bundled runtime without the SDK client",
}


def test_python_sdk_is_an_uv_project_with_ruff() -> None:
    config = tomllib.loads((DEMOS / "pyproject.toml").read_text(encoding="utf-8"))
    dependencies = config["project"]["dependencies"]
    dev_dependencies = config["dependency-groups"]["dev"]

    assert any(item.startswith("deepseek-harness-sdk") for item in dependencies)
    assert any(item.startswith("pytest") for item in dev_dependencies)
    assert any(item.startswith("ruff") for item in dev_dependencies)
    assert config["tool"]["ruff"]["target-version"] == "py310"
    assert {"F", "I", "UP", "B", "SIM"} <= set(config["tool"]["ruff"]["lint"]["select"])


def test_python_sdk_uses_uv_as_its_documented_entrypoint() -> None:
    for filename in SCRIPTS:
        assert not (DEMOS / filename).read_text(encoding="utf-8").startswith("#!")

    readmes = [
        (DEMOS / "README.md").read_text(encoding="utf-8"),
        (DEMOS / "README.zh.md").read_text(encoding="utf-8"),
    ]
    for content in readmes:
        assert "python -m venv" not in content
        assert "pip install" not in content
        assert "uv sync --group dev" in content
        assert "uv run pytest" in content
        assert "uv run ruff check ." in content
        assert "uv run ruff format --check ." in content


def test_bilingual_readmes_load_the_root_env_file_for_live_runs() -> None:
    for filename in ("README.md", "README.zh.md"):
        content = (DEMOS / filename).read_text(encoding="utf-8")

        assert "uv run --env-file ../../.env python 01_hello.py" in content


TUTORIALS = {
    "01_hello.py": "01-hello",
    "02_reuse_session.py": "02-reuse-session",
    "03_stream_events.py": "03-stream-events",
    "04_workspace_agent.py": "04-workspace-agent",
    "05_low_level_client.py": "05-low-level-client",
    "06_raw_jsonrpc.py": "06-raw-jsonrpc",
}


def load_demo(filename: str) -> ModuleType:
    path = DEMOS / filename
    spec = importlib.util.spec_from_file_location(filename.removesuffix(".py"), path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_python_sdk_demos_compile_and_expose_help() -> None:
    for filename, description in SCRIPTS.items():
        path = DEMOS / filename
        source = path.read_text(encoding="utf-8")
        compile(source, str(path), "exec")
        result = subprocess.run(
            [sys.executable, str(path), "--help"],
            check=False,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        assert description in result.stdout
        if filename in {"01_hello.py", "02_reuse_session.py", "03_stream_events.py"}:
            assert "--session-root" in result.stdout


def test_each_python_demo_has_a_complete_bilingual_tutorial() -> None:
    required_headings = [
        "## Outcome",
        "## Run it",
        "## How it works",
        "## Verify it",
        "## Limitations",
    ]
    for script, stem in TUTORIALS.items():
        english = TUTORIALS_ROOT / f"{stem}.md"
        chinese = TUTORIALS_ROOT / f"{stem}.zh.md"
        content = english.read_text(encoding="utf-8")
        assert chinese.is_file()
        assert f"../{script}" in content
        assert f"uv run python {script}" in content
        assert all(heading in content for heading in required_headings)
        assert "```mermaid" in content


def test_stream_demo_extracts_only_committed_text_deltas() -> None:
    module = load_demo("03_stream_events.py")
    text_delta_from = module.text_delta_from

    assert (
        text_delta_from(
            {
                "method": "session.event",
                "params": {
                    "event": {
                        "type": "assistant/chunk",
                        "data": {"chunk": {"type": "text-delta", "text": "hello"}},
                    }
                },
            }
        )
        == "hello"
    )
    assert (
        text_delta_from(
            {
                "method": "session.event",
                "params": {
                    "event": {
                        "type": "assistant/chunk",
                        "data": {"chunk": {"type": "reasoning-delta", "text": "hidden"}},
                    }
                },
            }
        )
        is None
    )
    assert text_delta_from({"method": "session.status", "params": {"status": "running"}}) is None
    assert (
        text_delta_from(
            {
                "method": "session.event",
                "params": {
                    "sessionId": "child",
                    "event": {
                        "type": "assistant/chunk",
                        "data": {"chunk": {"type": "text-delta", "text": "child text"}},
                    },
                },
            },
            session_id="root",
        )
        is None
    )


def test_raw_jsonrpc_demo_builds_compact_protocol_frames() -> None:
    module = load_demo("06_raw_jsonrpc.py")

    frame = module.encode_request(7, "session/prompt", {"sessionId": "demo"})

    assert (
        frame
        == b'{"jsonrpc":"2.0","id":7,"method":"session/prompt","params":{"sessionId":"demo"}}\n'
    )


def test_low_level_demos_correlate_the_durable_inbox_receipt() -> None:
    sdk_demo = load_demo("05_low_level_client.py")
    raw_demo = load_demo("06_raw_jsonrpc.py")
    notification = {
        "method": "session.event",
        "params": {
            "event": {
                "type": "agent/inbox/spliced",
                "data": {"inserted": [{"id": "other"}, {"id": "wanted"}]},
            }
        },
    }

    assert sdk_demo.inbox_contains_message(
        Notification(method="session.event", payload=notification["params"]),
        "wanted",
    )
    assert not sdk_demo.inbox_contains_message(
        Notification(method="session.event", payload=notification["params"]),
        "missing",
    )
    assert raw_demo.inbox_message_ids(notification) == {"other", "wanted"}
