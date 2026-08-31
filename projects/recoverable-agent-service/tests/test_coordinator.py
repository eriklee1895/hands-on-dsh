from __future__ import annotations

import asyncio
import importlib
import re
import sqlite3
import threading
from collections.abc import Awaitable, Callable
from pathlib import Path

import pytest


def load_coordinator():
    try:
        return importlib.import_module("recoverable_agent_service.coordinator")
    except ImportError as error:
        pytest.fail(f"Task 1B coordinator is not implemented: {error}")


def modules():
    return (
        importlib.import_module("recoverable_agent_service.events"),
        importlib.import_module("recoverable_agent_service.runtime"),
        importlib.import_module("recoverable_agent_service.store"),
        importlib.import_module("recoverable_agent_service.notifier"),
    )


Behavior = Callable[[str, str, Callable], Awaitable[object]]


class FakeAdapter:
    def __init__(
        self,
        behaviors: list[Behavior] | None = None,
        *,
        close_errors: list[BaseException] | None = None,
    ) -> None:
        self.behaviors = list(behaviors or [])
        self.close_errors = list(close_errors or [])
        self.calls: list[tuple[str, str]] = []
        self.closed = 0

    async def run(self, session_id: str, runtime_input: str, emit):
        self.calls.append((session_id, runtime_input))
        if self.behaviors:
            return await self.behaviors.pop(0)(session_id, runtime_input, emit)
        runtime = importlib.import_module("recoverable_agent_service.runtime")
        return runtime.RuntimeResult(final_response="done", finish_reason="completed")

    async def close(self) -> None:
        self.closed += 1
        if self.close_errors:
            raise self.close_errors.pop(0)


class InstrumentedStore:
    def __init__(
        self,
        store,
        *,
        migration_entered: threading.Event | None = None,
        migration_release: threading.Event | None = None,
    ) -> None:
        self._store = store
        self._migration_entered = migration_entered
        self._migration_release = migration_release
        self._counter_lock = threading.Lock()
        self.migrate_calls = 0
        self.recovery_calls = 0

    def __getattr__(self, name: str):
        return getattr(self._store, name)

    def migrate(self) -> None:
        with self._counter_lock:
            self.migrate_calls += 1
        if self._migration_entered is not None:
            self._migration_entered.set()
        if self._migration_release is not None:
            self._migration_release.wait()
        self._store.migrate()

    def recover_running_runs(self) -> int:
        with self._counter_lock:
            self.recovery_calls += 1
        return self._store.recover_running_runs()


def make_store(database_path: Path):
    store = importlib.import_module("recoverable_agent_service.store")
    repository = store.SQLiteStore(database_path)
    repository.migrate()
    return repository


async def wait_for_state(repository, run_id: str, state: str, timeout: float = 1.0):
    async def wait() -> object:
        while True:
            run = await asyncio.to_thread(repository.get_run, run_id)
            if run.state == state:
                return run
            await asyncio.sleep(0.005)

    return await asyncio.wait_for(wait(), timeout=timeout)


def test_concurrent_starts_run_one_recovery_pass_and_create_one_worker(tmp_path: Path) -> None:
    coordinator_module = load_coordinator()

    async def scenario() -> None:
        migration_entered = threading.Event()
        migration_release = threading.Event()
        repository = make_store(tmp_path / "concurrent-start.db")
        instrumented = InstrumentedStore(
            repository,
            migration_entered=migration_entered,
            migration_release=migration_release,
        )
        adapter = FakeAdapter()
        coordinator = coordinator_module.RunCoordinator(
            instrumented, adapter, tmp_path / "workspace", poll_interval=0.01
        )

        first = asyncio.create_task(coordinator.start())
        assert await asyncio.to_thread(migration_entered.wait, 0.5)
        second = asyncio.create_task(coordinator.start())
        await asyncio.sleep(0.03)
        migration_release.set()
        await asyncio.gather(first, second)

        workers = [
            task
            for task in asyncio.all_tasks()
            if task is not asyncio.current_task()
            and task.get_name() == "recoverable-run-worker"
            and not task.done()
        ]
        migrate_calls = instrumented.migrate_calls
        recovery_calls = instrumented.recovery_calls
        worker_count = len(workers)
        await coordinator.close()

        assert migrate_calls == 1
        assert recovery_calls == 1
        assert worker_count == 1
        assert adapter.closed == 1

    asyncio.run(scenario())


