from __future__ import annotations

import asyncio
import gc
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from deepseek_harness import Notification

from dsh_fastapi_101 import runtime as runtime_module
from dsh_fastapi_101.runtime import RuntimeService


class FakeHarness:
    def __init__(self, finish_reason: str = "completed") -> None:
        self.started = False
        self.closed = False
        self.active = 0
        self.max_active = 0
        self.guard = threading.Lock()
        self.finish_reason = finish_reason

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
                    on_notification(
                        Notification(
                            method="session.event",
                            payload={
                                "sessionId": session_id,
                                "event": {
                                    "type": "assistant/message",
                                    "data": {
                                        "message": {"content": [{"type": "text", "text": prompt}]}
                                    },
                                },
                            },
                        )
                    )
                time.sleep(0.05)
                with harness.guard:
                    harness.active -= 1
                return SimpleNamespace(
                    session_id=session_id,
                    final_response=prompt,
                    finish_reason=harness.finish_reason,
                    notifications=[],
                )

        return FakeSession()


def test_constructor_has_no_filesystem_side_effects(tmp_path: Path, monkeypatch) -> None:
    async def scenario() -> None:
        workspace = tmp_path / "workspace"
        home = tmp_path / "home"
        monkeypatch.setenv("DSH_FASTAPI_WORKSPACE", str(workspace))
        monkeypatch.setenv("DSH_FASTAPI_HOME", str(home))
        service = RuntimeService(harness=FakeHarness())
        assert not workspace.exists()
        assert not home.exists()

        await service.start()
        assert workspace.is_dir()
        assert home.is_dir()
        await service.close()

    asyncio.run(scenario())


def test_public_profile_and_home_are_passed_to_installed_sdk(tmp_path: Path, monkeypatch) -> None:
    async def scenario() -> None:
        options: dict[str, object] = {}

        def make_harness(**kwargs):
            options.update(kwargs)
            return FakeHarness()

        monkeypatch.setenv("DSH_FASTAPI_WORKSPACE", str(tmp_path / "workspace"))
        monkeypatch.setenv("DSH_FASTAPI_HOME", str(tmp_path / "home"))
        monkeypatch.setattr(runtime_module, "DeepSeekHarness", make_harness)
        service = RuntimeService()
        await service.start()
        await service.close()

        assert options["profile"] == "sdk-minimal"
        assert options["dsh_home"] == str((tmp_path / "home").resolve())
        assert "session_root" not in options

    asyncio.run(scenario())


def test_start_failure_closes_created_sdk_owner(tmp_path: Path, monkeypatch) -> None:
    class StartFails(FakeHarness):
        def start(self) -> None:
            raise RuntimeError("startup failed")

    async def scenario() -> None:
        monkeypatch.setenv("DSH_FASTAPI_HOME", str(tmp_path / "home"))
        harness = StartFails()
        service = RuntimeService(harness=harness)
        with pytest.raises(RuntimeError, match="startup failed"):
            await service.start()
        assert harness.closed
        assert not service.started

    asyncio.run(scenario())


@pytest.mark.parametrize("finish_reason", ["error", "max-tokens"])
def test_model_error_is_not_a_successful_json_or_sse_result(
    tmp_path: Path, monkeypatch, finish_reason: str
) -> None:
    async def scenario() -> None:
        monkeypatch.setenv("DSH_FASTAPI_HOME", str(tmp_path / "home"))
        service = RuntimeService(harness=FakeHarness(finish_reason=finish_reason))
        await service.start()
        with pytest.raises(RuntimeError, match=finish_reason):
            await service.run("partial", "json-session")
        events = [event async for event in service.stream("partial", "sse-session")]
        assert events[-1].type == "error"
        assert events[-1].data["finish_reason"] == finish_reason
        assert all(event.type != "final" for event in events)
        await service.close()

    asyncio.run(scenario())


def test_sse_queue_saturation_preserves_terminal_event(tmp_path: Path, monkeypatch) -> None:
    class BurstHarness(FakeHarness):
        def start_session(self, session_id: str):
            class BurstSession:
                def run(self, prompt: str, *, on_notification=None):
                    assert on_notification is not None
                    for _ in range(300):
                        on_notification(
                            Notification(
                                method="session.status",
                                payload={"sessionId": session_id, "status": "running"},
                            )
                        )
                    return SimpleNamespace(
                        session_id=session_id,
                        final_response=prompt,
                        finish_reason="completed",
                    )

            return BurstSession()

    async def scenario() -> None:
        monkeypatch.setenv("DSH_FASTAPI_HOME", str(tmp_path / "home"))
        service = RuntimeService(harness=BurstHarness())
        await service.start()
        stream = service.stream("done", "burst")
        await service.close()
        events = [event async for event in stream]
        assert len(events) <= 256
        assert events[-1].type == "final"
        assert events[-1].data["response"] == "done"

    asyncio.run(scenario())


