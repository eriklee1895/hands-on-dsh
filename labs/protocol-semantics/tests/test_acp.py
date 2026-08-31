import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from protocol_labs.jsonl_peer import JsonlPeer, JsonRpcError, PeerExitedError
from protocol_labs.launch import resolve_launch

PROJECT_ROOT = Path(__file__).parents[1]


def _fixture_transcript() -> list[dict[str, object]]:
    return [
        json.loads(line)
        for line in (PROJECT_ROOT / "fixtures" / "committed-answer.jsonl").read_text().splitlines()
    ]


def test_acp_probe_performs_exact_handshake_and_normalizes_committed_chunks(
    tmp_path: Path,
) -> None:
    from protocol_labs.acp.probe import AcpProbe

    async def scenario() -> None:
        probe = await AcpProbe.start(resolve_launch("fake", protocol="acp", env={}), cwd=tmp_path)
        try:
            evidence = await probe.prompt([{"type": "text", "text": "fixture prompt"}])
        finally:
            await probe.close()

        assert probe.agent_info == {
            "name": "dsh-acp-lab-fake",
            "version": "0.0.1",
        }
        assert probe.agent_capabilities == {
            "promptCapabilities": {
                "image": False,
                "audio": False,
                "embeddedContext": False,
            }
        }
        assert probe.auth_methods == []
        assert probe.session_id == "acp-session-1"
        assert evidence == {
            "sessionId": "acp-session-1",
            "committedChunks": ["fixture ", "answer"],
            "committedAnswer": "fixture answer",
            "stopReason": "end_turn",
            "settlement": "committed-to-end-turn",
            "transcript": _fixture_transcript(),
            "permissionRequests": [],
            "diagnostics": [],
        }
        with pytest.raises(ProcessLookupError):
            os.killpg(probe.process_group_id, 0)

    asyncio.run(scenario())


def test_acp_probe_preserves_capable_agent_booleans_and_requires_empty_auth_methods() -> None:
    from protocol_labs.acp.probe import AcpProbe

    result = {
        "protocolVersion": 1,
        "agentInfo": {"name": "capable-agent", "version": "1.2.3"},
        "agentCapabilities": {
            "promptCapabilities": {
                "image": True,
                "audio": False,
                "embeddedContext": False,
            }
        },
        "authMethods": [],
    }

    agent_info, capabilities, auth_methods = AcpProbe._validate_initialize(result)

    assert agent_info == {"name": "capable-agent", "version": "1.2.3"}
    assert capabilities == result["agentCapabilities"]
    assert auth_methods == []

    invalid_results = [
        {**result, "authMethods": [{"id": "unexpected"}]},
        {**result, "protocolVersion": True},
        {
            **result,
            "agentCapabilities": {"promptCapabilities": {"image": True, "audio": False}},
        },
        {
            **result,
            "agentCapabilities": {
                "promptCapabilities": {
                    "image": 1,
                    "audio": False,
                    "embeddedContext": False,
                }
            },
        },
    ]
    for invalid in invalid_results:
        with pytest.raises(RuntimeError):
            AcpProbe._validate_initialize(invalid)


