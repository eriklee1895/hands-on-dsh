import asyncio
import os
import signal
import sys
from pathlib import Path

import pytest

from protocol_labs.jsonl_peer import (
    JsonlPeer,
    JsonRpcError,
    PeerExitedError,
    is_valid_jsonrpc_id,
)


def _write_server(tmp_path: Path, source: str) -> Path:
    path = tmp_path / "server.py"
    path.write_text(source)
    return path


def test_jsonrpc_ids_accept_strings_and_integral_numbers_but_not_bool_or_fraction() -> None:
    assert is_valid_jsonrpc_id("request")
    assert is_valid_jsonrpc_id(0)
    assert is_valid_jsonrpc_id(-2)
    assert is_valid_jsonrpc_id(2.0)
    assert not is_valid_jsonrpc_id("")
    assert not is_valid_jsonrpc_id(True)
    assert not is_valid_jsonrpc_id(1.5)
    assert not is_valid_jsonrpc_id(None)


def test_peer_launch_allows_empty_nonzero_arguments() -> None:
    async def scenario() -> None:
        peer = await JsonlPeer.start(
            [
                sys.executable,
                "-c",
                (
                    "import json,sys; request=json.loads(sys.stdin.readline()); "
                    "print(json.dumps({'jsonrpc':'2.0','id':request['id'],"
                    "'result':sys.argv[1]}), flush=True)"
                ),
                "",
            ]
        )
        assert await peer.request("work") == ""
        await peer.close()

    asyncio.run(scenario())


def test_peer_handles_fragmented_multiple_and_interleaved_frames(tmp_path: Path) -> None:
    server = _write_server(
        tmp_path,
        """
import json, os, sys
request = json.loads(sys.stdin.readline())
os.write(1, b'{\"jsonrpc\":\"2.0\",\"method\":\"notice\",')
os.write(1, b'\"params\":{\"position\":1}}\\n' + json.dumps({
    \"jsonrpc\": \"2.0\", \"id\": request[\"id\"], \"result\": {\"ok\": True}
}).encode() + b'\\n\\n')
""",
    )

    async def scenario() -> None:
        peer = await JsonlPeer.start([sys.executable, str(server)])
        result = await peer.request("work", {"value": 1})
        notification = await peer.next_notification(timeout=0.5)
        await peer.close()

        assert result == {"ok": True}
        assert notification == {"method": "notice", "params": {"position": 1}}
        assert any(item["kind"] == "blank_stdout_line" for item in peer.diagnostics)

    asyncio.run(scenario())


def test_integral_numeric_ids_correlate_across_json_number_serializations(tmp_path: Path) -> None:
    server = _write_server(
        tmp_path,
        """
import json, sys
request = json.loads(sys.stdin.readline())
assert request[\"id\"] == 2.0
print(json.dumps({\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"same-number\"}), flush=True)
""",
    )

    async def scenario() -> None:
        peer = await JsonlPeer.start([sys.executable, str(server)])
        assert await peer.request("work", request_id=2.0) == "same-number"
        await peer.close()

    asyncio.run(scenario())


def test_peer_drops_malformed_non_object_and_oversize_frames_then_continues(
    tmp_path: Path,
) -> None:
    server = _write_server(
        tmp_path,
        """
import json, os, sys
request = json.loads(sys.stdin.readline())
os.write(1, b'not-json\\n[]\\n' + b'x' * 257 + b'\\n')
os.write(1, json.dumps({
    \"jsonrpc\": \"2.0\", \"id\": request[\"id\"], \"result\": \"continued\"
}).encode() + b'\\n')
""",
    )

    async def scenario() -> None:
        peer = await JsonlPeer.start([sys.executable, str(server)], max_stdout_frame_bytes=256)
        assert await peer.request("work") == "continued"
        await peer.close()
        assert [item["kind"] for item in peer.diagnostics] == [
            "malformed_json",
            "non_object_frame",
            "stdout_frame_too_large",
        ]

    asyncio.run(scenario())


def test_peer_bounds_stderr_by_bytes_including_unfinished_line(tmp_path: Path) -> None:
    server = _write_server(
        tmp_path,
        """
import os, sys
os.write(2, b'A' * 80 + b'last-tail')
sys.stdin.readline()
""",
    )

    async def scenario() -> None:
        peer = await JsonlPeer.start([sys.executable, str(server)], max_stderr_bytes=16)
        await asyncio.sleep(0.05)
        await peer.close()
        assert peer.stderr_bytes == b"A" * 7 + b"last-tail"

    asyncio.run(scenario())