def test_close_waits_for_admitted_json_and_rejects_new_work(tmp_path: Path, monkeypatch) -> None:
    entered = threading.Event()
    release = threading.Event()

    class SlowHarness(FakeHarness):
        def start_session(self, session_id: str):
            class SlowSession:
                def run(self, prompt: str, *, on_notification=None):
                    entered.set()
                    assert release.wait(timeout=3)
                    return SimpleNamespace(
                        session_id=session_id,
                        final_response=prompt,
                        finish_reason="completed",
                    )

            return SlowSession()

    async def scenario() -> None:
        monkeypatch.setenv("DSH_FASTAPI_HOME", str(tmp_path / "home"))
        harness = SlowHarness()
        service = RuntimeService(harness=harness)
        await service.start()
        first = asyncio.create_task(service.run("first", "one"))
        assert await asyncio.to_thread(entered.wait, 2)
        closing = asyncio.create_task(service.close())
        await asyncio.sleep(0.02)
        assert not closing.done()
        assert not harness.closed
        with pytest.raises(RuntimeError, match="closing"):
            await service.run("late", "two")
        release.set()
        assert (await first).response == "first"
        await closing
        assert harness.closed

    asyncio.run(scenario())


def test_cancelled_json_waiter_does_not_leave_unobserved_worker_error(
    tmp_path: Path, monkeypatch
) -> None:
    entered = threading.Event()
    release = threading.Event()

    class SlowErrorHarness(FakeHarness):
        def start_session(self, session_id: str):
            class SlowErrorSession:
                def run(self, prompt: str, *, on_notification=None):
                    entered.set()
                    assert release.wait(timeout=3)
                    return SimpleNamespace(
                        session_id=session_id,
                        final_response="partial",
                        finish_reason="error",
                    )

            return SlowErrorSession()

    async def scenario() -> None:
        monkeypatch.setenv("DSH_FASTAPI_HOME", str(tmp_path / "home"))
        service = RuntimeService(harness=SlowErrorHarness())
        await service.start()
        loop = asyncio.get_running_loop()
        unhandled: list[dict[str, object]] = []
        prior = loop.get_exception_handler()
        loop.set_exception_handler(lambda _loop, context: unhandled.append(context))
        try:
            waiter = asyncio.create_task(service.run("fail", "cancelled-json"))
            assert await asyncio.to_thread(entered.wait, 2)
            waiter.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiter
            release.set()
            await asyncio.sleep(0.1)
            gc.collect()
            await asyncio.sleep(0)
            await service.close()
            assert not unhandled
        finally:
            loop.set_exception_handler(prior)

    asyncio.run(scenario())


def test_close_waits_for_admitted_sse_and_preserves_terminal_event(
    tmp_path: Path, monkeypatch
) -> None:
    entered = threading.Event()
    release = threading.Event()

    class SlowSseHarness(FakeHarness):
        def start_session(self, session_id: str):
            class SlowSession:
                def run(self, prompt: str, *, on_notification=None):
                    entered.set()
                    assert release.wait(timeout=3)
                    return SimpleNamespace(
                        session_id=session_id,
                        final_response="done",
                        finish_reason="completed",
                    )

            return SlowSession()

    async def scenario() -> None:
        monkeypatch.setenv("DSH_FASTAPI_HOME", str(tmp_path / "home"))
        service = RuntimeService(harness=SlowSseHarness())
        await service.start()
        stream = service.stream("finish", "stream-one")
        assert await asyncio.to_thread(entered.wait, 2)
        closing = asyncio.create_task(service.close())
        await asyncio.sleep(0.02)
        assert not closing.done()
        with pytest.raises(RuntimeError, match="closing"):
            service.stream("late", "stream-two")
        release.set()
        await closing
        assert [event.type async for event in stream] == ["final"]

    asyncio.run(scenario())


