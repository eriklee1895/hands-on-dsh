from __future__ import annotations

import importlib.util
import queue
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest
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
    "03_stream_events.py": "Project committed assistant messages",
    "04_workspace_agent.py": "Run an agent against an isolated workspace",
    "05_low_level_client.py": "Drive the runtime through HarnessClient",
    "06_raw_jsonrpc.py": "Drive the bundled runtime without the SDK client",
}


def test_python_sdk_is_an_uv_project_with_ruff() -> None:
    config = tomllib.loads((DEMOS / "pyproject.toml").read_text(encoding="utf-8"))
    dependencies = config["project"]["dependencies"]
    dev_dependencies = config["dependency-groups"]["dev"]

    assert "deepseek-harness-sdk==0.1.5rc1" in dependencies
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
    sys.modules[spec.name] = module
    if str(DEMOS) not in sys.path:
        sys.path.insert(0, str(DEMOS))
    spec.loader.exec_module(module)
    return module


def test_temporary_paths_are_retained_until_runtime_close_is_confirmed() -> None:
    resources = load_demo("demo_resources.py").DemoResources("test-resource")
    with resources:
        root = resources.root
        assert root.exists()
    assert root.exists()
    with load_demo("demo_resources.py").DemoResources("test-resource") as closed:
        closed_root = closed.root
        closed.confirm_closed()
    assert not closed_root.exists()
    import shutil

    shutil.rmtree(root)


def test_temporary_paths_close_owned_runtime_after_failed_enter() -> None:
    class FakeRuntime:
        closed = False

        def close(self) -> None:
            self.closed = True

    runtime = FakeRuntime()
    resources = load_demo("demo_resources.py").DemoResources("test-resource")
    with pytest.raises(RuntimeError, match="startup failed"), resources:
        resources.own(runtime)
        raise RuntimeError("startup failed")
    assert runtime.closed
    assert not resources.root.exists()


def test_temporary_paths_keep_home_when_owned_runtime_close_fails() -> None:
    class FakeRuntime:
        def close(self) -> None:
            raise RuntimeError("close failed")

    resources = load_demo("demo_resources.py").DemoResources("test-resource")
    with pytest.raises(RuntimeError, match="close failed"), resources:
        resources.own(FakeRuntime())
    assert resources.root.exists()
    import shutil

    shutil.rmtree(resources.root)


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
        assert "--dsh-home" in result.stdout


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


