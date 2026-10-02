"""Drive the DSH runtime through the Python SDK's low-level client."""

from __future__ import annotations

import argparse
import os
import queue
import threading
import time
from pathlib import Path

from deepseek_harness import HarnessClient, HarnessConfig, Notification

from demo_resources import DemoResources, finite_positive_timeout


def inbox_contains_message(
    notification: Notification, message_id: str, session_id: str | None = None
) -> bool:
    """Return whether an inbox event durably records the selected message."""
    if notification.method != "session.event" or (
        session_id is not None and notification.payload.get("sessionId") != session_id
    ):
        return False
    event = notification.payload.get("event")
    if not isinstance(event, dict) or event.get("type") != "agent/inbox/spliced":
        return False
    data = event.get("data")
    inserted = data.get("inserted") if isinstance(data, dict) else None
    return isinstance(inserted, list) and any(
        isinstance(item, dict) and item.get("id") == message_id for item in inserted
    )


def next_before_deadline(
    incoming: queue.Queue[Notification | BaseException], deadline: float
) -> Notification:
    """Reject an expired activity deadline even when frames remain queued."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("agent activity did not reach idle before deadline")
    try:
        item = incoming.get(timeout=remaining)
    except queue.Empty as exc:
        raise TimeoutError("agent activity did not reach idle before deadline") from exc
    if isinstance(item, BaseException):
        raise item
    return item


def main() -> None:
    """Initialize, enqueue one prompt, and consume notifications through idle."""
    parser = argparse.ArgumentParser(
        description="Drive the runtime through HarnessClient directly."
    )
    parser.add_argument("prompt", nargs="?", default="Reply with exactly: low level client ok")
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--session-id", default="python-demo-low-level")
    parser.add_argument("--dsh-home", type=Path)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--profile", default="sdk-minimal")
    parser.add_argument("--patch", type=Path, action="append", default=[])
    parser.add_argument("--timeout", type=finite_positive_timeout, default=180.0)
    args = parser.parse_args()

    with DemoResources("dsh-python-client") as resources:
        root = resources.root
        workspace = (args.workspace or root / "workspace").resolve()
        workspace.mkdir(parents=True, exist_ok=True)
        config = HarnessConfig(
            dsh_home=str((args.dsh_home or root / "home").resolve()),
            profile=args.profile,
            patches=tuple(str(patch.resolve()) for patch in args.patch),
            cwd=str(workspace),
            request_timeout_seconds=args.timeout,
        )
        with resources.own(HarnessClient(config)) as client:
            info = client.initialize(cwd=str(workspace), provider=args.provider, model=args.model)
            with client.subscribe_session_notifications(args.session_id) as subscription:
                message_id = client.session_prompt(
                    args.session_id,
                    [{"type": "text", "text": args.prompt}],
                    notification_subscription=subscription,
                )
                deadline = time.monotonic() + args.timeout
                received = False
                event_count = 0
                committed: list[str] = []
                finish_reason: str | None = None
                incoming: queue.Queue[Notification | BaseException] = queue.Queue()

                def read_notifications() -> None:
                    try:
                        while True:
                            incoming.put(subscription.next())
                    except BaseException as exc:
                        incoming.put(exc)

                reader = threading.Thread(
                    target=read_notifications, name="dsh-client-demo", daemon=True
                )
                reader.start()
                while True:
                    try:
                        notification = next_before_deadline(incoming, deadline)
                    except TimeoutError:
                        client.close()
                        raise
                    received = received or inbox_contains_message(
                        notification, message_id, args.session_id
                    )
                    if not received:
                        continue
                    if (
                        notification.method == "session.event"
                        and notification.payload.get("sessionId") == args.session_id
                    ):
                        event = notification.payload.get("event")
                        if isinstance(event, dict):
                            event_count += 1
                            if event.get("type") == "assistant/message":
                                data = event.get("data")
                                message = data.get("message") if isinstance(data, dict) else None
                                content = (
                                    message.get("content") if isinstance(message, dict) else None
                                )
                                if isinstance(content, list):
                                    committed.append(
                                        "".join(
                                            str(block.get("text") or "")
                                            for block in content
                                            if isinstance(block, dict)
                                            and block.get("type") == "text"
                                        )
                                    )
                            if event.get("type") == "turn/end":
                                data = event.get("data")
                                reason = data.get("reason") if isinstance(data, dict) else None
                                finish_reason = (
                                    reason.get("kind") if isinstance(reason, dict) else None
                                )
                    if (
                        notification.method == "session.status"
                        and notification.payload.get("sessionId") == args.session_id
                        and notification.payload.get("status") == "idle"
                    ):
                        break
            if finish_reason != "completed" or not committed:
                raise RuntimeError(f"agent did not commit a completed response: {finish_reason}")
            print(f"server: {info.serverInfo}")
            print(f"message_id: {message_id}")
            print(f"event_count: {event_count}")
            print(f"committed_response: {committed[-1] if committed else ''}")


if __name__ == "__main__":
    main()