def test_close_racing_blocked_start_prevents_worker_and_admission(tmp_path: Path) -> None:
    coordinator_module = load_coordinator()

    async def scenario() -> None:
        migration_entered = threading.Event()
        migration_release = threading.Event()
        repository = make_store(tmp_path / "start-close.db")
        conversation = repository.create_conversation()
        instrumented = InstrumentedStore(
            repository,
            migration_entered=migration_entered,
            migration_release=migration_release,
        )
        adapter = FakeAdapter()
        coordinator = coordinator_module.RunCoordinator(
            instrumented, adapter, tmp_path / "workspace", poll_interval=0.01
        )

        starting = asyncio.create_task(coordinator.start())
        assert await asyncio.to_thread(migration_entered.wait, 0.5)
        closing = asyncio.create_task(coordinator.close())
        await asyncio.sleep(0.03)
        close_finished_early = closing.done()
        migration_release.set()

        start_rejected = False
        try:
            await starting
        except coordinator_module.CoordinatorClosedError:
            start_rejected = True
        await closing
        workers = [
            task
            for task in asyncio.all_tasks()
            if task is not asyncio.current_task()
            and task.get_name() == "recoverable-run-worker"
            and not task.done()
        ]
        for worker in workers:
            worker.cancel()
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)

        assert not close_finished_early
        assert start_rejected
        with pytest.raises(coordinator_module.CoordinatorClosedError):
            await coordinator.submit_run(conversation.id, "request", "prompt", [])
        assert workers == []
        assert instrumented.recovery_calls == 0
        assert adapter.closed == 1

    asyncio.run(scenario())


def test_close_before_start_is_terminal_and_concurrent_close_is_idempotent(
    tmp_path: Path,
) -> None:
    coordinator_module = load_coordinator()

    async def scenario() -> None:
        repository = make_store(tmp_path / "close-before-start.db")
        conversation = repository.create_conversation()
        adapter = FakeAdapter()
        coordinator = coordinator_module.RunCoordinator(
            repository, adapter, tmp_path / "workspace", poll_interval=0.01
        )

        await asyncio.gather(coordinator.close(), coordinator.close())

        assert adapter.closed == 1
        with pytest.raises(coordinator_module.CoordinatorClosedError):
            await coordinator.start()
        with pytest.raises(coordinator_module.CoordinatorClosedError):
            await coordinator.submit_run(conversation.id, "request", "prompt", [])

    asyncio.run(scenario())


def test_health_properties_track_admission_and_worker_lifecycle(tmp_path: Path) -> None:
    coordinator_module = load_coordinator()

    async def scenario() -> None:
        repository = make_store(tmp_path / "health.db")
        coordinator = coordinator_module.RunCoordinator(
            repository, FakeAdapter(), tmp_path / "workspace", poll_interval=0.01
        )

        assert coordinator.accepting is False
        assert coordinator.worker_running is False
        await coordinator.start()
        assert coordinator.accepting is True
        assert coordinator.worker_running is True
        await coordinator.close()
        assert coordinator.accepting is False
        assert coordinator.worker_running is False

    asyncio.run(scenario())


def test_durable_polling_executes_lost_wake_once_and_persists_events_in_order(
    tmp_path: Path,
) -> None:
    coordinator_module = load_coordinator()
    events, runtime, _, _ = modules()

    async def behavior(_session_id: str, _runtime_input: str, emit):
        await emit(events.RuntimeEvent(type="text_delta", data={"text": "one"}))
        await emit(events.RuntimeEvent(type="status", data={"status": "idle"}))
        return runtime.RuntimeResult(final_response="done", finish_reason="completed")

    async def scenario() -> None:
        repository = make_store(tmp_path / "service.db")
        adapter = FakeAdapter([behavior])
        coordinator = coordinator_module.RunCoordinator(
            repository,
            adapter,
            tmp_path / "workspace",
            poll_interval=0.01,
        )
        await coordinator.start()
        conversation = await asyncio.to_thread(repository.create_conversation)
        submission = await asyncio.to_thread(
            repository.submit_run, conversation.id, "lost-wake", "prompt", []
        )

        completed = await wait_for_state(repository, submission.run.id, "succeeded")
        await asyncio.sleep(0.03)

        assert completed.final_response == "done"
        assert len(adapter.calls) == 1
        assert [event.type for event in repository.list_events(submission.run.id)] == [
            "run.queued",
            "run.started",
            "text_delta",
            "status",
            "run.succeeded",
        ]
        await coordinator.close()

    asyncio.run(scenario())


