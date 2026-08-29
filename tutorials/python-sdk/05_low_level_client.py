"""Drive the DSH runtime through the Python SDK's low-level client."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from deepseek_harness import HarnessClient, HarnessConfig, Notification


def inbox_contains_message(notification: Notification, message_id: str) -> bool:
    """Return whether an inbox event durably records the selected message."""
    if notification.method != "session.event":
        return False
    event = notification.payload.get("event")
    if not isinstance(event, dict) or event.get("type") != "agent/inbox/spliced":
        return False
    data = event.get("data")
    inserted = data.get("inserted") if isinstance(data, dict) else None
    return isinstance(inserted, list) and any(
        isinstance(item, dict) and item.get("id") == message_id for item in inserted
    )


def main() -> None:
    """Initialize, enqueue one prompt, and consume notifications through idle."""
    parser = argparse.ArgumentParser(
        description="Drive the runtime through HarnessClient directly."
    )
    parser.add_argument("prompt", nargs="?", default="Reply with exactly: low level client ok")
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--session-id", default="python-demo-low-level")
    parser.add_argument("--session-root", type=Path, default=Path(".dsh-python-demo-sessions"))
    args = parser.parse_args()

    cwd = Path.cwd().resolve()
    config = HarnessConfig(
        env={
            "DSH_CWD": str(cwd),
            "DSH_SESSION_ROOT": str(args.session_root.resolve()),
        }
    )
    with HarnessClient(config) as client:
        info = client.initialize(cwd=str(cwd), provider=args.provider, model=args.model)
        with client.subscribe_session_notifications(args.session_id) as subscription:
            message_id = client.session_prompt(
                args.session_id,
                [{"type": "text", "text": args.prompt}],
                notification_subscription=subscription,
            )
            received = False
            event_count = 0
            print("stream:")
            while True:
                notification: Notification = subscription.next()
                received = received or inbox_contains_message(notification, message_id)
                if notification.method == "session.event":
                    event = notification.payload.get("event")
                    if isinstance(event, dict):
                        event_count += 1
                        data = event.get("data")
                        if (
                            notification.payload.get("sessionId") == args.session_id
                            and event.get("type") == "assistant/chunk"
                            and isinstance(data, dict)
                        ):
                            chunk = data.get("chunk")
                            if isinstance(chunk, dict) and chunk.get("type") == "text-delta":
                                print(str(chunk.get("text", "")), end="", flush=True)
                if (
                    received
                    and notification.method == "session.status"
                    and notification.payload.get("sessionId") == args.session_id
                    and notification.payload.get("status") == "idle"
                ):
                    break
        print()
        print(f"server: {info.serverInfo}")
        print(f"message_id: {message_id}")
        print(f"event_count: {event_count}")


if __name__ == "__main__":
    main()
