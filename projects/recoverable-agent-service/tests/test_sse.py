from __future__ import annotations

import asyncio
import importlib
from pathlib import Path

from api_support import ControlledCoordinator, load_app_module, make_store
from fastapi.testclient import TestClient


def terminal_run(repository, *, prompt: str = "prompt"):
    conversation = repository.create_conversation()
    submitted = repository.submit_run(conversation.id, "key", prompt, [])
    claimed = repository.claim_oldest_run()
    assert claimed is not None
    repository.append_event(claimed.id, "text_delta", {"text": "hello"})
    repository.complete_run_success(
        claimed.id,
        final_response="hello",
        finish_reason="completed",
        artifacts=[],
    )
    return repository.get_run(submitted.run.id)


def test_cursor_errors_are_normal_http_responses_before_streaming(tmp_path: Path) -> None:
    app_module = load_app_module()
    repository = make_store(tmp_path / "cursor.db")
    coordinator = ControlledCoordinator(repository)
    run = terminal_run(repository)

    with TestClient(app_module.create_app(store=repository, coordinator=coordinator)) as client:
        invalid = client.get(f"/api/runs/{run.id}/events", headers={"Last-Event-ID": "not-an-int"})
        negative = client.get(f"/api/runs/{run.id}/events", headers={"Last-Event-ID": "-1"})
        ahead = client.get(
            f"/api/runs/{run.id}/events",
            headers={"Last-Event-ID": str(run.last_event_seq + 1)},
        )
        missing = client.get("/api/runs/missing/events")

    assert invalid.status_code == 400
    assert negative.status_code == 400
    assert ahead.status_code == 409
    assert missing.status_code == 404
    replacement = coordinator.notifier.subscribe(run.id)
    assert replacement.version == 0
    replacement.close()


def test_full_and_partial_replay_have_exact_persisted_frames(tmp_path: Path) -> None:
    app_module = load_app_module()
    domain = importlib.import_module("recoverable_agent_service.domain")
    repository = make_store(tmp_path / "replay.db")
    coordinator = ControlledCoordinator(repository)
    run = terminal_run(repository)
    events = repository.list_events(run.id)

    with TestClient(app_module.create_app(store=repository, coordinator=coordinator)) as client:
        full = client.get(f"/api/runs/{run.id}/events")
        partial = client.get(f"/api/runs/{run.id}/events", headers={"Last-Event-ID": "2"})
        empty = client.get(
            f"/api/runs/{run.id}/events",
            headers={"Last-Event-ID": str(run.last_event_seq)},
        )

    expected_full = "".join(
        f"id: {event.seq}\nevent: {event.type}\ndata: {domain.canonical_json(event.data)}\n\n"
        for event in events
    )
    expected_partial = "".join(
        f"id: {event.seq}\nevent: {event.type}\ndata: {domain.canonical_json(event.data)}\n\n"
        for event in events
        if event.seq > 2
    )
    assert full.status_code == 200
    assert full.headers["content-type"].startswith("text/event-stream")
    assert full.headers["cache-control"] == "no-cache"
    assert full.headers["x-accel-buffering"] == "no"
    assert full.text == expected_full
    assert partial.text == expected_partial
    assert empty.status_code == 200
    assert empty.text == ""


def test_commit_before_query_and_between_query_wait_have_no_gap_or_duplicate(
    tmp_path: Path,
) -> None:
    sse = importlib.import_module("recoverable_agent_service.sse")
    notifier_module = importlib.import_module("recoverable_agent_service.notifier")
    repository = make_store(tmp_path / "barrier.db")
    conversation = repository.create_conversation()
    submitted = repository.submit_run(conversation.id, "key", "prompt", [])
    claimed = repository.claim_oldest_run()
    assert claimed is not None
    notifier = notifier_module.RunNotifier()

    class BarrierStore:
        def __init__(self) -> None:
            self.queries = 0

        def list_events(self, run_id: str, after_seq: int = 0):
            self.queries += 1
            events = repository.list_events(run_id, after_seq)
            if self.queries == 1:
                repository.append_event(run_id, "status", {"status": "running"})
                notifier.publish(run_id)
            elif self.queries == 2:
                repository.complete_run_success(
                    run_id,
                    final_response="done",
                    finish_reason="completed",
                    artifacts=[],
                )
                notifier.publish(run_id)
            return events

    async def scenario() -> None:
        subscription = notifier.subscribe(submitted.run.id)
        generator = sse.iter_sse_events(
            BarrierStore(),
            submitted.run.id,
            0,
            subscription,
            heartbeat_interval=0.01,
        )
        frames = []
        async for frame in generator:
            if not frame.startswith(":"):
                frames.append(frame)
        ids = [int(frame.splitlines()[0].removeprefix("id: ")) for frame in frames]
        assert ids == list(range(1, repository.get_run(submitted.run.id).last_event_seq + 1))
        assert len(ids) == len(set(ids))

    asyncio.run(scenario())