def test_completed_run_snapshots_available_and_missing_artifacts(tmp_path: Path) -> None:
    coordinator_module = load_coordinator()
    _, runtime, _, _ = modules()
    workspace = tmp_path / "workspace"

    async def behavior(_session_id: str, runtime_input: str, _emit):
        run_id = re.search(r"artifacts/([^/]+)/proof\.txt", runtime_input).group(1)
        artifact_dir = workspace / "artifacts" / run_id
        (artifact_dir / "proof.txt").write_bytes(b"coordinator proof")
        return runtime.RuntimeResult(final_response="done", finish_reason="completed")

    async def scenario() -> None:
        repository = make_store(tmp_path / "service.db")
        adapter = FakeAdapter([behavior])
        coordinator = coordinator_module.RunCoordinator(
            repository, adapter, workspace, poll_interval=0.01
        )
        await coordinator.start()
        conversation = await asyncio.to_thread(repository.create_conversation)
        submission = await coordinator.submit_run(
            conversation.id,
            "request",
            "create proof",
            ["proof.txt", "optional.txt"],
        )

        await wait_for_state(repository, submission.run.id, "succeeded")

        artifacts = {
            item.requested_name: item for item in repository.list_artifacts(submission.run.id)
        }
        assert artifacts["proof.txt"].state == "available"
        assert artifacts["proof.txt"].content == b"coordinator proof"
        assert artifacts["optional.txt"].state == "missing"
        assert repository.list_events(submission.run.id)[-1].type == "run.succeeded"
        await coordinator.close()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("kind", "expected_code", "expected_conversation_state"),
    [
        ("non_completed", "agent_outcome", "active"),
        ("unavailable", "runtime_unavailable", "active"),
        ("uncertain", "execution_uncertain", "attention_required"),
        ("unexpected", "execution_uncertain", "attention_required"),
    ],
)
def test_failure_paths_preserve_events_and_invalidate_pending_artifacts(
    tmp_path: Path,
    kind: str,
    expected_code: str,
    expected_conversation_state: str,
) -> None:
    coordinator_module = load_coordinator()
    events, runtime, _, _ = modules()

    async def behavior(_session_id: str, _runtime_input: str, emit):
        await emit(events.RuntimeEvent(type="status", data={"status": "running"}))
        if kind == "non_completed":
            return runtime.RuntimeResult(final_response="partial", finish_reason="max-tokens")
        if kind == "unavailable":
            raise runtime.RuntimeUnavailableError("start failed")
        if kind == "uncertain":
            raise runtime.ExecutionUncertainError("transport lost")
        raise ValueError("unexpected adapter failure")

    async def scenario() -> None:
        repository = make_store(tmp_path / f"{kind}.db")
        adapter = FakeAdapter([behavior])
        coordinator = coordinator_module.RunCoordinator(
            repository, adapter, tmp_path / kind, poll_interval=0.01
        )
        await coordinator.start()
        conversation = await asyncio.to_thread(repository.create_conversation)
        submission = await coordinator.submit_run(
            conversation.id, "request", "prompt", ["proof.txt"]
        )

        failed = await wait_for_state(repository, submission.run.id, "failed")

        assert failed.error_code == expected_code
        assert repository.get_conversation(conversation.id).state == expected_conversation_state
        assert repository.list_artifacts(failed.id)[0].state == "invalid"
        assert [event.type for event in repository.list_events(failed.id)][-2:] == [
            "status",
            "run.failed",
        ]
        await coordinator.close()

    asyncio.run(scenario())


