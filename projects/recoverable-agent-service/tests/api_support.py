from __future__ import annotations

import asyncio
import importlib
from pathlib import Path
from typing import Any

import pytest


def load_app_module():
    try:
        return importlib.import_module("recoverable_agent_service.app")
    except ImportError as error:
        pytest.fail(f"Task 1C FastAPI application is not implemented: {error}")


def make_store(database_path: Path):
    store_module = importlib.import_module("recoverable_agent_service.store")
    repository = store_module.SQLiteStore(database_path)
    repository.migrate()
    return repository


class ControlledCoordinator:
    def __init__(self, store: Any, notifier: Any | None = None) -> None:
        notifier_module = importlib.import_module("recoverable_agent_service.notifier")
        self.store = store
        self.notifier = notifier or notifier_module.RunNotifier()
        self.started = 0
        self.closed = 0
        self.accepting = False
        self.worker_running = False
        self.calls: list[tuple[str, str]] = []

    async def start(self) -> None:
        self.started += 1
        self.accepting = True
        self.worker_running = True

    async def close(self) -> None:
        self.closed += 1
        self.accepting = False
        self.worker_running = False

    async def submit_run(
        self,
        conversation_id: str,
        idempotency_key: object,
        prompt: object,
        artifact_names: list[str],
    ):
        submission = await asyncio.to_thread(
            self.store.submit_run,
            conversation_id,
            idempotency_key,
            prompt,
            artifact_names,
        )
        if submission.created:
            self.notifier.publish(submission.run.id)
        return submission

    async def acknowledge_recovery(self, conversation_id: str):
        return await asyncio.to_thread(self.store.acknowledge_recovery, conversation_id)