def test_notification_demo_projects_only_root_committed_message() -> None:
    module = load_demo("03_stream_events.py")
    committed_text_from = module.committed_text_from

    assert (
        committed_text_from(
            {
                "method": "session.event",
                "params": {
                    "sessionId": "root",
                    "event": {
                        "type": "assistant/message",
                        "data": {"message": {"content": [{"type": "text", "text": "hello"}]}},
                    },
                },
            },
            session_id="root",
        )
        == "hello"
    )
    assert (
        committed_text_from(
            {
                "method": "session.event",
                "params": {
                    "sessionId": "root",
                    "event": {
                        "type": "assistant/chunk",
                        "data": {"chunk": {"type": "reasoning-delta", "text": "hidden"}},
                    },
                },
            },
            session_id="root",
        )
        is None
    )
    assert (
        committed_text_from({"method": "session.status", "params": {"status": "running"}}) is None
    )
    assert (
        committed_text_from(
            {
                "method": "session.event",
                "params": {
                    "sessionId": "child",
                    "event": {
                        "type": "assistant/message",
                        "data": {"message": {"content": [{"type": "text", "text": "child"}]}},
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


def test_raw_prompt_projection_accepts_receipt_before_response_and_ignores_child() -> None:
    projection = load_demo("06_raw_jsonrpc.py").PromptProjection("root")
    projection.observe(
        {"method": "session.status", "params": {"sessionId": "root", "status": "idle"}}
    )
    projection.observe(
        {
            "method": "session.event",
            "params": {
                "sessionId": "root",
                "event": {
                    "type": "agent/inbox/spliced",
                    "data": {"inserted": [{"id": "wanted"}]},
                },
            },
        }
    )
    for session_id in ("child", "root"):
        projection.observe(
            {
                "method": "session.event",
                "params": {
                    "sessionId": session_id,
                    "event": {
                        "type": "assistant/message",
                        "data": {"message": {"content": [{"type": "text", "text": session_id}]}},
                    },
                },
            }
        )
    projection.observe(
        {"method": "session.status", "params": {"sessionId": "child", "status": "idle"}}
    )
    assert projection.settled_at() is None
    projection.observe(
        {"method": "session.status", "params": {"sessionId": "root", "status": "idle"}}
    )
    assert projection.settled_at() is None
    projection.observe({"id": 2, "result": {"messageId": "wanted"}})
    assert projection.settled_at() == 6
    assert projection.final_text() == "root"


def test_raw_receive_reports_eof_and_deadline() -> None:
    import time

    module = load_demo("06_raw_jsonrpc.py")
    frames: queue.Queue[dict[str, object] | BaseException | None] = queue.Queue()
    frames.put(None)
    with pytest.raises(EOFError, match="closed stdout"):
        module.receive_frame(frames, time.monotonic() + 1, lambda: 7)
    with pytest.raises(TimeoutError, match="deadline"):
        module.receive_frame(queue.Queue(), time.monotonic() - 1, lambda: None)
    queued: queue.Queue[dict[str, object] | BaseException | None] = queue.Queue()
    queued.put({"id": 1, "result": {}})
    with pytest.raises(TimeoutError, match="deadline"):
        module.receive_frame(queued, time.monotonic() - 1, lambda: None)


def test_low_level_deadline_expires_even_with_queued_notifications() -> None:
    import time

    module = load_demo("05_low_level_client.py")
    incoming: queue.Queue[Notification | BaseException] = queue.Queue()
    incoming.put(Notification(method="session.status", payload={"status": "running"}))
    with pytest.raises(TimeoutError, match="deadline"):
        module.next_before_deadline(incoming, time.monotonic() - 1)


@pytest.mark.parametrize("filename", ["05_low_level_client.py", "06_raw_jsonrpc.py"])
def test_deadlines_reject_nonfinite_values(filename: str) -> None:
    module = load_demo(filename)
    with pytest.raises(ValueError, match="finite positive"):
        module.finite_positive_timeout("nan")
    with pytest.raises(ValueError, match="finite positive"):
        module.finite_positive_timeout("inf")


def test_raw_projection_rejects_error_turn_even_with_committed_text() -> None:
    projection = load_demo("06_raw_jsonrpc.py").PromptProjection("root")
    projection.observe({"id": 2, "result": {"messageId": "wanted"}})
    projection.observe(
        {
            "method": "session.event",
            "params": {
                "sessionId": "root",
                "event": {
                    "type": "agent/inbox/spliced",
                    "data": {"inserted": [{"id": "wanted"}]},
                },
            },
        }
    )
    projection.observe(
        {
            "method": "session.event",
            "params": {
                "sessionId": "root",
                "event": {
                    "type": "assistant/message",
                    "data": {"message": {"content": [{"type": "text", "text": "partial"}]}},
                },
            },
        }
    )
    projection.observe(
        {
            "method": "session.event",
            "params": {
                "sessionId": "root",
                "event": {"type": "turn/end", "data": {"reason": {"kind": "error"}}},
            },
        }
    )
    projection.observe(
        {"method": "session.status", "params": {"sessionId": "root", "status": "idle"}}
    )
    with pytest.raises(RuntimeError, match="did not commit a completed response"):
        projection.verified_final_text()


@pytest.mark.parametrize(
    ("interval_reason", "late_reason", "should_complete"),
    [("error", "completed", False), ("completed", "error", True)],
)
def test_raw_projection_uses_turn_reason_before_first_settling_idle(
    interval_reason: str, late_reason: str, should_complete: bool
) -> None:
    projection = load_demo("06_raw_jsonrpc.py").PromptProjection("root")
    projection.observe(
        {
            "method": "session.event",
            "params": {
                "sessionId": "root",
                "event": {"type": "agent/inbox/spliced", "data": {"inserted": [{"id": "wanted"}]}},
            },
        }
    )
    projection.observe(
        {
            "method": "session.event",
            "params": {
                "sessionId": "root",
                "event": {
                    "type": "assistant/message",
                    "data": {"message": {"content": [{"type": "text", "text": "answer"}]}},
                },
            },
        }
    )
    for reason in (interval_reason, late_reason):
        projection.observe(
            {
                "method": "session.event",
                "params": {
                    "sessionId": "root",
                    "event": {"type": "turn/end", "data": {"reason": {"kind": reason}}},
                },
            }
        )
        if reason == interval_reason:
            projection.observe(
                {"method": "session.status", "params": {"sessionId": "root", "status": "idle"}}
            )
    projection.observe({"id": 2, "result": {"messageId": "wanted"}})
    if should_complete:
        assert projection.verified_final_text() == "answer"
    else:
        with pytest.raises(RuntimeError, match="did not commit a completed response"):
            projection.verified_final_text()


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
    assert (
        raw_demo.inbox_message_ids(
            {**notification, "params": {**notification["params"], "sessionId": "child"}},
            session_id="root",
        )
        == set()
    )
