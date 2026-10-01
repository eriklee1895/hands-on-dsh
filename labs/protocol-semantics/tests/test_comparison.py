from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


def invoke(*args):
    env = dict(os.environ)
    env.pop("DEEPSEEK_API_KEY", None)
    return subprocess.run(
        [sys.executable, "-m", "protocol_labs.comparison", *args],
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )


def test_fake_common_suite_and_negative_control():
    completed = invoke()
    assert completed.returncode == 0, completed.stdout + completed.stderr
    report = json.loads(completed.stdout)
    assert report["engine"] == "dsh"
    assert report["evidence"] == "controlled-peers"
    assert report["counts"] == {"selected": 13, "passed": 13, "failed": 0}
    assert all(row["closed"]["group_gone"] for row in report["cases"])
    negative = invoke("--negative-control")
    assert negative.returncode == 1, negative.stdout + negative.stderr
    assert json.loads(negative.stdout)["counts"]["failed"] == 1


def test_cli_requires_explicit_binary_mode_and_missing_dsh_key_does_not_pass():
    for args in [("--engine", "codex"), ("--engine", "hermes"), ("--server", "package")]:
        completed = invoke(*args)
        assert completed.returncode == 2
        assert "counts" not in json.loads(completed.stdout)


def test_common_prompt_check_does_not_accept_acp_settled_as_sdk_completion(monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from protocol_labs import comparison

    class WrongMapping:
        async def prompt(self, text):
            return SimpleNamespace(
                status="settled",
                text=text,
                tool_events=0,
                settlement="receipt-to-root-idle",
                native={
                    "receiptMatched": True,
                    "completedTurnObserved": False,
                    "rootTurnEndReason": "blocked",
                },
            )

        async def close(self):
            return {"group_gone": True, "native_clean_exit": True, "state_removed": True}

    async def opened(protocol, server):
        return WrongMapping()

    monkeypatch.setattr(comparison, "open_adapter", opened)
    row = asyncio.run(comparison._prompt_case("sdk", "fake", "expected", "expected"))
    assert row["checks"]["settled_normally"] is False
    assert row["passed"] is False


@pytest.mark.parametrize(
    "answer_prefix,answer_suffix,accepted",
    [
        ("", "", True),
        ("", "\n", True),
        (" ", "", False),
        ("\n", "", False),
        ("", " ", False),
        ("", "\n\n", False),
        ("", "\n ", False),
    ],
)
def test_cli_nonce_requires_exact_line(
    monkeypatch, tmp_path: Path, answer_prefix: str, answer_suffix: str, accepted: bool
):
    import asyncio

    from protocol_labs import comparison

    expected = "ENGINE_OK_" + "a" * 32

    class FakeAdapter:
        protocol = "exec-jsonl"
        state_root = tmp_path

        async def prompt(self, prompt: str):
            if prompt.startswith("Do not use tools"):
                return SimpleNamespace(
                    status="completed",
                    protocol="exec-jsonl",
                    text=answer_prefix + expected + answer_suffix,
                    tool_events=0,
                    settlement="terminal",
                    native={},
                )
            (tmp_path / "workspace").mkdir(exist_ok=True)
            (tmp_path / "workspace/result.txt").write_text("ARTIFACT_OK_" + "a" * 32 + "\n")
            return SimpleNamespace(
                status="completed",
                protocol="exec-jsonl",
                text="done",
                tool_events=1,
                settlement="terminal",
                native={},
            )

        async def close(self):
            return {"group_gone": True, "state_removed": True, "native_clean_exit": True}

    async def opened(_engine: str):
        return FakeAdapter()

    monkeypatch.setattr(comparison, "open_cli_adapter", opened)
    monkeypatch.setattr(comparison, "uuid4", lambda: SimpleNamespace(hex="a" * 32))
    report = asyncio.run(comparison.compare_cli("codex"))
    assert report["cases"][0]["checks"]["exact_text"] is accepted
