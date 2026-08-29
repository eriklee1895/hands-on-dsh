from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path
from types import SimpleNamespace

from deepseek_harness import Notification

from dsh_fastapi_101.runtime import RuntimeService


class FakeHarness:
    def __init__(self) -> None:
        self.started = False
        self.closed = False
        self.active = 0
        self.max_active = 0
        self.guard = threading.Lock()

    def start(self) -> None:
        self.started = True

    def close(self) -> None:
        self.closed = True

    def start_session(self, session_id: str):
        harness = self

        class FakeSession:
            def run(self, prompt: str, *, on_notification=None):
                with harness.guard:
                    harness.active += 1
                    harness.max_active = max(harness.max_active, harness.active)
                if on_notification is not None:
                    on_notification(Notification(
                        method="session.event",
                        payload={
                            "sessionId": session_id,
                            "event": {
                                "type": "assistant/chunk",
                                "data": {"chunk": {"type": "text-delta", "text": prompt}},
                            },
                        },
                    ))
                time.sleep(0.05)
                with harness.guard:
                    harness.active -= 1
                return SimpleNamespace(
                    session_id=session_id,
                    final_response=prompt,
                    finish_reason="completed",
                    notifications=[],
                )

        return FakeSession()


def test_constructor_has_no_filesystem_side_effects(tmp_path: Path, monkeypatch) -> None:
    async def scenario() -> None:
        workspace = tmp_path / "workspace"
        sessions = tmp_path / "sessions"
        monkeypatch.setenv("DSH_FASTAPI_WORKSPACE", str(workspace))
        monkeypatch.setenv("DSH_FASTAPI_SESSION_ROOT", str(sessions))
        service = RuntimeService(harness=FakeHarness())
        assert not workspace.exists()
        assert not sessions.exists()

        await service.start()
        assert workspace.is_dir()
        assert sessions.is_dir()
        await service.close()

    asyncio.run(scenario())


def test_streams_projected_events_and_final_result(tmp_path: Path, monkeypatch) -> None:
    async def scenario() -> None:
        monkeypatch.setenv("DSH_FASTAPI_WORKSPACE", str(tmp_path / "workspace"))
        monkeypatch.setenv("DSH_FASTAPI_SESSION_ROOT", str(tmp_path / "sessions"))
        harness = FakeHarness()
        service = RuntimeService(harness=harness)
        await service.start()

        events = [event async for event in service.stream("hello", "session-a")]

        assert [event.type for event in events] == ["text_delta", "final"]
        assert events[-1].data == {"response": "hello", "finish_reason": "completed"}
        await service.close()
        assert harness.started and harness.closed

    asyncio.run(scenario())


def test_serializes_same_session_and_allows_different_sessions_to_overlap(
    tmp_path: Path,
    monkeypatch,
) -> None:
    async def scenario() -> None:
        monkeypatch.setenv("DSH_FASTAPI_WORKSPACE", str(tmp_path / "workspace"))
        monkeypatch.setenv("DSH_FASTAPI_SESSION_ROOT", str(tmp_path / "sessions"))
        same_harness = FakeHarness()
        same = RuntimeService(harness=same_harness)
        await same.start()
        await asyncio.gather(same.run("one", "same"), same.run("two", "same"))
        assert same_harness.max_active == 1
        await same.close()

        split_harness = FakeHarness()
        split = RuntimeService(harness=split_harness)
        await split.start()
        await asyncio.gather(split.run("one", "a"), split.run("two", "b"))
        assert split_harness.max_active == 2
        await split.close()

    asyncio.run(scenario())
