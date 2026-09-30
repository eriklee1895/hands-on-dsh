"""Capability-aware wrappers over the existing fake SDK and ACP peers."""

from __future__ import annotations

import asyncio
import traceback

import pytest


def test_capabilities_identify_integration_and_protocol_limits() -> None:
    from protocol_labs.adapters import describe_adapter

    sdk = describe_adapter("dsh", "sdk")
    acp = describe_adapter("dsh", "acp")
    assert sdk["integration"] == acp["integration"] == "integrated"
    assert sdk["capabilities"]["resume"] == "unsupported"
    assert sdk["capabilities"]["cancel"] == "unsupported"
    assert acp["capabilities"]["resume"] == "supported"
    assert acp["capabilities"]["cancel"] == "probe-only"
    assert acp["capabilities"]["permission"] == "probe-only"
    assert sdk["capabilities"]["token_stream"] == "unsupported"
    for engine in ("codex", "hermes"):
        assert describe_adapter(engine, "acp")["integration"] == "not-integrated"
    with pytest.raises(ValueError):
        describe_adapter("unknown", "acp")


@pytest.mark.parametrize("protocol", ["sdk", "acp"])
def test_fake_adapter_returns_committed_result_and_owned_close(protocol: str) -> None:
    from protocol_labs.adapters import open_adapter

    async def scenario() -> None:
        adapter = await open_adapter(protocol, "fake")
        assert adapter.state == "open"
        try:
            result = await adapter.prompt("fixture prompt")
            assert result.engine == "dsh"
            assert result.protocol == ("sdk-jsonrpc" if protocol == "sdk" else "acp")
            assert result.status == ("completed" if protocol == "sdk" else "settled")
            assert result.text == "fixture answer"
            assert result.session_id
            assert result.tool_events == 0
            assert "diagnostics" not in result.native
        finally:
            closed = await adapter.close()
        assert closed["group_gone"] is True
        assert closed["native_clean_exit"] is True
        assert closed["state_removed"] is True
        assert adapter.state == "closed"

    asyncio.run(scenario())


def test_sdk_extension_methods_fail_before_wire_and_leave_prompt_usable() -> None:
    from protocol_labs.adapters import UnsupportedCapability, open_adapter

    async def scenario() -> None:
        adapter = await open_adapter("sdk", "fake")
        try:
            for operation in (adapter.close_session, adapter.resume, adapter.cancel_probe):
                with pytest.raises(UnsupportedCapability):
                    await operation()
            assert (await adapter.prompt("fixture prompt")).status == "completed"
        finally:
            await adapter.close()

    asyncio.run(scenario())


def test_acp_fake_session_close_resume_and_probe_only_cancel() -> None:
    from protocol_labs.adapters import open_adapter

    async def scenario() -> None:
        adapter = await open_adapter("acp", "fake")
        try:
            closed_session = await adapter.close_session()
            resumed = await adapter.resume()
            assert closed_session["session_id"] == resumed["session_id"]
            assert resumed["history_updates"] == 0
            cancelled = await adapter.cancel_probe()
            assert cancelled.status == "cancelled"
            assert cancelled.native["stopReason"] == "cancelled"
            assert adapter.state == "open"
        finally:
            await adapter.close()

    asyncio.run(scenario())


def test_acp_max_tokens_is_incomplete_not_business_completed() -> None:
    from protocol_labs.adapters import open_adapter

    async def scenario() -> None:
        adapter = await open_adapter("acp", "fake")
        try:

            async def shortened(_prompt: object, *, timeout: float) -> dict[str, object]:
                return {
                    "stopReason": "max_tokens",
                    "committedAnswer": "partial",
                    "settlement": "committed-to-max-tokens",
                    "toolUpdates": 0,
                }

            adapter._probe.prompt = shortened
            result = await adapter.prompt("fixture prompt")
            assert result.status == "incomplete"
            assert result.native == {"stopReason": "max_tokens"}
        finally:
            await adapter.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("protocol", ["sdk", "acp"])
def test_busy_rejects_second_prompt_and_timeout_faults_adapter(protocol: str) -> None:
    from protocol_labs.adapters import AdapterExecutionError, AdapterStateError, open_adapter

    async def scenario() -> None:
        adapter = await open_adapter(protocol, "fake")
        first = asyncio.create_task(adapter.prompt("lab:timeout", timeout=0.12))
        await asyncio.sleep(0.02)
        assert adapter.state == "busy"
        with pytest.raises(AdapterStateError):
            await adapter.prompt("fixture prompt")
        with pytest.raises(AdapterExecutionError) as failure:
            await first
        assert failure.value.kind == "timeout"
        assert failure.value.may_have_executed is True
        assert adapter.state == "faulted"
        with pytest.raises(AdapterStateError):
            await adapter.prompt("fixture prompt")
        assert (await adapter.close())["group_gone"] is True

    asyncio.run(scenario())


