from __future__ import annotations

import asyncio
import importlib
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from deepseek_harness import Notification


def load_runtime():
    try:
        return importlib.import_module("recoverable_agent_service.runtime")
    except ImportError as error:
        pytest.fail(f"Task 1B runtime adapter is not implemented: {error}")


class FakeHarness:
    def __init__(
        self,
        *,
        start_error: BaseException | None = None,
        start_session_error: BaseException | None = None,
        run_error: BaseException | None = None,
        notifications: list[Notification] | None = None,
        result: object | None = None,
        close_errors: list[BaseException] | None = None,
        start_entered: threading.Event | None = None,
        start_release: threading.Event | None = None,
        run_entered: threading.Event | None = None,
        run_release: threading.Event | None = None,
    ) -> None:
        self.start_error = start_error
        self.start_session_error = start_session_error
        self.run_error = run_error
        self.notifications = notifications or []
        self.result = result
        self.close_errors = list(close_errors or [])
        self.start_entered = start_entered
        self.start_release = start_release
        self.run_entered = run_entered
        self.run_release = run_release
        self.started = 0
        self.closed = 0
        self.run_calls: list[tuple[str, str]] = []
        self.run_thread_ids: list[int] = []

    def start(self) -> None:
        self.started += 1
        if self.start_entered is not None:
            self.start_entered.set()
        if self.start_release is not None:
            self.start_release.wait()
        if self.start_error is not None:
            raise self.start_error

    def close(self) -> None:
        self.closed += 1
        if self.close_errors:
            raise self.close_errors.pop(0)

    def start_session(self, session_id: str):
        if self.start_session_error is not None:
            raise self.start_session_error
        harness = self

        class FakeSession:
            def run(self, runtime_input: str, *, on_notification=None):
                harness.run_calls.append((session_id, runtime_input))
                harness.run_thread_ids.append(threading.get_ident())
                if harness.run_entered is not None:
                    harness.run_entered.set()
                if harness.run_release is not None:
                    harness.run_release.wait()
                if harness.run_error is not None:
                    raise harness.run_error
                for notification in harness.notifications:
                    if on_notification is not None:
                        on_notification(notification)
                return harness.result or SimpleNamespace(
                    final_response="done", finish_reason="completed"
                )

        return FakeSession()


def test_start_failure_is_unavailable_and_discards_the_partial_harness(tmp_path: Path) -> None:
    runtime = load_runtime()

    async def scenario() -> None:
        first = FakeHarness(start_error=OSError("runtime binary missing"))
        second = FakeHarness()
        harnesses = iter([first, second])
        adapter = runtime.DSHRuntimeAdapter(
            tmp_path / "workspace",
            tmp_path / "sessions",
            harness_factory=lambda **_kwargs: next(harnesses),
        )

        with pytest.raises(runtime.RuntimeUnavailableError, match="runtime binary missing"):
            await adapter.run("session-1", "prompt", lambda _event: asyncio.sleep(0))

        assert first.started == 1
        assert first.closed == 1
        assert first.run_calls == []
        result = await adapter.run("session-1", "prompt", lambda _event: asyncio.sleep(0))
        assert result == runtime.RuntimeResult(final_response="done", finish_reason="completed")
        await adapter.close()
        assert second.closed == 1

    asyncio.run(scenario())


def test_session_run_exception_is_uncertain_and_next_run_uses_a_fresh_harness(
    tmp_path: Path,
) -> None:
    runtime = load_runtime()

    async def scenario() -> None:
        first = FakeHarness(run_error=ValueError("protocol disconnected"))
        second = FakeHarness()
        harnesses = iter([first, second])
        adapter = runtime.DSHRuntimeAdapter(
            tmp_path / "workspace",
            tmp_path / "sessions",
            harness_factory=lambda **_kwargs: next(harnesses),
        )

        with pytest.raises(runtime.ExecutionUncertainError, match="protocol disconnected"):
            await adapter.run("session-1", "prompt", lambda _event: asyncio.sleep(0))

        assert first.run_calls == [("session-1", "prompt")]
        assert first.closed == 1
        assert await adapter.run(
            "session-2", "second", lambda _event: asyncio.sleep(0)
        ) == runtime.RuntimeResult(final_response="done", finish_reason="completed")
        assert second.run_calls == [("session-2", "second")]
        await adapter.close()

    asyncio.run(scenario())


