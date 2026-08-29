#!/usr/bin/env python3
"""Project DSH session notifications into a live terminal stream."""

from __future__ import annotations

import argparse
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from deepseek_harness import DeepSeekHarness, Notification


def text_delta_from(
    notification: Notification | Mapping[str, Any],
    *,
    session_id: str | None = None,
) -> str | None:
    """Return committed assistant text from one DSH notification, if present."""
    if isinstance(notification, Notification):
        method = notification.method
        payload: Mapping[str, Any] = notification.payload
    else:
        method = notification.get("method")
        raw_payload = notification.get("params")
        payload = raw_payload if isinstance(raw_payload, Mapping) else {}
    if method != "session.event":
        return None
    if session_id is not None and payload.get("sessionId") != session_id:
        return None
    event = payload.get("event")
    if not isinstance(event, Mapping) or event.get("type") != "assistant/chunk":
        return None
    data = event.get("data")
    chunk = data.get("chunk") if isinstance(data, Mapping) else None
    if not isinstance(chunk, Mapping) or chunk.get("type") != "text-delta":
        return None
    text = chunk.get("text")
    return text if isinstance(text, str) else None


def main() -> None:
    """Print assistant text deltas while one high-level run is active."""
    parser = argparse.ArgumentParser(description="Stream assistant text from DSH notifications.")
    parser.add_argument(
        "prompt",
        nargs="?",
        default="Explain in three short bullets what an agent runtime does.",
    )
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--session-id", default="python-demo-stream")
    parser.add_argument("--session-root", type=Path, default=Path(".dsh-python-demo-sessions"))
    args = parser.parse_args()

    streamed = False

    def on_notification(notification: Notification) -> None:
        nonlocal streamed
        delta = text_delta_from(notification, session_id=args.session_id)
        if delta is not None:
            streamed = True
            print(delta, end="", flush=True)

    print("stream:")
    with DeepSeekHarness(
        provider=args.provider,
        model=args.model,
        session_root=str(args.session_root.resolve()),
    ) as harness:
        session = harness.start_session(args.session_id)
        result = session.run(args.prompt, on_notification=on_notification)
    if streamed:
        print()
    print(f"finish_reason: {result.finish_reason}")
    print(f"notification_count: {len(result.notifications)}")


if __name__ == "__main__":
    main()
