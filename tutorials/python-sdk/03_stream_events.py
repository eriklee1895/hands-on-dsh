"""Project committed DSH assistant messages from session notifications."""

from __future__ import annotations

import argparse
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from deepseek_harness import DeepSeekHarness, Notification

from demo_resources import DemoResources


def committed_text_from(
    notification: Notification | Mapping[str, Any],
    *,
    session_id: str | None = None,
) -> str | None:
    """Return root assistant text after its message is committed, if present."""
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
    if not isinstance(event, Mapping) or event.get("type") != "assistant/message":
        return None
    data = event.get("data")
    message = data.get("message") if isinstance(data, Mapping) else None
    content_owner = message if isinstance(message, Mapping) else data
    content = content_owner.get("content") if isinstance(content_owner, Mapping) else None
    if not isinstance(content, list):
        return None
    return "".join(
        str(block.get("text") or "")
        for block in content
        if isinstance(block, Mapping) and block.get("type") == "text"
    )


def main() -> None:
    """Print each committed root assistant message during one run."""
    parser = argparse.ArgumentParser(
        description="Project committed assistant messages from DSH notifications."
    )
    parser.add_argument(
        "prompt",
        nargs="?",
        default="Explain in three short bullets what an agent runtime does.",
    )
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--session-id", default="python-demo-stream")
    parser.add_argument("--dsh-home", type=Path)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--profile", default="sdk-minimal")
    parser.add_argument("--patch", type=Path, action="append", default=[])
    args = parser.parse_args()

    projected: list[str] = []

    def on_notification(notification: Notification) -> None:
        text = committed_text_from(notification, session_id=args.session_id)
        if text is not None:
            projected.append(text)
            print(f"committed_message: {text}", flush=True)

    with DemoResources("dsh-python-notifications") as resources:
        root = resources.root
        workspace = (args.workspace or root / "workspace").resolve()
        workspace.mkdir(parents=True, exist_ok=True)
        home = (args.dsh_home or root / "home").resolve()
        with resources.own(
            DeepSeekHarness(
                provider=args.provider,
                model=args.model,
                cwd=str(workspace),
                dsh_home=str(home),
                profile=args.profile,
                patches=tuple(str(patch.resolve()) for patch in args.patch),
            )
        ) as harness:
            session = harness.start_session(args.session_id)
            result = session.run(args.prompt, on_notification=on_notification)
    if (
        result.finish_reason != "completed"
        or not projected
        or projected[-1] != result.final_response
    ):
        raise RuntimeError("notification projection did not match a completed root response")
    print(f"final_response: {result.final_response}")
    print(f"committed_message_count: {len(projected)}")
    print(f"finish_reason: {result.finish_reason}")
    print(f"notification_count: {len(result.notifications)}")


if __name__ == "__main__":
    main()