@pytest.mark.parametrize("protocol", ["sdk", "acp"])
@pytest.mark.parametrize(
    "prompt,kind", [("lab:internal-error", "rpc-error"), ("lab:close", "peer-exited")]
)
def test_peer_failures_fault_without_retry(protocol: str, prompt: str, kind: str) -> None:
    from protocol_labs.adapters import AdapterExecutionError, AdapterStateError, open_adapter

    async def scenario() -> None:
        adapter = await open_adapter(protocol, "fake")
        try:
            with pytest.raises(AdapterExecutionError) as failure:
                await adapter.prompt(prompt)
            assert failure.value.kind == kind
            assert failure.value.may_have_executed is True
            assert adapter.state == "faulted"
            with pytest.raises(AdapterStateError):
                await adapter.prompt("fixture prompt")
        finally:
            assert (await adapter.close())["group_gone"] is True

    asyncio.run(scenario())


def test_local_waiter_cancel_faults_but_close_waits_owned_operation() -> None:
    from protocol_labs.adapters import AdapterStateError, open_adapter

    async def scenario() -> None:
        adapter = await open_adapter("sdk", "fake")
        waiter = asyncio.create_task(adapter.prompt("lab:timeout", timeout=0.12))
        await asyncio.sleep(0.02)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert adapter.state == "faulted"
        with pytest.raises(AdapterStateError):
            await adapter.prompt("fixture prompt")
        assert (await adapter.close())["group_gone"] is True

    asyncio.run(scenario())


def test_cancel_at_owned_settlement_never_reopens_adapter() -> None:
    from protocol_labs.adapters import AdapterStateError, open_adapter

    async def scenario() -> None:
        adapter = await open_adapter("sdk", "fake")
        waiter = asyncio.create_task(adapter.prompt("fixture prompt"))
        while adapter._operation is None:
            await asyncio.sleep(0)
        adapter._operation.add_done_callback(lambda _done: waiter.cancel())
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert adapter.state == "faulted"
        with pytest.raises(AdapterStateError):
            await adapter.prompt("fixture prompt")
        assert (await adapter.close())["group_gone"] is True

    asyncio.run(scenario())


def test_native_reason_is_bounded_and_rpc_error_trace_omits_provider_text() -> None:
    from protocol_labs.adapters import AdapterExecutionError, open_adapter
    from protocol_labs.jsonl_peer import JsonRpcError

    async def scenario() -> None:
        adapter = await open_adapter("sdk", "fake")
        try:

            async def unexpected_reason(_text: str, *, timeout: float) -> dict[str, object]:
                return {
                    "receiptMatched": True,
                    "completedTurnObserved": False,
                    "committedAnswer": "partial",
                    "rootTurnEndReason": "PRIVATE_PROVIDER_TEXT",
                    "rootToolCalls": 0,
                    "settlement": "receipt-to-root-idle",
                }

            adapter._probe.prompt = unexpected_reason
            result = await adapter.prompt("fixture prompt")
            assert result.status == "incomplete"
            assert result.native["rootTurnEndReason"] == "unknown"

            async def provider_error(_text: str, *, timeout: float) -> dict[str, object]:
                raise JsonRpcError(-32603, "PRIVATE_PROVIDER_TEXT")

            adapter._probe.prompt = provider_error
            with pytest.raises(AdapterExecutionError) as failure:
                await adapter.prompt("fixture prompt")
            rendered = "".join(traceback.format_exception(failure.value))
            assert "PRIVATE_PROVIDER_TEXT" not in rendered
        finally:
            await adapter.close()

    asyncio.run(scenario())


def test_close_during_active_prompt_shares_shielded_cleanup() -> None:
    from protocol_labs.adapters import AdapterExecutionError, open_adapter

    async def scenario() -> None:
        adapter = await open_adapter("acp", "fake")
        waiter = asyncio.create_task(adapter.prompt("lab:timeout", timeout=0.12))
        await asyncio.sleep(0.02)
        first_close = asyncio.create_task(adapter.close())
        second_close = asyncio.create_task(adapter.close())
        first_close.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first_close
        with pytest.raises(AdapterExecutionError):
            await waiter
        closed = await second_close
        assert closed["group_gone"] is True
        assert adapter.state == "closed"

    asyncio.run(scenario())


def test_open_rejects_unversioned_server_before_state_creation() -> None:
    from protocol_labs.adapters import open_adapter

    async def scenario() -> None:
        with pytest.raises(ValueError):
            await open_adapter("sdk", "command")
        with pytest.raises(ValueError):
            await open_adapter("unknown", "fake")

    asyncio.run(scenario())
