"""Capability-aware adapters over the existing DSH SDK and ACP probes."""

from __future__ import annotations

import asyncio
import math
import os
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TypeVar

from protocol_labs.acp.probe import AcpProbe
from protocol_labs.jsonl_peer import JsonRpcError, PeerExitedError
from protocol_labs.launch import resolve_launch
from protocol_labs.live import build_live_child_env, process_group_exists
from protocol_labs.owned_state import OwnedState
from protocol_labs.sdk_jsonrpc.probe import SdkProbe

_T = TypeVar("_T")
_CAPABILITIES = (
    "prompt",
    "process_close",
    "session_close",
    "resume",
    "cancel",
    "token_stream",
    "permission",
)


class UnsupportedCapability(RuntimeError):
    """The selected protocol has no supported implementation of this operation."""


class AdapterStateError(RuntimeError):
    """An operation cannot be admitted in the adapter's current state."""


class AdapterExecutionError(RuntimeError):
    """A request may have executed remotely, so this adapter never retries it."""

    def __init__(self, kind: str) -> None:
        super().__init__(f"adapter execution failed: {kind}")
        self.kind = kind
        self.may_have_executed = True


@dataclass(frozen=True)
class AdapterResult:
    """Committed protocol evidence with no raw diagnostic or provider error text."""

    engine: str
    protocol: str
    status: str
    text: str | None
    session_id: str
    settlement: str
    native: dict[str, object]
    tool_events: int


def describe_adapter(engine: str, protocol: str) -> dict[str, object]:
    """Describe this lab's integration status, not an unintegrated engine's abilities."""

    if engine not in {"dsh", "codex", "hermes"}:
        raise ValueError("unknown adapter engine")
    if engine != "dsh":
        expected = "exec-jsonl" if engine == "codex" else "chat-stream-json"
        if protocol != expected:
            raise ValueError("unknown adapter protocol")
        return {
            "engine": engine,
            "protocol": protocol,
            "integration": "integrated",
            "capabilities": {
                "prompt": "supported",
                "process_close": "supported",
                "session_close": "not-integrated",
                "resume": "not-integrated",
                "cancel": "not-integrated",
                "token_stream": "not-integrated",
                "permission": "not-integrated",
            },
        }
    if protocol not in {"sdk", "acp"}:
        raise ValueError("unknown adapter protocol")
    capabilities = {
        "prompt": "supported",
        "process_close": "supported",
        "session_close": "supported" if protocol == "acp" else "unsupported",
        "resume": "supported" if protocol == "acp" else "unsupported",
        "cancel": "probe-only" if protocol == "acp" else "unsupported",
        "token_stream": "unsupported",
        "permission": "probe-only" if protocol == "acp" else "unsupported",
    }
    return {
        "engine": engine,
        "protocol": protocol,
        "integration": "integrated",
        "capabilities": capabilities,
    }


def _execution_error(error: Exception) -> AdapterExecutionError:
    if isinstance(error, asyncio.TimeoutError):
        return AdapterExecutionError("timeout")
    if isinstance(error, PeerExitedError):
        return AdapterExecutionError("peer-exited")
    if isinstance(error, JsonRpcError):
        return AdapterExecutionError("rpc-error")
    return AdapterExecutionError("invalid-result")


def _timeout(value: float | None, default: float) -> float:
    if value is None:
        return default
    if type(value) not in {int, float} or not math.isfinite(value) or not 0 < value <= 3600:
        raise ValueError("adapter prompt timeout must be finite and within 0..3600 seconds")
    return float(value)


