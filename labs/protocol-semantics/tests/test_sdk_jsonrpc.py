import asyncio
import json
import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from protocol_labs.jsonl_peer import JsonlPeer, JsonRpcError, PeerExitedError
from protocol_labs.launch import resolve_launch

PROJECT_ROOT = Path(__file__).parents[1]
EXPECTED_TRANSCRIPT = [
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


def test_sdk_modules_exist_before_fake_and_probe_behavior() -> None:
    package = PROJECT_ROOT / "src" / "protocol_labs" / "sdk_jsonrpc"
    assert (package / "fake_server.py").is_file()
    assert (package / "probe.py").is_file()
    assert (package / "__main__.py").is_file()


def test_sdk_probe_correlates_receipt_then_root_idle_and_normalizes_committed_answer(
    tmp_path: Path,
) -> None:
    from protocol_labs.sdk_jsonrpc.probe import SdkProbe

    async def scenario() -> None:
        probe = await SdkProbe.start(
            resolve_launch("fake", protocol="sdk", env={}),
            cwd=tmp_path,
            provider="deepseek",
            model="deepseek-chat",
            max_tokens=4096,
        )
        process_group = probe.process_group_id
        try:
            evidence = await probe.prompt("fixture prompt")
        finally:
            await probe.close()

        assert evidence["serverInfo"] == {
            "name": "dsh-sdk-jsonrpc-lab-fake",
            "version": "0.0.1",
        }
        assert evidence["messageId"] == "message-1"
        assert evidence["bufferedBeforeResponse"] >= 2
        assert evidence["receiptMatched"] is True
        assert evidence["unmatchedReceiptsIgnored"] == 1
        assert evidence["settlement"] == "receipt-to-root-idle"
        assert evidence["staleRootIdleIgnored"] == 1
        assert evidence["staleRootEventsIgnored"] == 7
        assert evidence["rawTextDeltas"] == ["raw fixture answer"]
        assert evidence["committedAnswer"] == "fixture answer"
        assert evidence["transcript"] == EXPECTED_TRANSCRIPT
        assert evidence["descendantSessions"] == ["child-1"]
        assert evidence["descendantEventsObserved"] == 8
        assert evidence["subagentFinishedObserved"] == 1
        assert evidence["foreignEventsDiscarded"] == 1
        with pytest.raises(ProcessLookupError):
            os.killpg(process_group, 0)

    asyncio.run(scenario())


def test_sdk_fake_emits_exact_rc2_event_payloads(tmp_path: Path) -> None:
    async def scenario() -> None:
        spec = resolve_launch("fake", protocol="sdk", env={})
        peer = await JsonlPeer.start(spec.argv, cwd=spec.cwd)
        try:
            await peer.request(
                "initialize",
                {"cwd": str(tmp_path), "provider": "deepseek", "model": "deepseek-chat"},
            )
            response = await peer.request(
                "session/prompt",
                {
                    "sessionId": "root",
                    "contentBlocks": [{"type": "text", "text": "fixture prompt"}],
                },
            )
            notifications: list[dict[str, object]] = []
            matched = False
            while True:
                notification = await peer.next_notification(timeout=0.5)
                notifications.append(notification)
                params = notification["params"]
                if notification["method"] == "session.event":
                    event = params["event"]
                    if event["type"] == "agent/inbox/spliced" and any(
                        item["id"] == response["messageId"] for item in event["data"]["inserted"]
                    ):
                        matched = True
                if (
                    matched
                    and notification["method"] == "session.status"
                    and params == {"sessionId": "root", "status": "idle"}
                ):
                    break
        finally:
            await peer.close(shutdown_method="shutdown")

        expected = [
            json.loads(line)
            for line in (PROJECT_ROOT / "fixtures" / "sdk-jsonrpc-notifications.jsonl")
            .read_text()
            .splitlines()
        ]
        assert notifications == expected

        events_by_session = {
            session_id: [
                notification["params"]["event"]
                for notification in notifications
                if notification["method"] == "session.event"
                and notification["params"]["sessionId"] == session_id
            ]
            for session_id in ("root", "child-1")
        }
        root_events = events_by_session["root"]
        assert [event["seq"] for event in root_events] == list(range(len(root_events)))
        assert [event["type"] for event in root_events] == [
            "agent/inbox/spliced",
            "turn/start",
            "agent/inbox/spliced",
            "step/start",
            "user/message",
            "assistant/chunk",
            "assistant/message",
            "step/end",
            "turn/end",
            "agent/inbox/spliced",
            "turn/start",
            "agent/inbox/spliced",
            "step/start",
            "user/message",
            "assistant/chunk",
            "assistant/message",
            "step/end",
            "turn/end",
        ]
        child_events = events_by_session["child-1"]
        assert [event["seq"] for event in child_events] == list(range(6))
        assert [event["type"] for event in child_events] == [
            "turn/start",
            "step/start",
            "assistant/chunk",
            "assistant/message",
            "step/end",
            "turn/end",
        ]
        for session_events in events_by_session.values():
            for event in session_events:
                data = event["data"]
                if "turn" in data:
                    assert data["turn"] >= 1
                if "step" in data:
                    assert data["step"] >= 1
                if event["type"] == "assistant/message":
                    chunk_seq = event["sourceEventSeqs"][0]
                    chunk = next(item for item in session_events if item["seq"] == chunk_seq)
                    assert chunk["type"] == "assistant/chunk"
                    assert chunk["data"]["turn"] == data["turn"]
                    assert chunk["data"]["step"] == data["step"]
                    assert event["surfaceOp"] == "append"

    asyncio.run(scenario())


def test_sdk_probe_ignores_all_pre_receipt_lineage_activity(tmp_path: Path) -> None:
    from protocol_labs.sdk_jsonrpc.probe import SdkProbe

    server = tmp_path / "lineage_window_server.py"
    server.write_text(
        """
import json, sys

def write(frame):
    print(json.dumps(frame), flush=True)

def notify(method, params):
    write({"jsonrpc":"2.0","method":method,"params":params})

initialize = json.loads(sys.stdin.readline())
write({"jsonrpc":"2.0","id":initialize["id"],"result":{"serverInfo":{"name":"lineage-window","version":"0.0.1"}}})
prompt = json.loads(sys.stdin.readline())
notify("subagent.started", {"parentSessionId":"root","childSessionId":"stale-child"})
notify("session.event", {"sessionId":"stale-child","event":{"type":"turn/start","seq":0,"time":0,"data":{"turn":1}}})
notify("subagent.finished", {"provider":"fake","agentId":"stale-child","parentSessionId":"root","childSessionId":"stale-child","status":"ok","stopReason":"completed"})
notify("session.event", {"sessionId":"root","event":{"type":"agent/inbox/spliced","seq":0,"time":0,"data":{"target":"next-turn","start":0,"inserted":[{"id":"message-1","role":"user","content":[{"type":"text","text":"fixture prompt"}],"source":{"kind":"user"}}]}}})
write({"jsonrpc":"2.0","id":prompt["id"],"result":{"messageId":"message-1"}})
notify("subagent.started", {"parentSessionId":"root","childSessionId":"child-1"})
notify("session.event", {"sessionId":"child-1","event":{"type":"turn/start","seq":0,"time":0,"data":{"turn":1}}})
notify("subagent.finished", {"provider":"fake","agentId":"child-1","parentSessionId":"root","childSessionId":"child-1","status":"ok","stopReason":"completed"})
notify("session.status", {"sessionId":"root","status":"idle"})
shutdown = json.loads(sys.stdin.readline())
write({"jsonrpc":"2.0","id":shutdown["id"],"result":{}})
""",
    )

    async def scenario() -> None:
        probe = await SdkProbe.start(
            replace(
                resolve_launch("fake", protocol="sdk", env={}),
                argv=(sys.executable, str(server)),
            ),
            cwd=tmp_path,
            provider="deepseek",
            model="deepseek-chat",
        )
        try:
            evidence = await probe.prompt("fixture prompt")
        finally:
            await probe.close()

        assert evidence["descendantSessions"] == ["child-1"]
        assert evidence["descendantEventsObserved"] == 1
        assert evidence["subagentFinishedObserved"] == 1
        assert evidence["foreignEventsDiscarded"] == 0

    asyncio.run(scenario())


def test_sdk_probe_settles_without_treating_turn_end_as_prompt_result(tmp_path: Path) -> None:
    from protocol_labs.sdk_jsonrpc.probe import SdkProbe

    server = tmp_path / "idle_without_turn_end.py"
    server.write_text(
        """
import json, sys

def write(frame):
    print(json.dumps(frame), flush=True)

def notify(method, params):
    write({"jsonrpc":"2.0","method":method,"params":params})

initialize = json.loads(sys.stdin.readline())
write({"jsonrpc":"2.0","id":initialize["id"],"result":{"serverInfo":{"name":"idle-only","version":"0.0.1"}}})
prompt = json.loads(sys.stdin.readline())
notify("session.event", {"sessionId":"root","event":{"type":"agent/inbox/spliced","seq":0,"time":0,"data":{"target":"next-turn","start":0,"inserted":[{"id":"message-1","role":"user","content":[{"type":"text","text":"fixture prompt"}],"source":{"kind":"user"}}]}}})
write({"jsonrpc":"2.0","id":prompt["id"],"result":{"messageId":"message-1"}})
notify("session.event", {"sessionId":"root","event":{"type":"assistant/message","seq":1,"time":0,"data":{"turn":1,"step":1,"message":{"id":"assistant-1","role":"assistant","content":[{"type":"text","text":"fixture answer"}],"source":{"kind":"model","provider":"fake","model":"fake"}}}}})
notify("session.status", {"sessionId":"root","status":"idle"})
shutdown = json.loads(sys.stdin.readline())
write({"jsonrpc":"2.0","id":shutdown["id"],"result":{}})
""",
    )

    async def scenario() -> None:
        probe = await SdkProbe.start(
            replace(
                resolve_launch("fake", protocol="sdk", env={}),
                argv=(sys.executable, str(server)),
            ),
            cwd=tmp_path,
            provider="deepseek",
            model="deepseek-chat",
        )
        try:
            evidence = await probe.prompt("lab:no-turn-end")
        finally:
            await probe.close()

        assert evidence["receiptMatched"] is True
        assert evidence["settlement"] == "receipt-to-root-idle"
        assert evidence["committedAnswer"] == "fixture answer"
        assert evidence["completedTurnObserved"] is False
        assert evidence["transcript"] is None

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "server_info",
    [
        {"name": 7, "version": "0.0.1"},
        {"name": "fake", "version": None},
        {"name": "", "version": "0.0.1"},
        {"name": "fake", "version": ""},
    ],
)
def test_sdk_probe_rejects_non_string_or_empty_server_identity(
    tmp_path: Path, server_info: dict[str, object]
) -> None:
    from protocol_labs.sdk_jsonrpc.probe import SdkProbe

    server = tmp_path / "invalid_server_info.py"
    server.write_text(
        "\n".join(
            [
                "import json, sys",
                "request = json.loads(sys.stdin.readline())",
                f"print(json.dumps({{'jsonrpc':'2.0','id':request['id'],'result':{{'serverInfo':{server_info!r}}}}}), flush=True)",
                "sys.stdin.readline()",
                "",
            ]
        )
    )

    async def scenario() -> None:
        probe = None
        try:
            with pytest.raises(RuntimeError, match="serverInfo"):
                probe = await SdkProbe.start(
                    replace(
                        resolve_launch("fake", protocol="sdk", env={}),
                        argv=(sys.executable, str(server)),
                    ),
                    cwd=tmp_path,
                    provider="deepseek",
                    model="deepseek-chat",
                )
        finally:
            if probe is not None:
                await probe.close()

    asyncio.run(scenario())


