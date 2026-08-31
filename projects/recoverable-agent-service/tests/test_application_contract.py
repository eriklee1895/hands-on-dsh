from __future__ import annotations

import os
import shlex
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parents[1]
REPOSITORY_ROOT = PROJECT_ROOT.parents[1]


def test_import_creates_no_default_files_or_runtime_process(tmp_path: Path) -> None:
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(PROJECT_ROOT / "src")
    completed = subprocess.run(
        [sys.executable, "-c", "import recoverable_agent_service.app"],
        cwd=tmp_path,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )

    assert completed.returncode == 0, completed.stderr
    assert list(tmp_path.iterdir()) == []


def test_root_readme_keyless_command_loads_project_config_and_collects_only_project_tests() -> None:
    readme = (REPOSITORY_ROOT / "README.md").read_text()
    commands = [
        line
        for line in readme.splitlines()
        if line.startswith("uv run --project projects/recoverable-agent-service pytest")
    ]
    assert len(commands) == 1

    completed = subprocess.run(
        [*shlex.split(commands[0]), "--collect-only"],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    output = completed.stdout + completed.stderr
    collected_nodes = [line for line in output.splitlines() if "::" in line]
    assert collected_nodes
    assert all(line.startswith("tests/") for line in collected_nodes)
    assert "tutorials/" not in output
    assert "1 deselected" in output


def test_runtime_adapter_passes_explicit_provider_and_model(tmp_path: Path) -> None:
    import asyncio
    import importlib

    runtime = importlib.import_module("recoverable_agent_service.runtime")
    captured: dict[str, object] = {}

    class Harness:
        def start(self) -> None:
            pass

        def start_session(self, _session_id: str):
            class Session:
                @staticmethod
                def run(_runtime_input: str, *, on_notification=None):
                    return type(
                        "Result", (), {"final_response": "done", "finish_reason": "completed"}
                    )()

            return Session()

        def close(self) -> None:
            pass

    def factory(**kwargs):
        captured.update(kwargs)
        return Harness()

    async def scenario() -> None:
        adapter = runtime.DSHRuntimeAdapter(
            tmp_path / "workspace",
            tmp_path / "sessions",
            provider="deepseek-official",
            model="deepseek-v4-flash",
            harness_factory=factory,
        )
        await adapter.run("session", "prompt", lambda _event: asyncio.sleep(0))
        await adapter.close()

    asyncio.run(scenario())
    assert captured["provider"] == "deepseek-official"
    assert captured["model"] == "deepseek-v4-flash"


def test_module_cli_starts_loopback_uvicorn(monkeypatch) -> None:
    import importlib

    entrypoint = importlib.import_module("recoverable_agent_service.__main__")
    captured: dict[str, object] = {}

    monkeypatch.setattr(entrypoint.uvicorn, "run", lambda *args, **kwargs: captured.update(kwargs))
    entrypoint.main()

    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 8000