class Adapter:
    """Own one probe, prompt operation and shielded process close."""

    def __init__(
        self,
        protocol: str,
        server: str,
        state: OwnedState,
        probe: SdkProbe | AcpProbe,
    ) -> None:
        self.engine = "dsh"
        self.protocol = "sdk-jsonrpc" if protocol == "sdk" else "acp"
        self._kind = protocol
        self._server = server
        self._state = state
        self._probe = probe
        self._workspace = state.root / "workspace"
        self.state = "open"
        self._session_open = True
        self._operation: asyncio.Task[object] | None = None
        self._close_task: asyncio.Task[dict[str, object]] | None = None

    @property
    def state_root(self) -> Path:
        """Disposable state path, retained if process cleanup is unconfirmed."""

        return self._state.root

    def _admit(self) -> None:
        if self.state != "open":
            raise AdapterStateError(f"adapter is {self.state}")

    async def _execute(self, action: Callable[[], Awaitable[_T]]) -> _T:
        self._admit()
        self.state = "busy"

        async def owned() -> _T:
            try:
                return await action()
            except Exception as error:
                raise _execution_error(error) from None

        task = asyncio.create_task(owned())
        self._operation = task

        def settled(done: asyncio.Task[_T]) -> None:
            failed = done.cancelled() or done.exception() is not None
            if self.state == "busy":
                self.state = "faulted" if failed else "open"

        task.add_done_callback(settled)
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            if self.state in {"busy", "open"}:
                self.state = "faulted"
            raise

    async def prompt(self, text: str, timeout: float | None = None) -> AdapterResult:
        """Run one prompt with native settlement and no automatic retry."""

        if type(text) is not str or not text:
            raise ValueError("adapter prompt text must be nonempty")
        limit = _timeout(timeout, 1 if self._server == "fake" else 300)
        if not self._session_open:
            raise AdapterStateError("ACP session is closed")

        async def action() -> AdapterResult:
            if self._kind == "sdk":
                assert isinstance(self._probe, SdkProbe)
                evidence = await self._probe.prompt(text, timeout=limit)
                reason = evidence["rootTurnEndReason"]
                safe_reason = (
                    reason
                    if reason
                    in {
                        "completed",
                        "aborted",
                        "error",
                        "max-tokens",
                        "refusal",
                        "blocked",
                        "forked",
                    }
                    else "unknown"
                )
                completed = (
                    evidence["receiptMatched"] is True
                    and evidence["completedTurnObserved"] is True
                    and safe_reason == "completed"
                )
                return AdapterResult(
                    engine="dsh",
                    protocol=self.protocol,
                    status="completed" if completed else "incomplete",
                    text=evidence["committedAnswer"],
                    session_id="root",
                    settlement=evidence["settlement"],
                    native={
                        "receiptMatched": evidence["receiptMatched"],
                        "rootTurnEndReason": safe_reason,
                        "completedTurnObserved": evidence["completedTurnObserved"],
                    },
                    tool_events=evidence["rootToolCalls"],
                )
            assert isinstance(self._probe, AcpProbe)
            evidence = await self._probe.prompt([{"type": "text", "text": text}], timeout=limit)
            return self._acp_result(evidence)

        return await self._execute(action)

    def _acp_result(self, evidence: dict[str, object]) -> AdapterResult:
        reason = evidence["stopReason"]
        status = {"end_turn": "settled", "cancelled": "cancelled", "max_tokens": "incomplete"}[
            reason
        ]
        return AdapterResult(
            engine="dsh",
            protocol="acp",
            status=status,
            text=evidence["committedAnswer"],
            session_id=self._probe.session_id,
            settlement=evidence["settlement"],
            native={"stopReason": reason},
            tool_events=evidence["toolUpdates"],
        )

    async def close_session(self) -> dict[str, object]:
        """Close an ACP session without closing its transport."""

        if self._kind != "acp":
            raise UnsupportedCapability("SDK has no session close")
        if not self._session_open:
            raise AdapterStateError("ACP session is already closed")

        async def action() -> dict[str, object]:
            assert isinstance(self._probe, AcpProbe)
            await self._probe.close_session()
            self._session_open = False
            return {"session_id": self._probe.session_id, "closed": True}

        return await self._execute(action)

    async def resume(self) -> dict[str, object]:
        """Resume the same ACP session at its existing workspace."""

        if self._kind != "acp":
            raise UnsupportedCapability("SDK has no session resume")
        if self._session_open:
            raise AdapterStateError("ACP session must be closed before resume")

        async def action() -> dict[str, object]:
            assert isinstance(self._probe, AcpProbe)
            await self._probe.resume_session(self._workspace)
            historical = await self._probe.historical_replay_count()
            self._session_open = True
            return {
                "session_id": self._probe.session_id,
                "resumed": True,
                "history_updates": historical,
            }

        return await self._execute(action)

    async def cancel_probe(self) -> AdapterResult:
        """Run only the ACP fake peer's deterministic cancellation fixture."""

        if self._kind != "acp" or self._server != "fake":
            raise UnsupportedCapability("cancellation is available only as an ACP fake probe")
        if not self._session_open:
            raise AdapterStateError("ACP session is closed")

        async def action() -> AdapterResult:
            assert isinstance(self._probe, AcpProbe)
            evidence = await self._probe.cancel_prompt()
            return self._acp_result(evidence)

        return await self._execute(action)

    async def close(self) -> dict[str, object]:
        """Close admission, await owned work, and share shielded process cleanup."""

        if self._close_task is None:
            self.state = "closing"
            self._close_task = asyncio.create_task(self._close_owned())
        return await asyncio.shield(self._close_task)

    async def _close_owned(self) -> dict[str, object]:
        operation = self._operation
        if operation is not None:
            # The prompt outcome belongs to its caller; close still owns process cleanup.
            with suppress(Exception, asyncio.CancelledError):
                await asyncio.shield(operation)
        try:
            outcome = await self._probe.close()
            group_absent = not process_group_exists(self._probe.process_group_id)
            self._state.confirm_closed("adapter", outcome, group_absent=group_absent)
            group_gone = outcome.group_gone and group_absent
            if group_gone:
                self._state.cleanup_if_confirmed()
                self.state = "closed"
            else:
                self.state = "faulted"
            return {
                "group_gone": group_gone,
                "returncode": outcome.returncode,
                "escalation_signal": outcome.escalation_signal,
                "native_clean_exit": outcome.eof_exited_cleanly
                and (self._kind != "sdk" or outcome.shutdown_request_succeeded is True),
                "state_removed": not self._state.root.exists(),
            }
        except BaseException:
            self.state = "faulted"
            raise