def test_heartbeat_and_generator_close_unregister_subscription(tmp_path: Path) -> None:
    sse = importlib.import_module("recoverable_agent_service.sse")
    notifier_module = importlib.import_module("recoverable_agent_service.notifier")
    repository = make_store(tmp_path / "heartbeat.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(conversation.id, "key", "prompt", []).run
    notifier = notifier_module.RunNotifier()

    async def scenario() -> None:
        subscription = notifier.subscribe(run.id)
        generator = sse.iter_sse_events(
            repository,
            run.id,
            run.last_event_seq,
            subscription,
            heartbeat_interval=0.01,
        )
        assert await asyncio.wait_for(anext(generator), timeout=0.1) == ": heartbeat\n\n"
        await generator.aclose()
        replacement = notifier.subscribe(run.id)
        assert replacement.version == 0
        replacement.close()

    asyncio.run(scenario())


def test_cancelled_stream_wait_unregisters_subscription(tmp_path: Path) -> None:
    sse = importlib.import_module("recoverable_agent_service.sse")
    notifier_module = importlib.import_module("recoverable_agent_service.notifier")
    repository = make_store(tmp_path / "cancel.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(conversation.id, "key", "prompt", []).run
    notifier = notifier_module.RunNotifier()

    async def scenario() -> None:
        subscription = notifier.subscribe(run.id)
        generator = sse.iter_sse_events(
            repository,
            run.id,
            run.last_event_seq,
            subscription,
            heartbeat_interval=30,
        )
        waiting = asyncio.create_task(anext(generator))
        await asyncio.sleep(0.01)
        assert not waiting.done()
        waiting.cancel()
        try:
            await waiting
        except asyncio.CancelledError:
            pass
        else:
            raise AssertionError("cancelled stream wait did not propagate cancellation")

        replacement = notifier.subscribe(run.id)
        assert replacement.version == 0
        replacement.close()

    asyncio.run(scenario())


def test_two_concurrent_streams_receive_the_same_committed_event(tmp_path: Path) -> None:
    sse = importlib.import_module("recoverable_agent_service.sse")
    notifier_module = importlib.import_module("recoverable_agent_service.notifier")
    repository = make_store(tmp_path / "two-subscribers.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(conversation.id, "key", "prompt", []).run
    notifier = notifier_module.RunNotifier()

    async def scenario() -> None:
        first = sse.iter_sse_events(
            repository,
            run.id,
            run.last_event_seq,
            notifier.subscribe(run.id),
            heartbeat_interval=30,
        )
        second = sse.iter_sse_events(
            repository,
            run.id,
            run.last_event_seq,
            notifier.subscribe(run.id),
            heartbeat_interval=30,
        )
        first_wait = asyncio.create_task(anext(first))
        second_wait = asyncio.create_task(anext(second))
        await asyncio.sleep(0.01)

        claimed = await asyncio.to_thread(repository.claim_oldest_run)
        assert claimed is not None
        notifier.publish(run.id)

        first_frame, second_frame = await asyncio.gather(first_wait, second_wait)
        assert first_frame == "id: 2\nevent: run.started\ndata: {}\n\n"
        assert second_frame == first_frame
        await first.aclose()
        await second.aclose()

        replacement = notifier.subscribe(run.id)
        assert replacement.version == 0
        replacement.close()

    asyncio.run(scenario())