def test_callback_backpressure_preserves_projection_order_off_the_event_loop(
    tmp_path: Path,
) -> None:
    runtime = load_runtime()
    notifications = [
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {
                    "type": "assistant/chunk",
                    "data": {"chunk": {"type": "text-delta", "text": "one"}},
                },
            },
        ),
        Notification(method="unknown", payload={}),
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {
                    "type": "assistant/chunk",
                    "data": {"chunk": {"type": "text-delta", "text": "two"}},
                },
            },
        ),
    ]

    async def scenario() -> None:
        harness = FakeHarness(notifications=notifications)
        adapter = runtime.DSHRuntimeAdapter(
            tmp_path / "workspace",
            tmp_path / "sessions",
            harness_factory=lambda **_kwargs: harness,
        )
        event_loop_thread = threading.get_ident()
        emitted: list[str] = []

        async def emit(event) -> None:
            await asyncio.sleep(0.01)
            emitted.append(event.data["text"])

        result = await adapter.run("root", "prompt", emit)

        assert result == runtime.RuntimeResult(final_response="done", finish_reason="completed")
        assert emitted == ["one", "two"]
        assert harness.run_thread_ids and harness.run_thread_ids[0] != event_loop_thread
        await adapter.close()

    asyncio.run(scenario())


def test_emit_failure_during_session_run_is_uncertain_and_close_is_idempotent(
    tmp_path: Path,
) -> None:
    runtime = load_runtime()
    notification = Notification(
        method="session.status",
        payload={"sessionId": "root", "status": "running"},
    )

    async def scenario() -> None:
        harness = FakeHarness(notifications=[notification])
        adapter = runtime.DSHRuntimeAdapter(
            tmp_path / "workspace",
            tmp_path / "sessions",
            harness_factory=lambda **_kwargs: harness,
        )

        async def reject(_event) -> None:
            raise RuntimeError("event persistence failed")

        with pytest.raises(runtime.ExecutionUncertainError, match="event persistence failed"):
            await adapter.run("root", "prompt", reject)

        await adapter.close()
        await adapter.close()
        assert harness.closed == 1

    asyncio.run(scenario())


def test_sdk_work_does_not_deadlock_single_thread_default_executor_callback_persistence(
    tmp_path: Path,
) -> None:
    runtime = load_runtime()
    notification = Notification(
        method="session.status",
        payload={"sessionId": "root", "status": "running"},
    )

    async def scenario() -> None:
        loop = asyncio.get_running_loop()
        default_executor = ThreadPoolExecutor(max_workers=1)
        loop.set_default_executor(default_executor)
        harness = FakeHarness(notifications=[notification])
        adapter = runtime.DSHRuntimeAdapter(
            tmp_path / "workspace",
            tmp_path / "sessions",
            harness_factory=lambda **_kwargs: harness,
        )
        persisted: list[str] = []

        async def emit(event) -> None:
            await asyncio.to_thread(persisted.append, event.type)

        running = asyncio.create_task(adapter.run("root", "prompt", emit))
        deadlocked = False
        try:
            result = await asyncio.wait_for(asyncio.shield(running), timeout=0.2)
        except asyncio.TimeoutError:
            deadlocked = True
            default_executor._max_workers = 2
            default_executor._adjust_thread_count()
            result = await asyncio.wait_for(running, timeout=0.5)
        await adapter.close()

        assert not deadlocked, "SDK work occupied the executor needed by callback persistence"
        assert result.finish_reason == "completed"
        assert persisted == ["status"]

    asyncio.run(scenario())


def test_start_session_failure_is_unavailable_before_prompt_invocation(tmp_path: Path) -> None:
    runtime = load_runtime()

    async def scenario() -> None:
        first = FakeHarness(start_session_error=OSError("session construction failed"))
        second = FakeHarness()
        harnesses = iter([first, second])
        adapter = runtime.DSHRuntimeAdapter(
            tmp_path / "workspace",
            tmp_path / "sessions",
            harness_factory=lambda **_kwargs: next(harnesses),
        )

        with pytest.raises(runtime.RuntimeUnavailableError, match="session construction failed"):
            await adapter.run("root", "prompt", lambda _event: asyncio.sleep(0))

        assert first.run_calls == []
        assert first.closed == 1
        assert (
            await adapter.run("fresh", "prompt", lambda _event: asyncio.sleep(0))
        ).finish_reason == "completed"
        await adapter.close()

    asyncio.run(scenario())


def test_result_translation_failure_after_session_run_is_uncertain_and_resets(
    tmp_path: Path,
) -> None:
    runtime = load_runtime()

    class BrokenResult:
        @property
        def final_response(self) -> str:
            raise ValueError("result translation failed")

        finish_reason = "completed"

    async def scenario() -> None:
        first = FakeHarness(result=BrokenResult())
        second = FakeHarness()
        harnesses = iter([first, second])
        adapter = runtime.DSHRuntimeAdapter(
            tmp_path / "workspace",
            tmp_path / "sessions",
            harness_factory=lambda **_kwargs: next(harnesses),
        )

        with pytest.raises(runtime.ExecutionUncertainError, match="result translation failed"):
            await adapter.run("root", "prompt", lambda _event: asyncio.sleep(0))

        assert first.run_calls == [("root", "prompt")]
        assert first.closed == 1
        assert (
            await adapter.run("fresh", "prompt", lambda _event: asyncio.sleep(0))
        ).finish_reason == "completed"
        await adapter.close()

    asyncio.run(scenario())