async def open_adapter(protocol: str, server: str) -> Adapter:
    """Open one pinned DSH probe after validating configuration before state creation."""

    if protocol not in {"sdk", "acp"}:
        raise ValueError("adapter protocol must be sdk or acp")
    if server not in {"fake", "package"}:
        raise ValueError("adapter server must be fake or package")
    if server == "package" and not os.environ.get("DEEPSEEK_API_KEY", "").strip():
        raise ValueError("package adapter requires a provider key")
    preflight = resolve_launch(
        server,
        protocol=protocol,
        isolated_cwd=Path.cwd() if server == "package" else None,
    )
    state = OwnedState.create(prefix=f"{protocol}-adapter-", owner_ids={"adapter"})
    workspace = state.root / "workspace"
    launch = replace(preflight, cwd=workspace) if server == "package" else preflight
    child_env = (
        build_live_child_env(
            os.environ,
            home=state.root / "home",
            dsh_home=state.root / "dsh-home",
        )
        if server == "package"
        else None
    )
    probe: SdkProbe | AcpProbe | None = None
    try:
        if protocol == "sdk":
            probe = await SdkProbe.start(
                launch,
                cwd=workspace,
                provider="deepseek" if server == "fake" else "deepseek-official",
                model="deepseek-chat" if server == "fake" else "deepseek-flash",
                child_env=child_env,
                startup_timeout=1 if server == "fake" else 120,
            )
        else:
            probe = await AcpProbe.start(
                launch,
                cwd=workspace,
                permission_decision="reject-once",
                child_env=child_env,
                startup_timeout=1 if server == "fake" else 120,
            )
            if server == "package":
                await probe.select_advertised_model()
        return Adapter(protocol, server, state, probe)
    except BaseException:
        if probe is not None:
            outcome = await asyncio.shield(probe.close())
            state.confirm_closed(
                "adapter", outcome, group_absent=not process_group_exists(probe.process_group_id)
            )
            state.cleanup_if_confirmed()
        raise
