from __future__ import annotations

import asyncio
import importlib

import pytest


def load_notifier():
    try:
        return importlib.import_module("recoverable_agent_service.notifier")
    except ImportError as error:
        pytest.fail(f"Task 1B notifier is not implemented: {error}")


def test_publish_wakes_subscriber_and_closes_without_retaining_versions() -> None:
    notifier_module = load_notifier()

    async def scenario() -> None:
        notifier = notifier_module.RunNotifier()
        subscription = notifier.subscribe("run-1")
        assert subscription.version == 0

        notifier.publish("run-1")

        assert await subscription.wait_for_greater_than(0) == 1
        subscription.close()
        subscription.close()
        notifier.publish("run-1")
        replacement = notifier.subscribe("run-1")
        assert replacement.version == 0
        replacement.close()

    asyncio.run(scenario())


def test_publish_between_version_read_and_wait_cannot_be_missed() -> None:
    notifier_module = load_notifier()

    async def scenario() -> None:
        notifier = notifier_module.RunNotifier()
        subscription = notifier.subscribe("run-1")
        observed = subscription.version
        notifier.publish("run-1")

        version = await asyncio.wait_for(subscription.wait_for_greater_than(observed), timeout=0.1)

        assert version == 1
        subscription.close()

    asyncio.run(scenario())


def test_multiple_subscribers_wake_on_each_new_version() -> None:
    notifier_module = load_notifier()

    async def scenario() -> None:
        notifier = notifier_module.RunNotifier()
        first = notifier.subscribe("run-1")
        second = notifier.subscribe("run-1")
        first_wait = asyncio.create_task(first.wait_for_greater_than(0))
        second_wait = asyncio.create_task(second.wait_for_greater_than(0))
        await asyncio.sleep(0)

        notifier.publish("run-1")

        assert await first_wait == 1
        assert await second_wait == 1
        first.close()
        second.close()

    asyncio.run(scenario())


def test_wait_supports_timeout_and_cancellation_without_corrupting_subscription() -> None:
    notifier_module = load_notifier()

    async def scenario() -> None:
        notifier = notifier_module.RunNotifier()
        subscription = notifier.subscribe("run-1")
        with pytest.raises(asyncio.TimeoutError):
            await subscription.wait_for_greater_than(0, timeout=0.01)

        waiting = asyncio.create_task(subscription.wait_for_greater_than(0))
        await asyncio.sleep(0)
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting

        notifier.publish("run-1")
        assert await subscription.wait_for_greater_than(0) == 1
        subscription.close()
        with pytest.raises(RuntimeError, match="closed"):
            await subscription.wait_for_greater_than(1)

    asyncio.run(scenario())
