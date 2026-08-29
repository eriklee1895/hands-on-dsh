"""Own one DSH subprocess and bridge its synchronous callbacks into asyncio."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from deepseek_harness import DeepSeekHarness, Notification

from .events import BrowserEvent, project_notification
from .models import RunOutput


class RuntimeService:
    """Application runtime with per-session serialization and cross-session concurrency."""

    def __init__(self, harness: Any | None = None) -> None:
        self._workspace = Path(os.environ.get("DSH_FASTAPI_WORKSPACE", "workspace")).resolve()
        self._session_root = Path(os.environ.get("DSH_FASTAPI_SESSION_ROOT", ".sessions")).resolve()
        self._harness = harness
        self._started = False
        self._locks: dict[str, asyncio.Lock] = {}
        self._sessions: set[str] = set()
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def started(self) -> bool:
        """Whether the owned runtime completed startup."""
        return self._started

    async def start(self) -> None:
        """Start and initialize the runtime without blocking the ASGI event loop."""
        if self._started:
            return
        self._workspace.mkdir(parents=True, exist_ok=True)
        self._session_root.mkdir(parents=True, exist_ok=True)
        if self._harness is None:
            self._harness = DeepSeekHarness(
                provider=os.environ.get("DSH_PROVIDER", "deepseek-official"),
                model=os.environ.get("DSH_MODEL", "deepseek-v4-flash"),
                cwd=str(self._workspace),
                session_root=str(self._session_root),
            )
        await asyncio.to_thread(self._harness.start)
        self._started = True

    async def close(self) -> None:
        """Wait for admitted runs, then close and reap the runtime process."""
        if self._tasks:
            await asyncio.gather(*tuple(self._tasks), return_exceptions=True)
        if self._started:
            assert self._harness is not None
            await asyncio.to_thread(self._harness.close)
            self._started = False

    async def run(self, prompt: str, session_id: str) -> RunOutput:
        """Run one activity interval and return its final projection."""
        result = await self._execute(prompt, session_id)
        return RunOutput(
            session_id=result.session_id,
            response=result.final_response,
            finish_reason=result.finish_reason,
        )

    async def stream(self, prompt: str, session_id: str) -> AsyncIterator[BrowserEvent]:
        """Yield projected notifications and one terminal final or error event."""
        if not self._started:
            raise RuntimeError("runtime service is not started")
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[BrowserEvent] = asyncio.Queue(maxsize=256)

        def offer(event: BrowserEvent) -> None:
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
            except BaseException as exc:
                offer(BrowserEvent(
                    type="error",
                    session_id=session_id,
                    data={"message": str(exc) or type(exc).__name__},
                ))
            else:
                offer(BrowserEvent(
                    type="final",
                    session_id=session_id,
                    data={
                        "response": result.final_response,
                        "finish_reason": result.finish_reason,
                    },
                ))

        task = asyncio.create_task(execute(), name=f"dsh-run-{session_id}")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        while True:
            event = await queue.get()
            yield event
            if event.type in {"final", "error"}:
                break

    def session_ids(self) -> list[str]:
        """Return session IDs admitted since this service instance started."""
        return sorted(self._sessions)

    async def _execute(
        self,
        prompt: str,
        session_id: str,
        on_notification: Any | None = None,
    ) -> Any:
        if not self._started:
            raise RuntimeError("runtime service is not started")
        self._sessions.add(session_id)
        lock = self._locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            assert self._harness is not None
            session = self._harness.start_session(session_id)
            return await asyncio.to_thread(
                session.run,
                prompt,
                on_notification=on_notification,
            )
