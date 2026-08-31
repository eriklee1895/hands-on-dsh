import asyncio
from dataclasses import replace
from pathlib import Path

import pytest


def _close_outcome(
    *,
    shutdown_succeeded: bool | None,
    returncode: int = 0,
    escalation_signal: str | None = None,
    diagnostics: tuple[dict[str, object], ...] = (),
):
    from protocol_labs.jsonl_peer import CloseOutcome

    return CloseOutcome(
        returncode=returncode,
        shutdown_request_succeeded=shutdown_succeeded,
        eof_exited_cleanly=returncode == 0 and escalation_signal is None,
        escalation_signal=escalation_signal,
        group_gone=True,
        diagnostics=diagnostics,
    )


def test_probes_forward_complete_child_environment(tmp_path: Path, monkeypatch) -> None:
    from protocol_labs.acp.probe import AcpProbe
    from protocol_labs.jsonl_peer import JsonlPeer
    from protocol_labs.launch import resolve_launch
    from protocol_labs.sdk_jsonrpc.probe import SdkProbe

    child_env = {"PATH": "/bin", "LAB_MARKER": "explicit"}
    observed: list[dict[str, str] | None] = []
    original = JsonlPeer.start.__func__

    async def recording_start(cls, argv, **kwargs):
        observed.append(kwargs.get("env"))
        return await original(cls, argv, **kwargs)

    monkeypatch.setattr(JsonlPeer, "start", classmethod(recording_start))

    async def scenario() -> None:
        sdk = await SdkProbe.start(
            resolve_launch("fake", protocol="sdk", env={}),
            cwd=tmp_path,
            provider="deepseek",
            model="deepseek-chat",
            child_env=child_env,
        )
        await sdk.close()
        acp = await AcpProbe.start(
            resolve_launch("fake", protocol="acp", env={}),
            cwd=tmp_path,
            child_env=child_env,
        )
        await acp.close()

    asyncio.run(scenario())
    assert observed == [child_env, child_env]


def test_source_cli_routes_to_real_probe_instead_of_rejecting_source(
    monkeypatch, tmp_path: Path
) -> None:
    from protocol_labs.launch import resolve_launch
    from protocol_labs.sdk_jsonrpc import __main__ as sdk_main

    launch = replace(
        resolve_launch("fake", protocol="sdk", env={}),
        mode="source",
        source_evidence={"trackedClean": True, "conforming": True, "mismatches": []},
    )
    observed: dict[str, object] = {}

    class FakeProbe:
        server_info = {"name": "source", "version": "0.0.1"}
        process_group_id = 12345

        async def prompt(self, prompt: str, *, timeout: float):
            observed["prompt"] = prompt
            observed["timeout"] = timeout
            return {
                "committedAnswer": "source answer",
                "receiptMatched": True,
                "settlement": "receipt-to-root-idle",
                "diagnostics": [],
            }

        async def close(self):
            observed["closed"] = True
            return _close_outcome(
                shutdown_succeeded=True,
                diagnostics=({"kind": "post_close_diagnostic"},),
            )

    async def fake_start(*args, **kwargs):
        observed["child_env"] = kwargs["child_env"]
        observed["provider"] = kwargs["provider"]
        return FakeProbe()

    monkeypatch.setattr(sdk_main, "resolve_launch", lambda *args, **kwargs: launch)
    monkeypatch.setattr(sdk_main.SdkProbe, "start", fake_start)
    group_states = iter((True, False))
    monkeypatch.setattr(sdk_main, "process_group_exists", lambda _group: next(group_states))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "private-key")
    monkeypatch.setenv("DSH_SOURCE_ROOT", str(tmp_path))

    evidence = asyncio.run(sdk_main._run("source"))

    assert evidence["mode"] == "source"
    assert evidence["sourceEvidence"]["conforming"] is True
    assert evidence["liveAcceptance"] is True
    assert evidence["committedAnswer"] == "source answer"
    assert evidence["processGroup"] == {"runningDuringProbe": True, "reapedAfterClose": True}
    assert evidence["closeOutcome"] == {
        "returncode": 0,
        "shutdownRequestSucceeded": True,
        "eofExitedCleanly": True,
        "escalationSignal": None,
        "groupGone": True,
        "diagnostics": [{"kind": "post_close_diagnostic"}],
    }
    assert evidence["diagnostics"] == [{"kind": "post_close_diagnostic"}]
    assert observed["timeout"] >= 60
    assert observed["closed"] is True
    assert observed["provider"] == "deepseek-official"
    assert "DEEPSEEK_API_KEY" in observed["child_env"]