async def _initialize_raw_peer(tmp_path: Path) -> tuple[JsonlPeer, str]:
    peer = await JsonlPeer.start(resolve_launch("fake", protocol="acp", env={}).argv)
    initialized = await peer.request("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
    assert initialized["protocolVersion"] == 1
    assert await peer.request("authenticate", {"methodId": "unused"}) == {}
    created = await peer.request("session/new", {"cwd": str(tmp_path), "mcpServers": []})
    return peer, created["sessionId"]


def test_acp_cancel_waits_for_committed_readiness_then_settles_cancelled(
    tmp_path: Path,
) -> None:
    from protocol_labs.acp.probe import AcpProbe

    async def scenario() -> None:
        probe = await AcpProbe.start(resolve_launch("fake", protocol="acp", env={}), cwd=tmp_path)
        try:
            evidence = await probe.cancel_prompt(timeout=0.5)
        finally:
            await probe.close()

        assert evidence["committedChunks"] == ["ready to cancel"]
        assert evidence["committedAnswer"] == "ready to cancel"
        assert evidence["stopReason"] == "cancelled"
        assert evidence["settlement"] == "committed-to-cancelled"
        assert evidence["cancelSentAfterReadiness"] is True
        assert evidence["transcript"] is None

    asyncio.run(scenario())


def test_acp_fake_allows_one_inflight_prompt_and_unknown_session_cancel_is_noop(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        peer, session_id = await _initialize_raw_peer(tmp_path)
        held: asyncio.Task[object] | None = None
        try:
            held = asyncio.create_task(
                peer.request(
                    "session/prompt",
                    {
                        "sessionId": session_id,
                        "prompt": [{"type": "text", "text": "lab:cancel"}],
                    },
                    request_id=100,
                )
            )
            readiness = await peer.next_notification(timeout=0.5)
            assert readiness == {
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "ready to cancel"},
                    },
                },
            }
            with pytest.raises(JsonRpcError) as duplicate:
                await peer.request(
                    "session/prompt",
                    {
                        "sessionId": session_id,
                        "prompt": [{"type": "text", "text": "fixture prompt"}],
                    },
                    request_id=101,
                )
            assert duplicate.value.code == -32602

            await peer.notify("session/cancel", {"sessionId": "missing-session"})
            await asyncio.sleep(0.01)
            assert not held.done()
            await peer.notify("session/cancel", {"sessionId": session_id})
            assert await asyncio.wait_for(held, timeout=0.5) == {"stopReason": "cancelled"}

            with pytest.raises(JsonRpcError) as unknown:
                await peer.request(
                    "session/prompt",
                    {
                        "sessionId": "missing-session",
                        "prompt": [{"type": "text", "text": "fixture prompt"}],
                    },
                )
            assert unknown.value.code == -32602
        finally:
            if held is not None and not held.done():
                held.cancel()
                await asyncio.gather(held, return_exceptions=True)
            await peer.close()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("decision", "expected_response", "expected_answer"),
    [
        (
            "allow-once",
            {"outcome": {"outcome": "selected", "optionId": "allow-once"}},
            "fixture answer",
        ),
        (
            "reject-once",
            {"outcome": {"outcome": "selected", "optionId": "reject-once"}},
            "permission denied",
        ),
        ("cancel", {"outcome": {"outcome": "cancelled"}}, "permission denied"),
        (
            "unknown",
            {"outcome": {"outcome": "selected", "optionId": "missing-option"}},
            "permission denied",
        ),
        (
            "error",
            {"error": {"code": -32603, "message": "permission decision unavailable"}},
            "permission unavailable",
        ),
    ],
)
def test_acp_permission_maps_literal_outcomes_and_fail_closed(
    tmp_path: Path,
    decision: str,
    expected_response: dict[str, object],
    expected_answer: str,
) -> None:
    from protocol_labs.acp.probe import AcpProbe

    async def scenario() -> None:
        probe = await AcpProbe.start(
            resolve_launch("fake", protocol="acp", env={}),
            cwd=tmp_path,
            permission_decision=decision,
        )
        try:
            evidence = await probe.prompt(
                [{"type": "text", "text": "lab:permission"}], request_id=0
            )
        finally:
            await probe.close()

        assert evidence["permissionRequests"] == [
            {
                "method": "session/request_permission",
                "params": {
                    "sessionId": "acp-session-1",
                    "toolCall": {"toolCallId": "call-1"},
                    "options": [
                        {
                            "optionId": "allow-once",
                            "name": "Allow once",
                            "kind": "allow_once",
                        },
                        {
                            "optionId": "reject-once",
                            "name": "Reject",
                            "kind": "reject_once",
                        },
                    ],
                },
            }
        ]
        assert evidence["permissionResponses"] == [expected_response]
        assert evidence["committedAnswer"] == expected_answer
        assert evidence["stopReason"] == "end_turn"
        assert not any(item["kind"] == "unknown_response_id" for item in evidence["diagnostics"])
        if decision == "allow-once":
            assert evidence["transcript"] == [
                {
                    "kind": "user_message",
                    "content": [{"type": "text", "text": "lab:permission"}],
                },
                {
                    "kind": "assistant_message",
                    "content": [{"type": "text", "text": "fixture answer"}],
                },
                {"kind": "turn_end", "reason": {"kind": "completed"}},
            ]

    asyncio.run(scenario())


