from __future__ import annotations

import json
import os
import subprocess
import sys


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


def test_unintegrated_engine_and_missing_key_do_not_pass():
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