def test_acp_source_cli_runs_one_live_prompt_without_fake_scenarios(
    monkeypatch, tmp_path: Path
) -> None:
    from protocol_labs.acp import __main__ as acp_main
    from protocol_labs.launch import resolve_launch

    launch = replace(
        resolve_launch("fake", protocol="acp", env={}),
        mode="source",
        source_evidence={"trackedClean": True, "conforming": True, "mismatches": []},
    )
    prompt_calls: list[object] = []

    class FakeProbe:
        agent_info = {"name": "source", "version": "0.0.1"}
        agent_capabilities = {"promptCapabilities": {}}
        auth_methods = []
        process_group_id = 12346

        async def prompt(self, prompt, *, timeout: float):
            prompt_calls.append(prompt)
            return {
                "committedAnswer": "source answer",
                "committedChunks": ["source answer"],
                "stopReason": "end_turn",
                "settlement": "committed-to-end-turn",
                "diagnostics": [],
            }

        async def close(self):
            return _close_outcome(shutdown_succeeded=None)

    async def fake_start(*args, **kwargs):
        return FakeProbe()

    monkeypatch.setattr(acp_main, "resolve_launch", lambda *args, **kwargs: launch)
    monkeypatch.setattr(acp_main.AcpProbe, "start", fake_start)
    group_states = iter((True, False))
    monkeypatch.setattr(acp_main, "process_group_exists", lambda _group: next(group_states))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "private-key")
    monkeypatch.setenv("DSH_SOURCE_ROOT", str(tmp_path))

    evidence = asyncio.run(acp_main._run("source"))

    assert len(prompt_calls) == 1
    assert evidence["stopReason"] == "end_turn"
    assert evidence["committedAnswer"] == "source answer"
    assert evidence["processGroup"]["reapedAfterClose"] is True
    assert evidence["closeOutcome"]["shutdownRequestSucceeded"] is None
    assert evidence["liveAcceptance"] is True


def test_sdk_command_mode_uses_one_generic_prompt_and_identity(monkeypatch) -> None:
    from protocol_labs.launch import resolve_launch
    from protocol_labs.sdk_jsonrpc import __main__ as sdk_main

    launch = replace(resolve_launch("fake", protocol="sdk", env={}), mode="command")
    observed: dict[str, object] = {}

    class FakeProbe:
        server_info = {"name": "command", "version": "0.0.1"}
        process_group_id = 12347

        async def prompt(self, prompt: str, *, timeout: float):
            observed["prompt"] = prompt
            return {
                "committedAnswer": "command answer",
                "receiptMatched": True,
                "settlement": "receipt-to-root-idle",
                "diagnostics": [],
            }

        async def close(self):
            return _close_outcome(shutdown_succeeded=True)

    async def fake_start(*args, **kwargs):
        observed.update(kwargs)
        return FakeProbe()

    monkeypatch.setattr(sdk_main, "resolve_launch", lambda *args, **kwargs: launch)
    monkeypatch.setattr(sdk_main.SdkProbe, "start", fake_start)
    group_states = iter((True, False))
    monkeypatch.setattr(sdk_main, "process_group_exists", lambda _group: next(group_states))

    evidence = asyncio.run(sdk_main._run("command"))

    assert observed["provider"] == "deepseek-official"
    assert observed["model"] == "deepseek-v4-flash"
    assert observed["prompt"] == sdk_main.GENERIC_PROMPT
    assert observed["child_env"] is None
    assert evidence["committedAnswer"] == "command answer"
    assert "transcript" not in evidence


