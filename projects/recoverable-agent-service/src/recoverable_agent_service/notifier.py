"""Per-Run wake notifications without duplicating durable event payloads."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field


@dataclass
class _Topic:
    version: int = 0
    subscribers: int = 0
    changed: asyncio.Event = field(default_factory=asyncio.Event)


class RunNotifier:
    """Own active per-Run version counters used only to wake database readers."""

    def __init__(self) -> None:
        self._topics: dict[str, _Topic] = {}

    def subscribe(self, run_id: str) -> RunSubscription:
        """Register one subscription at the Run's current in-memory version."""
        topic = self._topics.setdefault(run_id, _Topic())
        topic.subscribers += 1
        return RunSubscription(self, run_id, topic)

    def publish(self, run_id: str) -> None:
        """Increment the version and wake every active subscriber after a commit."""
        topic = self._topics.get(run_id)
        if topic is None:
            return
        topic.version += 1
        changed = topic.changed
        topic.changed = asyncio.Event()
        changed.set()

    def _unsubscribe(self, run_id: str, topic: _Topic) -> None:
        current = self._topics.get(run_id)
        if current is not topic:
            return
        topic.subscribers -= 1
        changed = topic.changed
        topic.changed = asyncio.Event()
        changed.set()
        if topic.subscribers == 0:
            del self._topics[run_id]


class RunSubscription:
    """One idempotently closable view of a Run notifier version."""

    def __init__(self, owner: RunNotifier, run_id: str, topic: _Topic) -> None:
        self._owner = owner
        self._run_id = run_id
        self._topic = topic
        self._closed = False

    @property
    def version(self) -> int:
        """Return the latest version observed by this topic."""
        return self._topic.version

    async def wait_for_greater_than(
        self,
        version: int,
        *,
        timeout: float | None = None,
    ) -> int:
        """Wait until publish advances beyond version, without a read/wait race."""

        async def wait() -> int:
            while True:
                if self._closed:
                    raise RuntimeError("subscription is closed")
                if self._topic.version > version:
                    return self._topic.version
                changed = self._topic.changed
                if self._topic.version > version:
                    continue
                await changed.wait()

        if timeout is None:
            return await wait()
        return await asyncio.wait_for(wait(), timeout=timeout)

    def close(self) -> None:
        """Unregister this subscription idempotently and release an empty topic."""
        if self._closed:
            return
        self._closed = True
        self._owner._unsubscribe(self._run_id, self._topic)
