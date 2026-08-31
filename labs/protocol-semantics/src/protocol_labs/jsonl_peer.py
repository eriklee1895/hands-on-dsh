"""Bidirectional JSONL JSON-RPC peer with owned child-process lifecycle."""

from __future__ import annotations

import asyncio
import inspect
import json
import math
import os
import signal
from collections import deque
from collections.abc import Awaitable, Callable, Sequence
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypeVar

JSONRPC_VERSION = "2.0"
DEFAULT_MAX_STDOUT_FRAME_BYTES = 4 * 1024 * 1024
DEFAULT_MAX_STDERR_BYTES = 64 * 1024
_PARAMS_OMITTED = object()
_T = TypeVar("_T")
RequestHandler = Callable[[str, object], Awaitable[object] | object]
NotificationHandler = Callable[[dict[str, object]], Awaitable[None] | None]
EscalationSignal = Literal["SIGTERM", "SIGKILL"]


@dataclass(frozen=True)
class CloseOutcome:
    """Final transport and owned-process-group shutdown evidence."""

    returncode: int
    shutdown_request_succeeded: bool | None
    eof_exited_cleanly: bool
    escalation_signal: EscalationSignal | None
    group_gone: bool
    diagnostics: tuple[dict[str, object], ...]

    def to_evidence(self) -> dict[str, object]:
        """Return JSON-safe close evidence with stable field names."""
        return {
            "returncode": self.returncode,
            "shutdownRequestSucceeded": self.shutdown_request_succeeded,
            "eofExitedCleanly": self.eof_exited_cleanly,
            "escalationSignal": self.escalation_signal,
            "groupGone": self.group_gone,
            "diagnostics": [dict(item) for item in self.diagnostics],
        }


class JsonRpcError(RuntimeError):
    """A JSON-RPC error response."""

    def __init__(self, code: int, message: str, data: object = None) -> None:
        """Create an error from JSON-RPC response fields.

        Args:
            code: JSON-RPC error code.
            message: Human-readable error description.
            data: Optional structured error context.
        """
        super().__init__(f"JSON-RPC error {code}: {message}")
        self.code = code
        self.message = message
        self.data = data


class PeerExitedError(RuntimeError):
    """The peer transport closed while requests were pending."""

    def __init__(
        self,
        returncode: int | None,
        stderr: str,
        *,
        context_final: bool = True,
    ) -> None:
        """Create a transport-close failure with partial or final process context.

        Args:
            returncode: Child process return code when available.
            stderr: Stderr tail available when the error is created.
            context_final: Whether process exit and stderr draining are complete.
        """
        context = "final process context" if context_final else "partial stdout-EOF context"
        detail = f"peer transport closed with {context}; return code {returncode}"
        if stderr:
            detail = f"{detail}; stderr tail: {stderr}"
        super().__init__(detail)
        self.returncode = returncode
        self.stderr = stderr
        self.context_final = context_final


def is_valid_jsonrpc_id(value: object) -> bool:
    """Return whether a value is a supported JSON-RPC identifier."""
    if isinstance(value, bool):
        return False
    if isinstance(value, str):
        return bool(value)
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value) and value.is_integer()


def _id_key(value: str | int | float) -> tuple[str, str | int]:
    if isinstance(value, str):
        return "string", value
    return "number", int(value)


async def _maybe_await(value: _T | Awaitable[_T]) -> _T:
    if inspect.isawaitable(value):
        return await value
    return value