def test_inbound_handler_does_not_block_responses_and_direction_local_id_zero(
    tmp_path: Path,
) -> None:
    server = _write_server(
        tmp_path,
        """
import json, sys
outbound = json.loads(sys.stdin.readline())
print(json.dumps({\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"hold\",\"params\":{}}), flush=True)
print(json.dumps({\"jsonrpc\":\"2.0\",\"id\":outbound[\"id\"],\"result\":\"outbound-ok\"}), flush=True)
response = json.loads(sys.stdin.readline())
print(json.dumps({\"jsonrpc\":\"2.0\",\"method\":\"handler-result\",\"params\":response}), flush=True)
""",
    )

    async def scenario() -> None:
        release = asyncio.Event()

        async def handle(method: str, params: object) -> object:
            assert method == "hold"
            assert params == {}
            await release.wait()
            return "inbound-ok"

        peer = await JsonlPeer.start([sys.executable, str(server)], request_handler=handle)
        assert await peer.request("outbound", request_id=0) == "outbound-ok"
        release.set()
        notification = await peer.next_notification(timeout=0.5)
        await peer.close()
        assert notification["params"]["id"] == 0
        assert notification["params"]["result"] == "inbound-ok"

    asyncio.run(scenario())


def test_notification_subscriber_is_nonblocking_and_failures_become_diagnostics(
    tmp_path: Path,
) -> None:
    server = _write_server(
        tmp_path,
        """
import json, sys
notification = json.loads(sys.stdin.readline())
assert notification == {\"jsonrpc\":\"2.0\",\"method\":\"client-ready\",\"params\":{}}
request = json.loads(sys.stdin.readline())
print(json.dumps({\"jsonrpc\":\"2.0\",\"method\":\"notice\",\"params\":{\"ok\":True}}), flush=True)
print(json.dumps({\"jsonrpc\":\"2.0\",\"id\":request[\"id\"],\"result\":\"response-not-blocked\"}), flush=True)
sys.stdin.readline()
""",
    )

    async def scenario() -> None:
        release = asyncio.Event()
        entered = asyncio.Event()

        async def subscriber(notification: dict[str, object]) -> None:
            assert notification["method"] == "notice"
            entered.set()
            await release.wait()
            raise RuntimeError("subscriber failed")

        peer = await JsonlPeer.start([sys.executable, str(server)])
        dispose = peer.subscribe(subscriber)
        await peer.notify("client-ready", {})
        assert await peer.request("work") == "response-not-blocked"
        await asyncio.wait_for(entered.wait(), timeout=0.5)
        release.set()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        dispose()
        dispose()
        await peer.close()
        assert any(item["kind"] == "handler_task_failed" for item in peer.diagnostics)

    asyncio.run(scenario())


def test_request_timeout_removes_waiter_without_cancelling_server_work(
    tmp_path: Path,
) -> None:
    server = _write_server(
        tmp_path,
        """
import json, sys, time
request = json.loads(sys.stdin.readline())
time.sleep(0.08)
print(json.dumps({\"jsonrpc\":\"2.0\",\"id\":request[\"id\"],\"result\":\"late\"}), flush=True)
sys.stdin.readline()
""",
    )

    async def scenario() -> None:
        peer = await JsonlPeer.start([sys.executable, str(server)])
        with pytest.raises(asyncio.TimeoutError):
            await peer.request("slow", timeout=0.01)
        await asyncio.sleep(0.12)
        await peer.close()
        assert any(item["kind"] == "unknown_response_id" for item in peer.diagnostics)

    asyncio.run(scenario())


def test_error_and_eof_reject_requests_with_typed_context(tmp_path: Path) -> None:
    error_server = _write_server(
        tmp_path,
        """
import json, sys
request = json.loads(sys.stdin.readline())
print(json.dumps({\"jsonrpc\":\"2.0\",\"id\":request[\"id\"],\"error\":{\"code\":-32603,\"message\":\"boom\"}}), flush=True)
""",
    )

    async def error_scenario() -> None:
        peer = await JsonlPeer.start([sys.executable, str(error_server)])
        with pytest.raises(JsonRpcError, match="boom") as raised:
            await peer.request("explode")
        assert raised.value.code == -32603
        await peer.close()

    asyncio.run(error_scenario())

    close_server = _write_server(
        tmp_path,
        """
import os, sys
sys.stdin.readline()
os.write(2, b'closed-with-context')
raise SystemExit(23)
""",
    )

    async def close_scenario() -> None:
        peer = await JsonlPeer.start([sys.executable, str(close_server)])
        with pytest.raises(PeerExitedError, match="closed-with-context") as raised:
            await peer.request("pending")
        assert raised.value.context_final is False
        await peer.close()
        assert peer.returncode == 23
        assert peer.stderr_text == "closed-with-context"

    asyncio.run(close_scenario())