def test_close_failure_retains_broken_harness_for_retry_and_prevents_reuse(
    tmp_path: Path,
) -> None:
    runtime = load_runtime()

    async def scenario() -> None:
        harness = FakeHarness(close_errors=[OSError("first close failed")])
        adapter = runtime.DSHRuntimeAdapter(
            tmp_path / "workspace",
            tmp_path / "sessions",
            harness_factory=lambda **_kwargs: harness,
        )
        await adapter.run("root", "prompt", lambda _event: asyncio.sleep(0))

        with pytest.raises(OSError, match="first close failed"):
            await adapter.close()
        with pytest.raises(runtime.RuntimeUnavailableError, match="cleanup"):
            await adapter.run("root", "must not run", lambda _event: asyncio.sleep(0))

        await adapter.close()
        await adapter.close()
        assert harness.closed == 2
        assert harness.run_calls == [("root", "prompt")]

    asyncio.run(scenario())


def test_uncertainty_cleanup_failure_keeps_harness_for_explicit_close_retry(
    tmp_path: Path,
) -> None:
    runtime = load_runtime()

    async def scenario() -> None:
        harness = FakeHarness(
            run_error=ValueError("transport disconnected"),
            close_errors=[OSError("uncertain close failed")],
        )
        adapter = runtime.DSHRuntimeAdapter(
            tmp_path / "workspace",
            tmp_path / "sessions",
            harness_factory=lambda **_kwargs: harness,
        )

        with pytest.raises(runtime.ExecutionUncertainError, match="transport disconnected"):
            await adapter.run("root", "prompt", lambda _event: asyncio.sleep(0))
        with pytest.raises(runtime.RuntimeUnavailableError, match="cleanup"):
            await adapter.run("root", "must not retry", lambda _event: asyncio.sleep(0))

        await adapter.close()
        assert harness.closed == 2
        assert harness.run_calls == [("root", "prompt")]

    asyncio.run(scenario())


def test_concurrent_lazy_starts_share_one_start_and_close_is_terminal(tmp_path: Path) -> None:
    runtime = load_runtime()

    async def scenario() -> None:
        harness = FakeHarness()
        adapter = runtime.DSHRuntimeAdapter(
            tmp_path / "workspace",
            tmp_path / "sessions",
            harness_factory=lambda **_kwargs: harness,
        )

        results = await asyncio.gather(
            adapter.run("one", "first", lambda _event: asyncio.sleep(0)),
            adapter.run("two", "second", lambda _event: asyncio.sleep(0)),
        )

        assert [result.finish_reason for result in results] == ["completed", "completed"]
        assert harness.started == 1
        await adapter.close()
        with pytest.raises(runtime.RuntimeUnavailableError, match="closed"):
            await adapter.run("three", "after close", lambda _event: asyncio.sleep(0))

    asyncio.run(scenario())


def test_close_before_start_is_idempotent_and_prevents_later_start(tmp_path: Path) -> None:
    runtime = load_runtime()

    async def scenario() -> None:
        constructed = 0

        def factory(**_kwargs):
            nonlocal constructed
            constructed += 1
            return FakeHarness()

        adapter = runtime.DSHRuntimeAdapter(
            tmp_path / "workspace",
            tmp_path / "sessions",
            harness_factory=factory,
        )

        await adapter.close()
        await adapter.close()
        with pytest.raises(runtime.RuntimeUnavailableError, match="closed"):
            await adapter.run("root", "after close", lambda _event: asyncio.sleep(0))
        assert constructed == 0

    asyncio.run(scenario())


def test_close_waits_for_an_in_progress_start(tmp_path: Path) -> None:
    runtime = load_runtime()

    async def scenario() -> None:
        start_entered = threading.Event()
        start_release = threading.Event()
        harness = FakeHarness(start_entered=start_entered, start_release=start_release)
        adapter = runtime.DSHRuntimeAdapter(
            tmp_path / "workspace",
            tmp_path / "sessions",
            harness_factory=lambda **_kwargs: harness,
        )
        running = asyncio.create_task(
            adapter.run("root", "prompt", lambda _event: asyncio.sleep(0))
        )
        assert await asyncio.to_thread(start_entered.wait, 0.5)

        closing = asyncio.create_task(adapter.close())
        await asyncio.sleep(0.02)
        assert not closing.done()
        start_release.set()

        assert (await running).finish_reason == "completed"
        await closing
        assert harness.closed == 1

    asyncio.run(scenario())