def test_acp_command_mode_runs_only_one_generic_prompt(monkeypatch) -> None:
    from protocol_labs.acp import __main__ as acp_main
    from protocol_labs.launch import resolve_launch

    launch = replace(resolve_launch("fake", protocol="acp", env={}), mode="command")
    calls: list[str] = []

    class FakeProbe:
        agent_info = {"name": "command", "version": "0.0.1"}
        agent_capabilities = {"promptCapabilities": {}}
        auth_methods = []
        process_group_id = 12348

        async def prompt(self, prompt, *, timeout: float):
            calls.append("prompt")
            assert prompt == acp_main.GENERIC_PROMPT
            return {
                "committedAnswer": "command answer",
                "committedChunks": ["command answer"],
                "stopReason": "end_turn",
                "settlement": "committed-to-end-turn",
                "diagnostics": [],
            }

        async def cancel_prompt(self):
            calls.append("cancel")

        async def close(self):
            return _close_outcome(shutdown_succeeded=None)

    async def fake_start(*args, **kwargs):
        return FakeProbe()

    monkeypatch.setattr(acp_main, "resolve_launch", lambda *args, **kwargs: launch)
    monkeypatch.setattr(acp_main.AcpProbe, "start", fake_start)
    group_states = iter((True, False))
    monkeypatch.setattr(acp_main, "process_group_exists", lambda _group: next(group_states))

    evidence = asyncio.run(acp_main._run("command"))

    assert calls == ["prompt"]
    assert evidence["committedAnswer"] == "command answer"
    assert "fixture" not in evidence and "permission" not in evidence


def test_source_mismatch_mode_runs_but_cannot_satisfy_live_acceptance(
    monkeypatch, tmp_path: Path
) -> None:
    from protocol_labs.launch import resolve_launch
    from protocol_labs.sdk_jsonrpc import __main__ as sdk_main

    launch = replace(
        resolve_launch("fake", protocol="sdk", env={}),
        mode="source",
        source_evidence={
            "trackedClean": True,
            "conforming": False,
            "mismatches": [{"field": "head", "expected": "expected", "actual": "actual"}],
        },
    )

    class FakeProbe:
        server_info = {"name": "source", "version": "0.0.1"}
        process_group_id = 12349

        async def prompt(self, prompt: str, *, timeout: float):
            return {
                "committedAnswer": "learning answer",
                "receiptMatched": True,
                "settlement": "receipt-to-root-idle",
                "diagnostics": [],
            }

        async def close(self):
            return _close_outcome(shutdown_succeeded=True)

    async def fake_start(*args, **kwargs):
        return FakeProbe()

    monkeypatch.setattr(sdk_main, "resolve_launch", lambda *args, **kwargs: launch)
    monkeypatch.setattr(sdk_main.SdkProbe, "start", fake_start)
    group_states = iter((True, False))
    monkeypatch.setattr(sdk_main, "process_group_exists", lambda _group: next(group_states))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "private-key")
    monkeypatch.setenv("DSH_SOURCE_ROOT", str(tmp_path))

    evidence = asyncio.run(sdk_main._run("source", allow_version_mismatch=True))

    assert evidence["committedAnswer"] == "learning answer"
    assert evidence["sourceEvidence"]["conforming"] is False
    assert evidence["sourceEvidence"]["mismatches"]
    assert evidence["liveAcceptance"] is False


@pytest.mark.parametrize(
    "close_outcome",
    [
        _close_outcome(shutdown_succeeded=False),
        _close_outcome(shutdown_succeeded=True, returncode=23),
        _close_outcome(shutdown_succeeded=True, returncode=-15, escalation_signal="SIGTERM"),
    ],
)
def test_conforming_sdk_source_rejects_any_close_contract_failure(
    monkeypatch, tmp_path: Path, close_outcome
) -> None:
    from protocol_labs.launch import resolve_launch
    from protocol_labs.sdk_jsonrpc import __main__ as sdk_main

    launch = replace(
        resolve_launch("fake", protocol="sdk", env={}),
        mode="source",
        source_evidence={"trackedClean": True, "conforming": True, "mismatches": []},
    )

    class FakeProbe:
        server_info = {"name": "source", "version": "0.0.1"}
        process_group_id = 12350

        async def prompt(self, prompt: str, *, timeout: float):
            return {
                "committedAnswer": "answer",
                "receiptMatched": True,
                "settlement": "receipt-to-root-idle",
                "diagnostics": [],
            }

        async def close(self):
            return close_outcome

    async def fake_start(*args, **kwargs):
        return FakeProbe()

    monkeypatch.setattr(sdk_main, "resolve_launch", lambda *args, **kwargs: launch)
    monkeypatch.setattr(sdk_main.SdkProbe, "start", fake_start)
    group_states = iter((True, False))
    monkeypatch.setattr(sdk_main, "process_group_exists", lambda _group: next(group_states))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "private-key")
    monkeypatch.setenv("DSH_SOURCE_ROOT", str(tmp_path))

    with pytest.raises(RuntimeError, match="live evidence contract"):
        asyncio.run(sdk_main._run("source"))