def test_sdk_fake_consumes_and_reports_continuation_task_failures(tmp_path: Path) -> None:
    async def scenario() -> None:
        spec = resolve_launch("fake", protocol="sdk", env={})
        peer = await JsonlPeer.start(spec.argv, cwd=spec.cwd)
        await peer.request(
            "initialize",
            {"cwd": str(tmp_path), "provider": "deepseek", "model": "deepseek-chat"},
        )
        await peer.request(
            "session/prompt",
            {
                "sessionId": "root",
                "contentBlocks": [{"type": "text", "text": "lab:continuation-error"}],
            },
        )
        await asyncio.sleep(0.05)
        await peer.close(shutdown_method="shutdown")
        assert "fake continuation task failed: scripted continuation failure" in peer.stderr_text
        assert "Task exception was never retrieved" not in peer.stderr_text

    asyncio.run(scenario())


def test_sdk_fake_rejects_invalid_initialize_and_unknown_method_as_internal_error(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        spec = resolve_launch("fake", protocol="sdk", env={})
        peer = await JsonlPeer.start(spec.argv, cwd=spec.cwd)
        try:
            with pytest.raises(JsonRpcError) as invalid:
                await peer.request(
                    "initialize",
                    {
                        "cwd": "relative",
                        "provider": "deepseek",
                        "model": "deepseek-chat",
                    },
                )
            assert invalid.value.code == -32603
            with pytest.raises(JsonRpcError) as unknown:
                await peer.request("unknown/method", {})
            assert unknown.value.code == -32603
            with pytest.raises(JsonRpcError) as explicit_null:
                await peer.request("shutdown", None)
            assert explicit_null.value.code == -32603
        finally:
            await peer.close(shutdown_method="shutdown")

    asyncio.run(scenario())


def test_sdk_timeout_does_not_cancel_server_work_and_dispatcher_still_handles_shutdown(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        spec = resolve_launch("fake", protocol="sdk", env={})
        peer = await JsonlPeer.start(spec.argv, cwd=spec.cwd)
        await peer.request(
            "initialize",
            {"cwd": str(tmp_path), "provider": "deepseek", "model": "deepseek-chat"},
        )
        with pytest.raises(asyncio.TimeoutError):
            await peer.request(
                "session/prompt",
                {
                    "sessionId": "root",
                    "contentBlocks": [{"type": "text", "text": "lab:timeout"}],
                },
                timeout=0.02,
            )
        await peer.close(shutdown_method="shutdown", grace_period=0.2)
        assert not any(item["kind"] == "shutdown_request_failed" for item in peer.diagnostics)

    asyncio.run(scenario())


@pytest.mark.parametrize("prompt", ["lab:internal-error", "lab:close"])
def test_sdk_probe_surfaces_internal_error_or_process_exit(tmp_path: Path, prompt: str) -> None:
    from protocol_labs.sdk_jsonrpc.probe import SdkProbe

    async def scenario() -> None:
        probe = await SdkProbe.start(
            resolve_launch("fake", protocol="sdk", env={}),
            cwd=tmp_path,
            provider="deepseek",
            model="deepseek-chat",
        )
        try:
            expected = JsonRpcError if prompt == "lab:internal-error" else PeerExitedError
            with pytest.raises(expected) as raised:
                await probe.prompt(prompt, timeout=0.5)
            if isinstance(raised.value, JsonRpcError):
                assert raised.value.code == -32603
            else:
                assert raised.value.context_final is False
                assert "fake requested close" in raised.value.stderr
        finally:
            await probe.close()

    asyncio.run(scenario())


def test_sdk_malformed_line_is_diagnostic_and_normal_flow_continues(tmp_path: Path) -> None:
    from protocol_labs.sdk_jsonrpc.probe import SdkProbe

    async def scenario() -> None:
        probe = await SdkProbe.start(
            resolve_launch("fake", protocol="sdk", env={}),
            cwd=tmp_path,
            provider="deepseek",
            model="deepseek-chat",
        )
        try:
            evidence = await probe.prompt("lab:malformed")
            assert evidence["committedAnswer"] == "fixture answer"
            assert {item["kind"] for item in evidence["diagnostics"]} == {"malformed_json"}
        finally:
            await probe.close()

    asyncio.run(scenario())


def test_sdk_cli_prints_sanitized_json_without_secret_or_absolute_path() -> None:
    env = dict(os.environ)
    env["DEEPSEEK_API_KEY"] = "must-not-appear"
    completed = subprocess.run(
        [sys.executable, "-m", "protocol_labs.sdk_jsonrpc", "--server", "fake"],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )

    assert completed.returncode == 0, completed.stderr
    evidence = json.loads(completed.stdout)
    assert evidence["mode"] == "fake"
    assert evidence["transcript"] == EXPECTED_TRANSCRIPT
    assert evidence["settlement"] == "receipt-to-root-idle"
    assert "must-not-appear" not in completed.stdout
    assert str(PROJECT_ROOT) not in completed.stdout
