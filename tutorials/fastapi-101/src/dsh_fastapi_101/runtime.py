"""Own one DSH subprocess and bridge its synchronous callbacks into asyncio."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Callable, Coroutine
from pathlib import Path
from typing import Any

from deepseek_harness import DeepSeekHarness, Notification

from .events import BrowserEvent, project_notification
from .models import RunOutput


class ServiceClosedError(RuntimeError):
    """The service cannot admit work after shutdown begins."""


class AgentRunFailed(RuntimeError):
    """The agent settled without a completed turn."""

    def __init__(self, finish_reason: str | None) -> None:
        self.finish_reason = finish_reason
        super().__init__(f"agent finished with {finish_reason or 'no turn outcome'}")


class RuntimeService:
    """Application runtime with per-session serialization and cross-session concurrency."""

    def __init__(self, harness: Any | None = None) -> None:
        self._workspace = Path(os.environ.get("DSH_FASTAPI_WORKSPACE", "workspace")).resolve()
        self._home = Path(os.environ.get("DSH_FASTAPI_HOME", ".dsh-fastapi-home")).resolve()
        self._harness = harness
        self._started = False
        self._closing = False
        self._locks: dict[str, asyncio.Lock] = {}
        self._sessions: set[str] = set()
        self._tasks: set[asyncio.Task[Any]] = set()
        self._startup_task: asyncio.Task[None] | None = None
        self._shutdown_task: asyncio.Task[None] | None = None

    @property
    def started(self) -> bool:
        """Whether the owned runtime completed startup."""
        return self._started

    async def start(self) -> None:
        """Initialize a public SDK profile and close its owner on startup failure."""
        if self._started:
            return
        if self._closing:
            raise ServiceClosedError("runtime service is closing")
        self._workspace.mkdir(parents=True, exist_ok=True)
        self._home.mkdir(parents=True, exist_ok=True)
        if self._harness is None:
            self._harness = DeepSeekHarness(
                provider=os.environ.get("DSH_PROVIDER", "deepseek-official"),
                model=os.environ.get("DSH_MODEL", "deepseek-v4-flash"),
                cwd=str(self._workspace),
                dsh_home=str(self._home),
                profile="sdk-minimal",
            )
        if self._startup_task is None:
            self._startup_task = asyncio.create_task(asyncio.to_thread(self._harness.start))
            self._startup_task.add_done_callback(self._observe_completion)
        try:
            await self._wait_owned(self._startup_task)
        except BaseException as startup_error:
            try:
                await self.close()
            except Exception as close_error:
                raise RuntimeError(
                    "runtime startup and cleanup failed: "
                    f"{type(startup_error).__name__}, {type(close_error).__name__}"
                ) from startup_error
            raise
        if self._closing:
            await self.close()
            raise ServiceClosedError("runtime service is closing")
        self._started = True

    async def close(self) -> None:
        """Stop admission, wait for JSON and SSE work, then reap the runtime."""
        self._closing = True
        if self._shutdown_task is None:
            self._shutdown_task = asyncio.create_task(self._drain_and_close())
            self._shutdown_task.add_done_callback(self._observe_completion)
        await asyncio.wait({self._shutdown_task})
        self._shutdown_task.result()

    async def _drain_and_close(self) -> None:
        """Finish owned startup and admitted workers before closing the SDK."""
        if self._startup_task is not None:
            await asyncio.wait({self._startup_task})
            self._observe_completion(self._startup_task)
        if self._tasks:
            await asyncio.wait(set(self._tasks))
        if self._harness is not None:
            await asyncio.to_thread(self._harness.close)
        self._started = False

    async def run(self, prompt: str, session_id: str) -> RunOutput:
        """Run one admitted interval; report unsuccessful turns as errors."""
        self._admit(session_id)
        task = self._track(self._execute(prompt, session_id))
        await asyncio.wait({task})
        result = task.result()
        return RunOutput(
            session_id=result.session_id,
            response=result.final_response,
            finish_reason=result.finish_reason,
        )

    def stream(self, prompt: str, session_id: str) -> AsyncIterator[BrowserEvent]:
        """Admit a run before headers, then yield notifications and one terminal event."""
        self._admit(session_id)
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[BrowserEvent] = asyncio.Queue(maxsize=256)
        terminal_queued = False

        def offer(event: BrowserEvent) -> None:
            nonlocal terminal_queued
            if terminal_queued:
                return
            if event.type in {"final", "error"}:
                terminal_queued = True
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(event)

        def on_notification(notification: Notification) -> None:
            event = project_notification(notification, session_id)
            if event is not None:
                loop.call_soon_threadsafe(offer, event)

        async def execute() -> None:
            try:
                result = await self._execute(prompt, session_id, on_notification)
            except AgentRunFailed as exc:
                offer(
                    BrowserEvent(
                        type="error",
                        session_id=session_id,
                        data={"message": str(exc), "finish_reason": exc.finish_reason},
                    )
                )
            except Exception:
                offer(
                    BrowserEvent(
                        type="error",
                        session_id=session_id,
                        data={"message": "Agent runtime failed", "finish_reason": None},
                    )
                )
            else:
                offer(
                    BrowserEvent(
                        type="final",
                        session_id=session_id,
                        data={
                            "response": result.final_response,
                            "finish_reason": result.finish_reason,
                        },
                    )
                )

        self._track(execute())

        async def events() -> AsyncIterator[BrowserEvent]:
            while True:
                event = await queue.get()
                yield event
                if event.type in {"final", "error"}:
                    break

        return events()

    def session_ids(self) -> list[str]:
        """Return session IDs admitted since this service instance started."""
        return sorted(self._sessions)

    def _admit(self, session_id: str) -> None:
        if self._closing:
            raise ServiceClosedError("runtime service is closing")
        if not self._started:
            raise ServiceClosedError("runtime service is not started")
        self._sessions.add(session_id)

    def _track(self, operation: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
        task = asyncio.create_task(operation)
        self._tasks.add(task)

        def finished(done: asyncio.Task[Any]) -> None:
            self._tasks.discard(done)
            self._observe_completion(done)

        task.add_done_callback(finished)
        return task

    @staticmethod
    def _observe_completion(done: asyncio.Future[Any]) -> None:
        if not done.cancelled():
            done.exception()

    @staticmethod
    async def _wait_owned(task: asyncio.Task[Any]) -> Any:
        try:
            await asyncio.wait({task})
        except asyncio.CancelledError:
            await asyncio.wait({task})
            raise
        return task.result()

    async def _execute(
        self,
        prompt: str,
        session_id: str,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> Any:
        lock = self._locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            assert self._harness is not None
            session = self._harness.start_session(session_id)
            result = await asyncio.to_thread(
                session.run,
                prompt,
                on_notification=on_notification,
            )
        if result.finish_reason != "completed":
            raise AgentRunFailed(result.finish_reason)
        return result