def test_startup_recovers_running_without_adapter_call_then_executes_queued(
    tmp_path: Path,
) -> None:
    coordinator_module = load_coordinator()
    _, _, _, notifier_module = modules()

    async def scenario() -> None:
        repository = make_store(tmp_path / "recovery.db")
        running_conversation = repository.create_conversation()
        running = repository.submit_run(
            running_conversation.id, "running", "prompt", ["proof.txt"]
        ).run
        repository.claim_oldest_run()
        queued_conversation = repository.create_conversation()
        queued = repository.submit_run(queued_conversation.id, "queued", "prompt", []).run
        notifier = notifier_module.RunNotifier()
        recovered_subscription = notifier.subscribe(running.id)
        adapter = FakeAdapter()
        coordinator = coordinator_module.RunCoordinator(
            repository,
            adapter,
            tmp_path / "workspace",
            notifier=notifier,
            poll_interval=0.01,
        )

        await coordinator.start()

        assert await recovered_subscription.wait_for_greater_than(0, timeout=0.1) == 1
        await wait_for_state(repository, queued.id, "succeeded")
        assert repository.get_run(running.id).error_code == "execution_uncertain"
        assert repository.get_conversation(running_conversation.id).state == "attention_required"
        assert repository.list_artifacts(running.id)[0].state == "invalid"
        assert len(adapter.calls) == 1
        assert adapter.calls[0][0] == queued.dsh_session_id
        recovered_subscription.close()
        await coordinator.close()

    asyncio.run(scenario())


def test_acknowledgement_rotates_session_used_by_the_next_run(tmp_path: Path) -> None:
    coordinator_module = load_coordinator()
    _, runtime, _, _ = modules()

    async def uncertain(_session_id: str, _runtime_input: str, _emit):
        raise runtime.ExecutionUncertainError("transport lost")

    async def completed(_session_id: str, _runtime_input: str, _emit):
        return runtime.RuntimeResult(final_response="done", finish_reason="completed")

    async def scenario() -> None:
        repository = make_store(tmp_path / "ack.db")
        adapter = FakeAdapter([uncertain, completed])
        coordinator = coordinator_module.RunCoordinator(
            repository, adapter, tmp_path / "workspace", poll_interval=0.01
        )
        await coordinator.start()
        conversation = await asyncio.to_thread(repository.create_conversation)
        first = await coordinator.submit_run(conversation.id, "first", "prompt", [])
        await wait_for_state(repository, first.run.id, "failed")

        acknowledged = await coordinator.acknowledge_recovery(conversation.id)
        second = await coordinator.submit_run(conversation.id, "second", "prompt", [])
        await wait_for_state(repository, second.run.id, "succeeded")

        assert acknowledged.dsh_session_id != conversation.dsh_session_id
        assert [call[0] for call in adapter.calls] == [
            conversation.dsh_session_id,
            acknowledged.dsh_session_id,
        ]
        await coordinator.close()

    asyncio.run(scenario())


def test_close_waits_active_run_leaves_later_queue_and_rejects_new_admission(
    tmp_path: Path,
) -> None:
    coordinator_module = load_coordinator()
    _, runtime, _, _ = modules()

    async def scenario() -> None:
        entered = asyncio.Event()
        release = asyncio.Event()

        async def blocked(_session_id: str, _runtime_input: str, _emit):
            entered.set()
            await release.wait()
            return runtime.RuntimeResult(final_response="done", finish_reason="completed")

        repository = make_store(tmp_path / "close.db")
        adapter = FakeAdapter([blocked])
        coordinator = coordinator_module.RunCoordinator(
            repository, adapter, tmp_path / "workspace", poll_interval=0.01
        )
        await coordinator.start()
        first_conversation = await asyncio.to_thread(repository.create_conversation)
        first = await coordinator.submit_run(first_conversation.id, "first", "prompt", [])
        await asyncio.wait_for(entered.wait(), timeout=0.5)
        second_conversation = await asyncio.to_thread(repository.create_conversation)
        second = await coordinator.submit_run(second_conversation.id, "second", "prompt", [])

        closing = asyncio.create_task(coordinator.close())
        await asyncio.sleep(0.03)
        assert not closing.done()
        assert repository.get_run(second.run.id).state == "queued"
        release.set()
        await asyncio.wait_for(closing, timeout=0.5)

        assert repository.get_run(first.run.id).state == "succeeded"
        assert repository.get_run(second.run.id).state == "queued"
        assert len(adapter.calls) == 1
        assert adapter.closed == 1
        with pytest.raises(coordinator_module.CoordinatorClosedError):
            await coordinator.submit_run(first_conversation.id, "after-close", "prompt", [])

    asyncio.run(scenario())