def test_acp_fake_treats_an_unknown_selected_option_as_rejected(tmp_path: Path) -> None:
    async def handle_permission(method: str, params: object) -> object:
        assert method == "session/request_permission"
        assert isinstance(params, dict)
        return {"outcome": {"outcome": "selected", "optionId": "missing-option"}}

    async def scenario() -> None:
        peer = await JsonlPeer.start(
            resolve_launch("fake", protocol="acp", env={}).argv,
            request_handler=handle_permission,
        )
        try:
            await peer.request("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
            await peer.request("authenticate", {"methodId": "unused"})
            created = await peer.request("session/new", {"cwd": str(tmp_path), "mcpServers": []})
            result = await peer.request(
                "session/prompt",
                {
                    "sessionId": created["sessionId"],
                    "prompt": [{"type": "text", "text": "lab:permission"}],
                },
                request_id=0,
            )
            update = await peer.next_notification(timeout=0.5)
        finally:
            await peer.close()

        assert result == {"stopReason": "end_turn"}
        assert update["params"]["update"]["content"] == {
            "type": "text",
            "text": "permission denied",
        }

    asyncio.run(scenario())


def test_acp_fake_does_not_correlate_boolean_response_id_with_numeric_zero(
    tmp_path: Path,
) -> None:
    async def write_frame(process: asyncio.subprocess.Process, frame: dict[str, object]) -> None:
        assert process.stdin is not None
        process.stdin.write(json.dumps(frame, separators=(",", ":")).encode() + b"\n")
        await process.stdin.drain()

    async def read_frame(process: asyncio.subprocess.Process) -> dict[str, object]:
        assert process.stdout is not None
        return json.loads(await process.stdout.readline())

    async def scenario() -> None:
        spec = resolve_launch("fake", protocol="acp", env={})
        process = await asyncio.create_subprocess_exec(
            *spec.argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            await write_frame(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {"protocolVersion": 1, "clientCapabilities": {}},
                },
            )
            await read_frame(process)
            await write_frame(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "authenticate",
                    "params": {"methodId": "unused"},
                },
            )
            await read_frame(process)
            await write_frame(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "session/new",
                    "params": {"cwd": str(tmp_path), "mcpServers": []},
                },
            )
            created = await read_frame(process)
            session_id = created["result"]["sessionId"]
            await write_frame(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 0,
                    "method": "session/prompt",
                    "params": {
                        "sessionId": session_id,
                        "prompt": [{"type": "text", "text": "lab:permission"}],
                    },
                },
            )
            permission = await read_frame(process)
            assert permission["id"] == 0
            await write_frame(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": False,
                    "result": {"outcome": {"outcome": "selected", "optionId": "allow-once"}},
                },
            )
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(read_frame(process), timeout=0.02)
            await write_frame(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 0,
                    "result": {"outcome": {"outcome": "selected", "optionId": "reject-once"}},
                },
            )
            update = await asyncio.wait_for(read_frame(process), timeout=0.5)
            response = await asyncio.wait_for(read_frame(process), timeout=0.5)
            assert update["params"]["update"]["content"]["text"] == "permission denied"
            assert response == {
                "jsonrpc": "2.0",
                "id": 0,
                "result": {"stopReason": "end_turn"},
            }
        finally:
            assert process.stdin is not None
            process.stdin.close()
            await process.wait()

    asyncio.run(scenario())