class JsonlPeer:
    """Own a child process and exchange JSON-RPC frames over JSONL stdio."""

    def __init__(
        self,
        process: asyncio.subprocess.Process,
        *,
        max_stdout_frame_bytes: int,
        max_stderr_bytes: int,
        request_handler: RequestHandler | None,
    ) -> None:
        self._process = process
        self._max_stdout_frame_bytes = max_stdout_frame_bytes
        self._max_stderr_bytes = max_stderr_bytes
        self._request_handler = request_handler
        self._pending: dict[tuple[str, str | int], asyncio.Future[object]] = {}
        self._next_request_id = 0
        self._write_lock = asyncio.Lock()
        self._close_lock = asyncio.Lock()
        self._notifications: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self._subscribers: list[NotificationHandler] = []
        self._handler_tasks: set[asyncio.Task[None]] = set()
        self._stderr_tail: deque[int] = deque(maxlen=max_stderr_bytes)
        self._closed = False
        self._close_outcome: CloseOutcome | None = None
        self.diagnostics: list[dict[str, object]] = []
        self._stdout_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())

    @classmethod
    async def start(
        cls,
        argv: Sequence[str],
        *,
        cwd: str | Path | None = None,
        env: dict[str, str] | None = None,
        max_stdout_frame_bytes: int = DEFAULT_MAX_STDOUT_FRAME_BYTES,
        max_stderr_bytes: int = DEFAULT_MAX_STDERR_BYTES,
        request_handler: RequestHandler | None = None,
    ) -> JsonlPeer:
        """Start a peer process.

        Args:
            argv: Executable and arguments.
            cwd: Optional child working directory.
            env: Optional complete child environment.
            max_stdout_frame_bytes: Maximum accepted JSONL stdout frame size.
            max_stderr_bytes: Retained stderr tail size in bytes.
            request_handler: Handler for server-to-client requests.

        Returns:
            The started peer.
        """
        if os.name != "posix":
            raise RuntimeError("protocol labs require POSIX process-group support")
        if not argv or any(not isinstance(item, str) for item in argv) or not argv[0]:
            raise ValueError("argv must contain string arguments and a non-empty argv[0]")
        if max_stdout_frame_bytes <= 0 or max_stderr_bytes <= 0:
            raise ValueError("stream byte limits must be positive")
        process = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        return cls(
            process,
            max_stdout_frame_bytes=max_stdout_frame_bytes,
            max_stderr_bytes=max_stderr_bytes,
            request_handler=request_handler,
        )

    @property
    def process_group_id(self) -> int:
        """Return the POSIX process group owned by this peer."""
        return self._process.pid

    @property
    def returncode(self) -> int | None:
        """Return the child return code after process reaping, when available."""
        return self._process.returncode

    @property
    def stderr_bytes(self) -> bytes:
        """Return the retained byte-bounded stderr tail."""
        return bytes(self._stderr_tail)

    @property
    def stderr_text(self) -> str:
        """Return the retained stderr tail decoded without failure."""
        return self.stderr_bytes.decode("utf-8", errors="replace")

    @property
    def queued_notification_count(self) -> int:
        """Return notifications classified before the consumer starts draining."""
        return self._notifications.qsize()

    async def request(
        self,
        method: str,
        params: object = _PARAMS_OMITTED,
        *,
        timeout: float | None = None,
        request_id: str | int | float | None = None,
    ) -> object:
        """Send a request and await its direction-local response.

        Args:
            method: JSON-RPC method.
            params: Optional request parameters.
            timeout: Optional local waiter timeout in seconds.
            request_id: Explicit ID for protocol choreography tests.

        Returns:
            The response result.
        """
        if self._closed:
            raise RuntimeError("peer is closed")
        if not isinstance(method, str) or not method:
            raise ValueError("method must be a non-empty string")
        if request_id is None:
            request_id = self._next_request_id
            self._next_request_id += 1
        if not is_valid_jsonrpc_id(request_id):
            raise ValueError("request ID must be a non-empty string or integral number")
        key = _id_key(request_id)
        if key in self._pending:
            raise ValueError("request ID is already pending")
        waiter = asyncio.get_running_loop().create_future()
        self._pending[key] = waiter
        frame: dict[str, object] = {
            "jsonrpc": JSONRPC_VERSION,
            "id": request_id,
            "method": method,
        }
        if params is not _PARAMS_OMITTED:
            frame["params"] = params
        try:
            await self._write(frame)
            if timeout is None:
                return await waiter
            return await asyncio.wait_for(asyncio.shield(waiter), timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(key, None)
            waiter.cancel()
            raise
        except BaseException:
            self._pending.pop(key, None)
            if not waiter.done():
                waiter.cancel()
            raise

    async def notify(self, method: str, params: object = _PARAMS_OMITTED) -> None:
        """Send a JSON-RPC notification.

        Args:
            method: JSON-RPC method.
            params: Optional notification parameters.
        """
        frame: dict[str, object] = {"jsonrpc": JSONRPC_VERSION, "method": method}
        if params is not _PARAMS_OMITTED:
            frame["params"] = params
        await self._write(frame)

    async def next_notification(self, *, timeout: float | None = None) -> dict[str, object]:
        """Return the next queued notification.

        Args:
            timeout: Optional local wait timeout in seconds.

        Returns:
            A method/params notification without the JSON-RPC version field.
        """
        if timeout is None:
            return await self._notifications.get()
        return await asyncio.wait_for(self._notifications.get(), timeout=timeout)

    def subscribe(self, handler: NotificationHandler) -> Callable[[], None]:
        """Subscribe to notifications without consuming the queue.

        Args:
            handler: Callback scheduled independently by the reader.

        Returns:
            A disposer that removes the subscription.
        """
        self._subscribers.append(handler)

        def dispose() -> None:
            with suppress(ValueError):
                self._subscribers.remove(handler)

        return dispose

    async def close(
        self,
        *,
        shutdown_method: str | None = None,
        grace_period: float = 0.5,
    ) -> CloseOutcome:
        """Close stdio and reap the owned process group idempotently.

        Args:
            shutdown_method: Optional request attempted before stdin EOF.
            grace_period: Bounded wait for each shutdown phase.
        """
        async with self._close_lock:
            if self._close_outcome is not None:
                return self._close_outcome
            shutdown_request_succeeded: bool | None = None
            if shutdown_method is not None:
                shutdown_request_succeeded = False
            if shutdown_method is not None and self._process.returncode is None:
                try:
                    await self.request(shutdown_method, timeout=grace_period)
                except (asyncio.TimeoutError, JsonRpcError, PeerExitedError, RuntimeError):
                    self.diagnostics.append({"kind": "shutdown_request_failed"})
                else:
                    shutdown_request_succeeded = True
            elif shutdown_method is not None:
                self.diagnostics.append({"kind": "shutdown_request_failed"})
            self._closed = True
            stdin = self._process.stdin
            if stdin is not None:
                stdin.close()
                with suppress(BrokenPipeError, ConnectionResetError):
                    await stdin.wait_closed()
            escalation_signal = await self._reap_process_group(grace_period)
            for task in tuple(self._handler_tasks):
                task.cancel()
            if self._handler_tasks:
                await asyncio.gather(*self._handler_tasks, return_exceptions=True)
            await asyncio.gather(self._stdout_task, self._stderr_task, return_exceptions=True)
            returncode = self._process.returncode
            if returncode is None:
                raise RuntimeError("child process was not reaped")
            group_gone = not self._group_exists()
            self._close_outcome = CloseOutcome(
                returncode=returncode,
                shutdown_request_succeeded=shutdown_request_succeeded,
                eof_exited_cleanly=escalation_signal is None and returncode == 0,
                escalation_signal=escalation_signal,
                group_gone=group_gone,
                diagnostics=tuple(dict(item) for item in self.diagnostics),
            )
            return self._close_outcome

    async def _write(self, frame: dict[str, object]) -> None:
        stdin = self._process.stdin
        if stdin is None or stdin.is_closing():
            raise PeerExitedError(
                self._process.returncode,
                self.stderr_text,
                context_final=self._process.returncode is not None and self._stderr_task.done(),
            )
        payload = json.dumps(frame, separators=(",", ":"), ensure_ascii=False).encode()
        async with self._write_lock:
            try:
                stdin.write(payload + b"\n")
                await stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as error:
                raise PeerExitedError(
                    self._process.returncode,
                    self.stderr_text,
                    context_final=self._process.returncode is not None and self._stderr_task.done(),
                ) from error

    async def _read_stdout(self) -> None:
        stdout = self._process.stdout
        assert stdout is not None
        buffer = bytearray()
        dropping_oversize = False
        while True:
            chunk = await stdout.read(64 * 1024)
            if not chunk:
                break
            cursor = 0
            while cursor < len(chunk):
                newline = chunk.find(b"\n", cursor)
                if newline < 0:
                    if not dropping_oversize:
                        buffer.extend(chunk[cursor:])
                        if len(buffer) > self._max_stdout_frame_bytes:
                            self.diagnostics.append({"kind": "stdout_frame_too_large"})
                            buffer.clear()
                            dropping_oversize = True
                    break
                fragment = chunk[cursor:newline]
                cursor = newline + 1
                if dropping_oversize:
                    dropping_oversize = False
                    continue
                buffer.extend(fragment)
                if len(buffer) > self._max_stdout_frame_bytes:
                    self.diagnostics.append({"kind": "stdout_frame_too_large"})
                else:
                    self._classify_frame(bytes(buffer))
                buffer.clear()
        if buffer and not dropping_oversize:
            self.diagnostics.append({"kind": "unterminated_stdout_frame"})
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(self._stderr_task), timeout=0.01)
        self._reject_pending(
            PeerExitedError(
                self._process.returncode,
                self.stderr_text,
                context_final=False,
            )
        )
        returncode = await self._process.wait()
        await self._stderr_task
        self._reject_pending(PeerExitedError(returncode, self.stderr_text, context_final=True))

    async def _read_stderr(self) -> None:
        stderr = self._process.stderr
        assert stderr is not None
        while True:
            chunk = await stderr.read(16 * 1024)
            if not chunk:
                return
            self._stderr_tail.extend(chunk)

    def _classify_frame(self, raw: bytes) -> None:
        if not raw.strip():
            self.diagnostics.append({"kind": "blank_stdout_line"})
            return
        try:
            frame = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.diagnostics.append({"kind": "malformed_json"})
            return
        if not isinstance(frame, dict):
            self.diagnostics.append({"kind": "non_object_frame"})
            return
        method = frame.get("method")
        has_id = "id" in frame
        if isinstance(method, str) and method and has_id:
            request_id = frame["id"]
            if not is_valid_jsonrpc_id(request_id):
                self.diagnostics.append({"kind": "invalid_request_id"})
                return
            task = asyncio.create_task(
                self._handle_request(method, frame.get("params"), request_id)
            )
            self._track_handler(task)
            return
        if isinstance(method, str) and method and not has_id:
            notification = {"method": method, "params": frame.get("params")}
            self._notifications.put_nowait(notification)
            for subscriber in tuple(self._subscribers):
                task = asyncio.create_task(self._deliver_notification(subscriber, notification))
                self._track_handler(task)
            return
        if has_id and ("result" in frame or "error" in frame):
            self._resolve_response(frame)
            return
        self.diagnostics.append({"kind": "unusable_frame"})

    def _resolve_response(self, frame: dict[str, object]) -> None:
        request_id = frame["id"]
        if not is_valid_jsonrpc_id(request_id):
            self.diagnostics.append({"kind": "invalid_response_id"})
            return
        waiter = self._pending.pop(_id_key(request_id), None)
        if waiter is None:
            self.diagnostics.append({"kind": "unknown_response_id"})
            return
        error = frame.get("error")
        if error is not None:
            if not isinstance(error, dict):
                waiter.set_exception(JsonRpcError(-32603, "malformed error response"))
                return
            code = error.get("code")
            message = error.get("message")
            waiter.set_exception(
                JsonRpcError(
                    code if isinstance(code, int) and not isinstance(code, bool) else -32603,
                    message if isinstance(message, str) else "malformed error response",
                    error.get("data"),
                )
            )
            return
        waiter.set_result(frame.get("result"))

    async def _handle_request(
        self, method: str, params: object, request_id: str | int | float
    ) -> None:
        try:
            if self._request_handler is None:
                raise JsonRpcError(-32601, f"unknown method: {method}")
            result = await _maybe_await(self._request_handler(method, params))
            response: dict[str, object] = {
                "jsonrpc": JSONRPC_VERSION,
                "id": request_id,
                "result": result,
            }
        except asyncio.CancelledError:
            raise
        except JsonRpcError as error:
            response = {
                "jsonrpc": JSONRPC_VERSION,
                "id": request_id,
                "error": {
                    "code": error.code,
                    "message": error.message,
                    "data": error.data,
                },
            }
        except Exception as error:
            response = {
                "jsonrpc": JSONRPC_VERSION,
                "id": request_id,
                "error": {"code": -32603, "message": str(error)},
            }
        try:
            await self._write(response)
        except PeerExitedError:
            self.diagnostics.append({"kind": "inbound_response_write_failed"})

    async def _deliver_notification(
        self, handler: NotificationHandler, notification: dict[str, object]
    ) -> None:
        await _maybe_await(handler(notification))

    def _track_handler(self, task: asyncio.Task[None]) -> None:
        self._handler_tasks.add(task)
        task.add_done_callback(self._handler_finished)

    def _handler_finished(self, task: asyncio.Task[None]) -> None:
        self._handler_tasks.discard(task)
        if task.cancelled():
            return
        if task.exception() is not None:
            self.diagnostics.append({"kind": "handler_task_failed"})

    def _reject_pending(self, error: PeerExitedError) -> None:
        pending = tuple(self._pending.values())
        self._pending.clear()
        for waiter in pending:
            if not waiter.done():
                waiter.set_exception(error)

    async def _reap_process_group(self, grace_period: float) -> EscalationSignal | None:
        escalation_signal: EscalationSignal | None = None
        try:
            await asyncio.wait_for(self._process.wait(), timeout=grace_period)
        except asyncio.TimeoutError:
            escalation_signal = "SIGTERM"
            self._signal_group(signal.SIGTERM)
            try:
                await asyncio.wait_for(self._process.wait(), timeout=grace_period)
            except asyncio.TimeoutError:
                escalation_signal = "SIGKILL"
                self._signal_group(signal.SIGKILL)
                await self._process.wait()
        if self._group_exists():
            escalation_signal = "SIGTERM"
            self._signal_group(signal.SIGTERM)
            if not await self._wait_group_gone(grace_period):
                escalation_signal = "SIGKILL"
                self._signal_group(signal.SIGKILL)
                if not await self._wait_group_gone(grace_period):
                    raise RuntimeError("owned process group survived SIGKILL")
        return escalation_signal

    def _group_exists(self) -> bool:
        try:
            os.killpg(self.process_group_id, 0)
        except ProcessLookupError:
            return False
        return True

    def _signal_group(self, signal_number: signal.Signals) -> None:
        with suppress(ProcessLookupError):
            os.killpg(self.process_group_id, signal_number)

    async def _wait_group_gone(self, timeout: float) -> bool:
        deadline = asyncio.get_running_loop().time() + timeout
        while self._group_exists() and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.01)
        return not self._group_exists()
