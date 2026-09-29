import asyncio
import json
import sys
import tempfile
from pathlib import Path

import pytest

from protocol_labs.acp import __main__ as acp_main
from protocol_labs.jsonl_peer import CloseOutcome
from protocol_labs.sdk_jsonrpc import __main__ as sdk_main


def test_fake_cli_runs_both_protocols_and_reports_reaped_groups() -> None:
    sdk = asyncio.run(sdk_main._run("fake"))
    acp = asyncio.run(acp_main._run("fake"))
    assert sdk["mode"] == "fake"
    assert sdk["committedAnswer"] == "fixture answer"
    assert sdk["receiptMatched"] is True
    assert sdk["completedTurnObserved"] is True
    assert sdk["processGroup"]["reapedAfterClose"] is True
    assert sdk["closeOutcome"]["shutdownRequestSucceeded"] is True
    assert acp["mode"] == "fake"
    assert acp["fixture"]["committedAnswer"] == "fixture answer"
    assert acp["cancellation"]["stopReason"] == "cancelled"
    assert acp["permission"]["permissionResponses"] == [
        {"outcome": {"outcome": "selected", "optionId": "allow-once"}}
    ]
    assert acp["lifecycle"]["listedAfterClose"] is True
    assert acp["lifecycle"]["resumedOptionCount"] == 1
    assert acp["selectedOptionIds"] == ["model"]
    assert acp["processGroup"]["reapedAfterClose"] is True


def test_command_mode_is_generic_and_not_published_package_acceptance(monkeypatch) -> None:
    monkeypatch.setenv(
        "DSH_SDK_SERVER_ARGV",
        json.dumps([sys.executable, "-m", "protocol_labs.sdk_jsonrpc.fake_server"]),
    )
    monkeypatch.setenv(
        "DSH_ACP_SERVER_ARGV",
        json.dumps([sys.executable, "-m", "protocol_labs.acp.fake_server"]),
    )
    sdk = asyncio.run(sdk_main._run("command"))
    acp = asyncio.run(acp_main._run("command"))
    assert sdk["mode"] == "command"
    assert sdk["packageEvidence"] == {}
    assert sdk["liveAcceptance"] is None
    assert sdk["committedAnswer"] == "fixture answer"
    assert acp["mode"] == "command"
    assert acp["packageEvidence"] == {}
    assert acp["liveAcceptance"] is None
    assert acp["firstPrompt"]["committedAnswer"] == "fixture answer"
    assert acp["restart"] is None


def test_sdk_close_failure_retains_owned_state(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))

    class FailingProbe:
        server_info = {"name": "fake", "version": "0.0.1"}
        process_group_id = 123

        async def prompt(self, *_args, **_kwargs):
            return {
                "committedAnswer": "answer",
                "receiptMatched": True,
                "settlement": "receipt-to-root-idle",
            }

        async def close(self):
            raise RuntimeError("owned process group survived SIGKILL")

    async def start(_cls, *_args, **_kwargs):
        return FailingProbe()

    monkeypatch.setattr(sdk_main.SdkProbe, "start", classmethod(start))
    monkeypatch.setattr(sdk_main, "process_group_exists", lambda _pgid: True)
    with pytest.raises(RuntimeError, match="survived SIGKILL"):
        asyncio.run(sdk_main._run("fake"))
    retained = list(tmp_path.iterdir())
    assert len(retained) == 1
    assert (retained[0] / "workspace").is_dir()
    assert (retained[0] / "home").is_dir()


def test_sdk_start_failure_retains_owned_state(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))

    async def fail_start(_cls, *_args, **_kwargs):
        raise RuntimeError("startup could not confirm owner cleanup")

    monkeypatch.setattr(sdk_main.SdkProbe, "start", classmethod(fail_start))
    with pytest.raises(RuntimeError, match="startup could not confirm"):
        asyncio.run(sdk_main._run("fake"))
    retained = list(tmp_path.iterdir())
    assert len(retained) == 1
    assert (retained[0] / "dsh-home").is_dir()


def test_successful_fake_run_removes_owned_state(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    asyncio.run(sdk_main._run("fake"))
    asyncio.run(acp_main._run("fake"))
    assert list(tmp_path.iterdir()) == []


def test_second_acp_owner_close_failure_retains_shared_state(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-only-key")
    close_ok = CloseOutcome(
        returncode=0,
        shutdown_request_succeeded=None,
        eof_exited_cleanly=True,
        escalation_signal=None,
        group_gone=True,
        diagnostics=(),
    )

    class Probe:
        agent_info = {"name": "fake", "version": "0.0.1"}
        agent_capabilities = {}
        auth_methods = []
        session_id = "session-1"
        config_options = [{"id": "model"}]
        process_group_id = 123

        def __init__(self, second: bool):
            self.second = second

        async def prompt(self, *_args, **_kwargs):
            return {"committedAnswer": "nonce", "stopReason": "end_turn"}

        async def close_session(self):
            return None

        async def list_sessions(self, **_kwargs):
            return {"sessions": [{"sessionId": self.session_id}]}

        async def select_advertised_model(self):
            return self.config_options

        async def historical_replay_count(self):
            return 0

        async def close(self):
            if self.second:
                raise RuntimeError("second owned group survived SIGKILL")
            return close_ok

    async def start(_cls, *_args, resume_session_id=None, **_kwargs):
        return Probe(resume_session_id is not None)

    monkeypatch.setattr(acp_main.AcpProbe, "start", classmethod(start))
    monkeypatch.setattr(acp_main, "process_group_exists", lambda _pgid: False)
    with pytest.raises(RuntimeError, match="second owned group"):
        asyncio.run(acp_main._run("package"))
    retained = list(tmp_path.iterdir())
    assert len(retained) == 1
    assert (retained[0] / "dsh-home").is_dir()


def test_acp_nonce_acceptance_rejects_tool_updates(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-only-key")
    monkeypatch.setattr(acp_main.secrets, "token_hex", lambda _size: "AB12")
    prompts: list[str] = []
    closed = CloseOutcome(
        returncode=0,
        shutdown_request_succeeded=None,
        eof_exited_cleanly=True,
        escalation_signal=None,
        group_gone=True,
        diagnostics=(),
    )

    class Probe:
        agent_info = {"name": "fake", "version": "0.0.1"}
        agent_capabilities = {}
        auth_methods = []
        session_id = "session-1"
        config_options = [{"id": "model"}]
        process_group_id = 123

        def __init__(self, second: bool):
            self.second = second

        async def prompt(self, prompt, **_kwargs):
            prompts.append(prompt[0]["text"])
            return {
                "committedAnswer": "AB12" if self.second else "remembered",
                "stopReason": "end_turn",
                "toolUpdates": 1 if self.second else 0,
            }

        async def close_session(self):
            return None

        async def list_sessions(self, **_kwargs):
            return {"sessions": [{"sessionId": self.session_id}]}

        async def select_advertised_model(self):
            return self.config_options

        async def historical_replay_count(self):
            return 0

        async def close(self):
            return closed

    async def start(_cls, *_args, resume_session_id=None, **_kwargs):
        return Probe(resume_session_id is not None)

    monkeypatch.setattr(acp_main.AcpProbe, "start", classmethod(start))
    monkeypatch.setattr(acp_main, "process_group_exists", lambda _pgid: False)
    with pytest.raises(RuntimeError, match="did not satisfy live acceptance"):
        asyncio.run(acp_main._run("package"))
    assert len(prompts) == 2
    assert all(prompt.startswith("Do not use tools.") for prompt in prompts)
    assert list(tmp_path.iterdir()) == []