def test_stdout_eof_rejects_pending_before_a_still_live_process_exits(tmp_path: Path) -> None:
    server = _write_server(
        tmp_path,
        """
import os, sys, time
sys.stdin.readline()
os.close(1)
time.sleep(60)
""",
    )

    async def scenario() -> None:
        peer = await JsonlPeer.start([sys.executable, str(server)])
        try:
            with pytest.raises(PeerExitedError) as raised:
                await asyncio.wait_for(peer.request("pending"), timeout=0.3)
            assert raised.value.returncode is None
            assert raised.value.context_final is False
        finally:
            await peer.close(grace_period=0.05)
        assert peer.returncode is not None

    asyncio.run(scenario())


def test_stdout_eof_error_marks_partial_context_before_delayed_stderr_and_exit(
    tmp_path: Path,
) -> None:
    server = _write_server(
        tmp_path,
        """
import os, sys, time
sys.stdin.readline()
os.close(1)
time.sleep(0.05)
os.write(2, b'delayed-final-stderr')
raise SystemExit(23)
""",
    )

    async def scenario() -> None:
        peer = await JsonlPeer.start([sys.executable, str(server)])
        with pytest.raises(PeerExitedError) as raised:
            await asyncio.wait_for(peer.request("pending"), timeout=0.3)
        assert raised.value.context_final is False
        assert "delayed-final-stderr" not in raised.value.stderr

        await peer.close(grace_period=0.2)

        assert peer.returncode == 23
        assert peer.stderr_text == "delayed-final-stderr"

    asyncio.run(scenario())


def test_unterminated_final_stdout_frame_is_diagnosed_and_dropped(tmp_path: Path) -> None:
    server = _write_server(
        tmp_path,
        """
import json, os, sys
request = json.loads(sys.stdin.readline())
os.write(1, json.dumps({\"jsonrpc\":\"2.0\",\"id\":request[\"id\"],\"result\":\"must-drop\"}).encode())
""",
    )

    async def scenario() -> None:
        peer = await JsonlPeer.start([sys.executable, str(server)])
        with pytest.raises(PeerExitedError):
            await peer.request("pending")
        await peer.close()
        assert any(item["kind"] == "unterminated_stdout_frame" for item in peer.diagnostics)

    asyncio.run(scenario())


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group contract")
def test_close_is_idempotent_and_reaps_the_owned_process_group(tmp_path: Path) -> None:
    server = _write_server(
        tmp_path,
        """
import subprocess, sys, time
subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
while sys.stdin.readline():
    pass
time.sleep(60)
""",
    )

    async def scenario() -> None:
        peer = await JsonlPeer.start([sys.executable, str(server)])
        process_group = peer.process_group_id
        await asyncio.sleep(0.05)
        await asyncio.gather(peer.close(grace_period=0.05), peer.close(grace_period=0.05))
        with pytest.raises(ProcessLookupError):
            os.killpg(process_group, 0)

    asyncio.run(scenario())


def test_close_outcome_records_failed_shutdown_and_post_close_diagnostics(
    tmp_path: Path,
) -> None:
    server = _write_server(
        tmp_path,
        """
import json, sys
request = json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32603,"message":"shutdown failed"}}), flush=True)
for _line in sys.stdin:
    pass
""",
    )

    async def scenario() -> None:
        from protocol_labs.jsonl_peer import CloseOutcome

        peer = await JsonlPeer.start([sys.executable, str(server)])
        outcome = await peer.close(shutdown_method="shutdown")

        assert isinstance(outcome, CloseOutcome)
        assert outcome.returncode == 0
        assert outcome.shutdown_request_succeeded is False
        assert outcome.eof_exited_cleanly is True
        assert outcome.escalation_signal is None
        assert outcome.group_gone is True
        assert outcome.diagnostics == ({"kind": "shutdown_request_failed"},)
        assert await peer.close(shutdown_method="shutdown") is outcome

    asyncio.run(scenario())


def test_close_outcome_records_nonzero_eof_exit(tmp_path: Path) -> None:
    server = _write_server(
        tmp_path,
        """
import sys
sys.stdin.read()
raise SystemExit(23)
""",
    )

    async def scenario() -> None:
        peer = await JsonlPeer.start([sys.executable, str(server)])
        outcome = await peer.close()

        assert outcome.returncode == 23
        assert outcome.shutdown_request_succeeded is None
        assert outcome.eof_exited_cleanly is False
        assert outcome.escalation_signal is None
        assert outcome.group_gone is True

    asyncio.run(scenario())


def test_close_outcome_records_sigkill_escalation(tmp_path: Path) -> None:
    server = _write_server(
        tmp_path,
        """
import signal, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
sys.stdin.read()
time.sleep(60)
""",
    )

    async def scenario() -> None:
        peer = await JsonlPeer.start([sys.executable, str(server)])
        await asyncio.sleep(0.05)
        outcome = await peer.close(grace_period=0.05)

        assert outcome.returncode == -signal.SIGKILL
        assert outcome.eof_exited_cleanly is False
        assert outcome.escalation_signal == "SIGKILL"
        assert outcome.group_gone is True

    asyncio.run(scenario())