def test_acp_uses_method_not_found_invalid_params_and_internal_error_codes(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        peer = await JsonlPeer.start(resolve_launch("fake", protocol="acp", env={}).argv)
        try:
            for requested_version in (0, 1.0, 2, -7):
                initialized = await peer.request(
                    "initialize",
                    {"protocolVersion": requested_version, "clientCapabilities": {}},
                )
                assert initialized["protocolVersion"] == 1
            for invalid_version in (True, 1.5, "1", None):
                with pytest.raises(JsonRpcError) as invalid_initialize:
                    await peer.request(
                        "initialize",
                        {"protocolVersion": invalid_version, "clientCapabilities": {}},
                    )
                assert invalid_initialize.value.code == -32602

            with pytest.raises(JsonRpcError) as unknown:
                await peer.request("unknown/method", {})
            assert unknown.value.code == -32601
            await peer.request("authenticate", {"methodId": "unused"})
            with pytest.raises(JsonRpcError) as invalid_new:
                await peer.request("session/new", {"cwd": "relative", "mcpServers": []})
            assert invalid_new.value.code == -32602
            created = await peer.request("session/new", {"cwd": str(tmp_path), "mcpServers": []})
            with pytest.raises(JsonRpcError) as internal:
                await peer.request(
                    "session/prompt",
                    {
                        "sessionId": created["sessionId"],
                        "prompt": [{"type": "text", "text": "lab:internal-error"}],
                    },
                )
            assert internal.value.code == -32603
        finally:
            await peer.close()

    asyncio.run(scenario())


def test_acp_malformed_notification_is_diagnostic_and_ordered_blocks_continue(
    tmp_path: Path,
) -> None:
    from protocol_labs.acp.probe import AcpProbe

    async def scenario() -> None:
        probe = await AcpProbe.start(resolve_launch("fake", protocol="acp", env={}), cwd=tmp_path)
        try:
            evidence = await probe.prompt(
                [
                    {"type": "text", "text": "lab:"},
                    {"type": "text", "text": "malformed"},
                ]
            )
        finally:
            await probe.close()

        assert evidence["committedChunks"] == ["fixture ", "answer"]
        assert evidence["transcript"][0] == {
            "kind": "user_message",
            "content": [
                {"type": "text", "text": "lab:"},
                {"type": "text", "text": "malformed"},
            ],
        }
        assert evidence["diagnostics"] == [{"kind": "malformed_session_update"}]

    asyncio.run(scenario())


def test_acp_timeout_removes_only_waiter_and_close_reaps_held_server_work(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        peer, session_id = await _initialize_raw_peer(tmp_path)
        group_id = peer.process_group_id
        try:
            with pytest.raises(asyncio.TimeoutError):
                await peer.request(
                    "session/prompt",
                    {
                        "sessionId": session_id,
                        "prompt": [{"type": "text", "text": "lab:timeout"}],
                    },
                    timeout=0.02,
                )
            with pytest.raises(JsonRpcError) as still_active:
                await peer.request(
                    "session/prompt",
                    {
                        "sessionId": session_id,
                        "prompt": [{"type": "text", "text": "fixture prompt"}],
                    },
                )
            assert still_active.value.code == -32602
        finally:
            await peer.close(grace_period=0.2)
        with pytest.raises(ProcessLookupError):
            os.killpg(group_id, 0)

    asyncio.run(scenario())


def test_acp_close_trigger_rejects_pending_prompt_with_exit_context(tmp_path: Path) -> None:
    async def scenario() -> None:
        peer, session_id = await _initialize_raw_peer(tmp_path)
        try:
            with pytest.raises(PeerExitedError, match="fake requested close") as raised:
                await peer.request(
                    "session/prompt",
                    {
                        "sessionId": session_id,
                        "prompt": [{"type": "text", "text": "lab:close"}],
                    },
                )
            assert raised.value.context_final is False
        finally:
            await peer.close()
        assert peer.returncode == 23
        assert peer.stderr_text == "fake requested close"

    asyncio.run(scenario())


def test_acp_cli_prints_sanitized_fixture_cancel_and_permission_evidence() -> None:
    marker = "must-not-appear-acp-secret"
    env = dict(os.environ)
    env["ACP_LAB_SECRET_MARKER"] = marker
    completed = subprocess.run(
        [sys.executable, "-m", "protocol_labs.acp", "--server", "fake"],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    output = json.loads(completed.stdout)
    assert output["mode"] == "fake"
    assert output["versionEvidence"]["acpProtocolVersion"] == 1
    assert output["fixture"]["transcript"] == _fixture_transcript()
    assert output["cancellation"]["stopReason"] == "cancelled"
    assert output["permission"]["permissionResponses"] == [
        {"outcome": {"outcome": "selected", "optionId": "allow-once"}}
    ]
    assert output["diagnostics"] == []
    assert marker not in completed.stdout
    assert "/Users/" not in completed.stdout