def test_cancelled_start_waits_for_initialization_before_closing(
    tmp_path: Path, monkeypatch
) -> None:
    entered = threading.Event()
    release = threading.Event()

    class GatedHarness(FakeHarness):
        def __init__(self) -> None:
            super().__init__()
            self.alive = False
            self.closed_before_start_finished = False

        def start(self) -> None:
            entered.set()
            assert release.wait(timeout=3)
            self.alive = True

        def close(self) -> None:
            if not self.alive:
                self.closed_before_start_finished = True
            self.alive = False
            super().close()

    async def scenario() -> None:
        monkeypatch.setenv("DSH_FASTAPI_HOME", str(tmp_path / "home"))
        harness = GatedHarness()
        service = RuntimeService(harness=harness)
        starting = asyncio.create_task(service.start())
        assert await asyncio.to_thread(entered.wait, 2)
        starting.cancel()
        closing = asyncio.create_task(service.close())
        assert not closing.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await starting
        await closing
        assert harness.closed
        assert not harness.alive
        assert not harness.closed_before_start_finished

    asyncio.run(scenario())


def test_cancelled_close_still_waits_for_admitted_json_worker(tmp_path: Path, monkeypatch) -> None:
    entered = threading.Event()
    release = threading.Event()

    class GatedHarness(FakeHarness):
        def __init__(self) -> None:
            super().__init__()
            self.active_at_close = False

        def start_session(self, session_id: str):
            harness = self

            class GatedSession:
                def run(self, prompt: str, *, on_notification=None):
                    with harness.guard:
                        harness.active += 1
                    entered.set()
                    assert release.wait(timeout=3)
                    with harness.guard:
                        harness.active -= 1
                    return SimpleNamespace(
                        session_id=session_id,
                        final_response=prompt,
                        finish_reason="completed",
                    )

            return GatedSession()

        def close(self) -> None:
            self.active_at_close = self.active > 0
            super().close()

    async def scenario() -> None:
        monkeypatch.setenv("DSH_FASTAPI_HOME", str(tmp_path / "home"))
        harness = GatedHarness()
        service = RuntimeService(harness=harness)
        await service.start()
        running = asyncio.create_task(service.run("first", "same"))
        assert await asyncio.to_thread(entered.wait, 2)
        first_close = asyncio.create_task(service.close())
        await asyncio.sleep(0)
        first_close.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first_close
        second_close = asyncio.create_task(service.close())
        assert not second_close.done()
        release.set()
        assert (await running).response == "first"
        await second_close
        assert harness.closed
        assert not harness.active_at_close

    asyncio.run(scenario())


def test_cancelled_close_still_waits_for_admitted_sse_worker(tmp_path: Path, monkeypatch) -> None:
    entered = threading.Event()
    release = threading.Event()

    class GatedHarness(FakeHarness):
        def __init__(self) -> None:
            super().__init__()
            self.active_at_close = False

        def start_session(self, session_id: str):
            harness = self

            class GatedSession:
                def run(self, prompt: str, *, on_notification=None):
                    harness.active += 1
                    entered.set()
                    assert release.wait(timeout=3)
                    harness.active -= 1
                    return SimpleNamespace(
                        session_id=session_id,
                        final_response=prompt,
                        finish_reason="completed",
                    )

            return GatedSession()

        def close(self) -> None:
            self.active_at_close = self.active > 0
            super().close()

    async def scenario() -> None:
        monkeypatch.setenv("DSH_FASTAPI_HOME", str(tmp_path / "home"))
        harness = GatedHarness()
        service = RuntimeService(harness=harness)
        await service.start()
        stream = service.stream("first", "same")
        assert await asyncio.to_thread(entered.wait, 2)
        first_close = asyncio.create_task(service.close())
        await asyncio.sleep(0)
        first_close.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first_close
        second_close = asyncio.create_task(service.close())
        assert not second_close.done()
        release.set()
        await second_close
        assert [event.type async for event in stream] == ["final"]
        assert harness.closed
        assert not harness.active_at_close

    asyncio.run(scenario())


def test_streams_projected_events_and_final_result(tmp_path: Path, monkeypatch) -> None:
    async def scenario() -> None:
        monkeypatch.setenv("DSH_FASTAPI_WORKSPACE", str(tmp_path / "workspace"))
        monkeypatch.setenv("DSH_FASTAPI_HOME", str(tmp_path / "home"))
        harness = FakeHarness()
        service = RuntimeService(harness=harness)
        await service.start()

        events = [event async for event in service.stream("hello", "session-a")]

        assert [event.type for event in events] == ["assistant_message", "final"]
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
        monkeypatch.setenv("DSH_FASTAPI_HOME", str(tmp_path / "home"))
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