def test_close_reaps_adapter_when_worker_surfaces_a_terminal_transaction_error(
    tmp_path: Path,
) -> None:
    coordinator_module = load_coordinator()
    _, runtime, _, _ = modules()

    async def scenario() -> None:
        entered = asyncio.Event()
        release = asyncio.Event()

        async def blocked(_session_id: str, _runtime_input: str, _emit):
            entered.set()
            await release.wait()
            return runtime.RuntimeResult(final_response="done", finish_reason="completed")

        repository = make_store(tmp_path / "worker-error.db")
        adapter = FakeAdapter([blocked])
        coordinator = coordinator_module.RunCoordinator(
            repository, adapter, tmp_path / "workspace", poll_interval=0.01
        )
        await coordinator.start()
        conversation = await asyncio.to_thread(repository.create_conversation)
        await coordinator.submit_run(conversation.id, "request", "prompt", [])
        await asyncio.wait_for(entered.wait(), timeout=0.5)
        with sqlite3.connect(repository.database_path) as connection:
            connection.execute(
                """
                CREATE TRIGGER fail_coordinator_terminal_event
                BEFORE INSERT ON run_events
                WHEN NEW.type = 'run.succeeded'
                BEGIN
                    SELECT RAISE(ABORT, 'coordinator terminal failure');
                END
                """
            )

        closing = asyncio.create_task(coordinator.close())
        release.set()
        with pytest.raises(sqlite3.IntegrityError, match="coordinator terminal failure"):
            await closing

        assert adapter.closed == 1

    asyncio.run(scenario())


def test_close_failure_keeps_coordinator_stopping_until_cleanup_retry_succeeds(
    tmp_path: Path,
) -> None:
    coordinator_module = load_coordinator()

    async def scenario() -> None:
        repository = make_store(tmp_path / "close-retry.db")
        conversation = repository.create_conversation()
        adapter = FakeAdapter(close_errors=[OSError("adapter close failed")])
        coordinator = coordinator_module.RunCoordinator(
            repository, adapter, tmp_path / "workspace", poll_interval=0.01
        )
        await coordinator.start()

        with pytest.raises(OSError, match="adapter close failed"):
            await coordinator.close()
        with pytest.raises(coordinator_module.CoordinatorClosedError):
            await coordinator.submit_run(conversation.id, "request", "prompt", [])

        await coordinator.close()
        await coordinator.close()

        assert adapter.closed == 2
        with pytest.raises(coordinator_module.CoordinatorClosedError):
            await coordinator.start()

    asyncio.run(scenario())


def test_worker_error_stays_primary_when_cleanup_fails_and_cleanup_remains_retryable(
    tmp_path: Path,
) -> None:
    coordinator_module = load_coordinator()
    _, runtime, _, _ = modules()

    async def scenario() -> None:
        entered = asyncio.Event()
        release = asyncio.Event()

        async def blocked(_session_id: str, _runtime_input: str, _emit):
            entered.set()
            await release.wait()
            return runtime.RuntimeResult(final_response="done", finish_reason="completed")

        repository = make_store(tmp_path / "worker-cleanup-error.db")
        adapter = FakeAdapter(
            [blocked],
            close_errors=[OSError("adapter cleanup failed")],
        )
        coordinator = coordinator_module.RunCoordinator(
            repository, adapter, tmp_path / "workspace", poll_interval=0.01
        )
        await coordinator.start()
        conversation = await asyncio.to_thread(repository.create_conversation)
        await coordinator.submit_run(conversation.id, "request", "prompt", [])
        await asyncio.wait_for(entered.wait(), timeout=0.5)
        with sqlite3.connect(repository.database_path) as connection:
            connection.execute(
                """
                CREATE TRIGGER fail_worker_terminal_event_with_cleanup
                BEFORE INSERT ON run_events
                WHEN NEW.type = 'run.succeeded'
                BEGIN
                    SELECT RAISE(ABORT, 'worker terminal failure with cleanup');
                END
                """
            )

        closing = asyncio.create_task(coordinator.close())
        release.set()
        with pytest.raises(
            sqlite3.IntegrityError, match="worker terminal failure with cleanup"
        ) as captured:
            await closing

        assert isinstance(captured.value.__cause__, OSError)
        assert str(captured.value.__cause__) == "adapter cleanup failed"
        await coordinator.close()
        assert adapter.closed == 2

    asyncio.run(scenario())
