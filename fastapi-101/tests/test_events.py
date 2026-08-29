from __future__ import annotations

import json

from deepseek_harness import Notification

from dsh_fastapi_101.events import BrowserEvent, encode_sse, project_notification


def test_projects_root_text_and_excludes_descendant_text() -> None:
    root = Notification(
        method="session.event",
        payload={
            "sessionId": "root",
            "event": {
                "type": "assistant/chunk",
                "data": {"chunk": {"type": "text-delta", "text": "hello"}},
            },
        },
    )
    child = Notification(
        method="session.event",
        payload={
            "sessionId": "child",
            "event": {
                "type": "assistant/chunk",
                "data": {"chunk": {"type": "text-delta", "text": "hidden child"}},
            },
        },
    )

    assert project_notification(root, "root") == BrowserEvent(
        type="text_delta",
        session_id="root",
        data={"text": "hello"},
    )
    assert project_notification(child, "root") is None


def test_projects_status_tool_and_subagent_events() -> None:
    status = Notification(
        method="session.status",
        payload={"sessionId": "root", "status": "running"},
    )
    tool = Notification(
        method="session.event",
        payload={
            "sessionId": "root",
            "event": {
                "type": "tool/call",
                "data": {"callId": "call-1", "name": "bash", "arguments": "{\"command\":\"pwd\"}"},
            },
        },
    )
    child = Notification(
        method="subagent.started",
        payload={"parentSessionId": "root", "childSessionId": "child"},
    )

    assert project_notification(status, "root") == BrowserEvent(
        type="status", session_id="root", data={"status": "running"}
    )
    assert project_notification(tool, "root") == BrowserEvent(
        type="tool_call",
        session_id="root",
        data={"call_id": "call-1", "name": "bash", "arguments": {"command": "pwd"}},
    )
    assert project_notification(child, "root") == BrowserEvent(
        type="subagent_started",
        session_id="child",
        data={"parent_session_id": "root"},
    )


def test_encodes_one_browser_event_as_sse() -> None:
    event = BrowserEvent(type="text_delta", session_id="root", data={"text": "你好\nworld"})

    frame = encode_sse(event).decode()

    assert frame.startswith("event: text_delta\n")
    payload = json.loads(frame.split("data: ", 1)[1].strip())
    assert payload == {"type": "text_delta", "session_id": "root", "data": {"text": "你好\nworld"}}
