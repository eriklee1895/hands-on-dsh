"""SQLite-backed named SSE replay and live tail."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from .domain import NotFoundError, canonical_json
from .notifier import RunNotifier, RunSubscription
from .store import SQLiteStore

TERMINAL_EVENTS = frozenset({"run.succeeded", "run.failed"})
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def parse_last_event_id(value: str | None) -> int:
    """Parse the SSE cursor as a non-negative base-10 integer."""
    if value is None:
        return 0
    try:
        cursor = int(value, 10)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Last-Event-ID must be an integer") from error
    if cursor < 0:
        raise HTTPException(status_code=400, detail="Last-Event-ID must be non-negative")
    return cursor


def encode_event(seq: int, event_type: str, data: object) -> str:
    """Encode one persisted RunEvent as a named SSE frame."""
    return f"id: {seq}\nevent: {event_type}\ndata: {canonical_json(data)}\n\n"


async def iter_sse_events(
    store: SQLiteStore,
    run_id: str,
    cursor: int,
    subscription: RunSubscription,
    *,
    heartbeat_interval: float,
    terminal_at_cursor: bool = False,
) -> AsyncIterator[str]:
    """Replay durable events, then requery after every notifier wake or heartbeat."""
    try:
        if terminal_at_cursor:
            await asyncio.sleep(0)
            return
        while True:
            observed_version = subscription.version
            events = await asyncio.to_thread(store.list_events, run_id, cursor)
            for event in events:
                cursor = event.seq
                yield encode_event(event.seq, event.type, event.data)
                if event.type in TERMINAL_EVENTS:
                    return
            if subscription.version != observed_version:
                continue
            try:
                await subscription.wait_for_greater_than(
                    observed_version,
                    timeout=heartbeat_interval,
                )
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
    finally:
        subscription.close()


async def create_sse_response(
    store: SQLiteStore,
    notifier: RunNotifier,
    run_id: str,
    last_event_id: str | None,
    *,
    heartbeat_interval: float,
) -> StreamingResponse:
    """Validate Run and cursor before constructing the streaming response."""
    subscription = notifier.subscribe(run_id)
    try:
        cursor = parse_last_event_id(last_event_id)
        run = await asyncio.to_thread(store.get_run, run_id)
        if cursor > run.last_event_seq:
            raise HTTPException(status_code=409, detail="Last-Event-ID is ahead of the Run")
        terminal_at_cursor = run.state in {"succeeded", "failed"} and (cursor == run.last_event_seq)
    except NotFoundError as error:
        subscription.close()
        raise HTTPException(status_code=404, detail=str(error)) from error
    except BaseException:
        subscription.close()
        raise

    return StreamingResponse(
        iter_sse_events(
            store,
            run_id,
            cursor,
            subscription,
            heartbeat_interval=heartbeat_interval,
            terminal_at_cursor=terminal_at_cursor,
        ),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
