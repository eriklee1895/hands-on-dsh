"""Narrow asynchronous runtime protocol and the DSH SDK implementation."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any, Protocol

from deepseek_harness import DeepSeekHarness, Notification

from .events import RuntimeEvent, project_notification

EmitEvent = Callable[[RuntimeEvent], Awaitable[None]]


@dataclass(frozen=True)
class RuntimeResult:
    """Normal result returned after the DSH activity interval becomes idle."""

    final_response: str
    finish_reason: str | None


class RuntimeUnavailableError(Exception):
    """Raised when the runtime cannot start before Session.run is invoked."""


class ExecutionUncertainError(Exception):
    """Raised after Session.run invocation when prompt acceptance cannot be disproved."""


class RuntimeAdapter(Protocol):
    """Execution surface required by the durable coordinator."""

    async def run(
        self,
        dsh_session_id: str,
        runtime_input: str,
        emit: EmitEvent,
    ) -> RuntimeResult:
        """Execute one activity interval and persist projected events through emit."""
        ...

    async def close(self) -> None:
        """Close all runtime resources after admitted work settles."""
        ...


class _SessionBoundaryError(Exception):
    def __init__(self, cause: BaseException) -> None:
        super().__init__(str(cause) or type(cause).__name__)
        self.cause = cause


class _SessionStartError(_SessionBoundaryError):
    pass


class _SessionRunError(_SessionBoundaryError):
    pass


class DSHRuntimeAdapter:
    """Lazily own one synchronous DeepSeekHarness behind an async interface."""

    def __init__(
        self,
        workspace: str | Path,
        session_root: str | Path,
        *,
        provider: str | None = None,
        model: str | None = None,
        harness_factory: Callable[..., Any] = DeepSeekHarness,
    ) -> None:
        self._workspace = Path(workspace)
        self._session_root = Path(session_root)
        self._harness_factory = harness_factory
        self._provider = provider
        self._model = model
        self._harness: Any | None = None
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="dsh-sdk")
        self._lifecycle_lock = asyncio.Lock()
        self._state = "new"

    async def run(
        self,
        dsh_session_id: str,
        runtime_input: str,
        emit: EmitEvent,
    ) -> RuntimeResult:
        """Start lazily, invoke Session.run in a thread, and preserve callback order."""
        async with self._lifecycle_lock:
            self._require_runnable()
            loop = asyncio.get_running_loop()
            try:
                await self._run_owned(self._prepare_paths)
                harness = await self._get_or_create_harness()
                if self._state == "new":
                    await self._run_owned(harness.start)
                    self._state = "ready"
            except Exception as error:
                if self._harness is not None:
                    self._state = "broken"
                    await self._reset_after_failure()
                raise RuntimeUnavailableError(str(error) or type(error).__name__) from error

            def on_notification(notification: Notification) -> None:
                event = project_notification(notification, dsh_session_id)
                if event is None:
                    return
                asyncio.run_coroutine_threadsafe(emit(event), loop).result()

            try:
                return await self._run_owned(
                    self._run_session,
                    harness,
                    dsh_session_id,
                    runtime_input,
                    on_notification,
                )
            except _SessionStartError as error:
                self._state = "broken"
                await self._reset_after_failure()
                raise RuntimeUnavailableError(str(error)) from error.cause
            except _SessionRunError as error:
                self._state = "broken"
                await self._reset_after_failure()
                raise ExecutionUncertainError(str(error)) from error.cause

    async def close(self) -> None:
        """Close terminally, retaining a failed harness so callers can retry cleanup."""
        async with self._lifecycle_lock:
            if self._state == "closed":
                return
            if self._harness is not None:
                self._state = "broken"
                try:
                    await self._run_owned(self._harness.close)
                except Exception:
                    raise
                else:
                    self._harness = None
            self._state = "closed"
            await asyncio.to_thread(self._executor.shutdown, True)

    def _prepare_paths(self) -> None:
        self._workspace.mkdir(parents=True, exist_ok=True)
        self._session_root.mkdir(parents=True, exist_ok=True)

    async def _get_or_create_harness(self) -> Any:
        if self._harness is None:
            configuration = {
                "cwd": str(self._workspace.resolve()),
                "session_root": str(self._session_root.resolve()),
            }
            if self._provider is not None:
                configuration["provider"] = self._provider
            if self._model is not None:
                configuration["model"] = self._model
            self._harness = await self._run_owned(
                self._harness_factory,
                **configuration,
            )
        return self._harness

    @staticmethod
    def _run_session(
        harness: Any,
        dsh_session_id: str,
        runtime_input: str,
        on_notification: Callable[[Notification], None],
    ) -> Any:
        try:
            session = harness.start_session(dsh_session_id)
        except BaseException as error:
            raise _SessionStartError(error) from error
        try:
            result = session.run(runtime_input, on_notification=on_notification)
            return RuntimeResult(
                final_response=result.final_response,
                finish_reason=result.finish_reason,
            )
        except BaseException as error:
            raise _SessionRunError(error) from error

    async def _reset_after_failure(self) -> None:
        harness = self._harness
        if harness is None:
            self._state = "new"
            return
        try:
            await self._run_owned(harness.close)
        except Exception:
            # The original runtime failure stays authoritative; explicit close can retry cleanup.
            return
        self._harness = None
        self._state = "new"

    async def _run_owned(self, function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, partial(function, *args, **kwargs))

    def _require_runnable(self) -> None:
        if self._state == "closed":
            raise RuntimeUnavailableError("runtime adapter is closed")
        if self._state == "broken":
            raise RuntimeUnavailableError("runtime adapter cleanup must succeed before reuse")
