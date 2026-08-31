from __future__ import annotations

import importlib

import pytest
from deepseek_harness import Notification


def load_events():
    try:
        return importlib.import_module("recoverable_agent_service.events")
    except ImportError as error:
        pytest.fail(f"Task 1B event projection is not implemented: {error}")


def test_projection_keeps_root_text_and_filters_descendant_reasoning_and_unknown() -> None:
    events = load_events()

    root_text = Notification(
        method="session.event",
        payload={
            "sessionId": "root",
            "event": {
                "type": "assistant/chunk",
                "data": {"chunk": {"type": "text-delta", "text": "hello"}},
            },
        },
    )
    child_text = Notification(
        method="session.event",
        payload={
            "sessionId": "child",
            "event": {
                "type": "assistant/chunk",
                "data": {"chunk": {"type": "text-delta", "text": "private child text"}},
            },
        },
    )
    reasoning = Notification(
        method="session.event",
        payload={
            "sessionId": "root",
            "event": {
                "type": "assistant/chunk",
                "data": {"chunk": {"type": "reasoning-delta", "text": "private reasoning"}},
            },
        },
    )
    unknown = Notification(method="future.notification", payload={"value": "ignore me"})

    assert events.project_notification(root_text, "root") == events.RuntimeEvent(
        type="text_delta",
        data={"session_id": "root", "text": "hello"},
    )
    assert events.project_notification(child_text, "root") is None
    assert events.project_notification(reasoning, "root") is None
    assert events.project_notification(unknown, "root") is None


def test_projection_maps_status_lifecycle_tool_and_subagent_events() -> None:
    events = load_events()
    notifications = [
        Notification(
            method="session.status",
            payload={"sessionId": "root", "status": "running"},
        ),
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {"type": "turn/start", "data": {"turn": 3}},
            },
        ),
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {
                    "type": "tool/call",
                    "data": {
                        "callId": "call-1",
                        "name": "bash",
                        "arguments": '{"command":"pwd"}',
                    },
                },
            },
        ),
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {
                    "type": "tool/result",
                    "data": {
                        "message": {
                            "source": {"callId": "call-1"},
                            "content": [
                                {
                                    "type": "tool-result",
                                    "isError": False,
                                    "content": [{"type": "text", "text": "/workspace"}],
                                }
                            ],
                        }
                    },
                },
            },
        ),
        Notification(
            method="subagent.started",
            payload={"parentSessionId": "root", "childSessionId": "child"},
        ),
        Notification(
            method="subagent.finished",
            payload={
                "provider": "local",
                "agentId": "child",
                "parentSessionId": "root",
                "childSessionId": "child",
                "status": "ok",
                "stopReason": "completed",
            },
        ),
    ]

    assert [events.project_notification(item, "root") for item in notifications] == [
        events.RuntimeEvent(type="status", data={"session_id": "root", "status": "running"}),
        events.RuntimeEvent(
            type="lifecycle",
            data={"session_id": "root", "event_type": "turn/start", "turn": 3},
        ),
        events.RuntimeEvent(
            type="tool_call",
            data={
                "session_id": "root",
                "call_id": "call-1",
                "name": "bash",
                "arguments": {"command": "pwd"},
            },
        ),
        events.RuntimeEvent(
            type="tool_result",
            data={
                "session_id": "root",
                "call_id": "call-1",
                "text": "/workspace",
                "is_error": False,
            },
        ),
        events.RuntimeEvent(
            type="subagent_started",
            data={"session_id": "child", "parent_session_id": "root"},
        ),
        events.RuntimeEvent(
            type="subagent_finished",
            data={
                "session_id": "child",
                "parent_session_id": "root",
                "status": "ok",
                "stop_reason": "completed",
            },
        ),
    ]


@pytest.mark.parametrize(
    "notification",
    [
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {
                    "type": "tool/call",
                    "data": {"name": "bash", "arguments": "{}"},
                },
            },
        ),
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {
                    "type": "tool/result",
                    "data": {"message": {"source": {}, "content": []}},
                },
            },
        ),
        Notification(
            method="subagent.started",
            payload={"parentSessionId": "root"},
        ),
        Notification(
            method="subagent.finished",
            payload={
                "provider": "local",
                "agentId": "child",
                "parentSessionId": "root",
                "childSessionId": "child",
                "status": 7,
                "stopReason": "done",
            },
        ),
        Notification(
            method="subagent.finished",
            payload={
                "provider": "local",
                "agentId": "child",
                "parentSessionId": "root",
                "childSessionId": "child",
                "status": "ok",
                "stopReason": {"unexpected": True},
            },
        ),
    ],
)
def test_projection_drops_malformed_supported_tool_and_subagent_events(
    notification: Notification,
) -> None:
    events = load_events()

    assert events.project_notification(notification, "root") is None


@pytest.mark.parametrize(
    "notification",
    [
        Notification(
            method="session.status",
            payload={"sessionId": "root", "status": "paused"},
        ),
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {"type": "turn/start", "data": {"turn": "1"}},
            },
        ),
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {"type": "turn/end", "data": {"turn": 1}},
            },
        ),
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {
                    "type": "turn/end",
                    "data": {"turn": 1, "reason": "completed"},
                },
            },
        ),
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {"type": "step/start", "data": {"turn": 1}},
            },
        ),
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {"type": "step/end", "data": {"turn": 1, "step": "2"}},
            },
        ),
    ],
)
def test_projection_drops_malformed_supported_status_and_lifecycle_events(
    notification: Notification,
) -> None:
    events = load_events()

    assert events.project_notification(notification, "root") is None


def test_projection_maps_every_valid_lifecycle_variant() -> None:
    events = load_events()
    notifications = [
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {
                    "type": "turn/end",
                    "data": {"turn": 1, "reason": {"kind": "completed"}},
                },
            },
        ),
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {"type": "step/start", "data": {"turn": 1, "step": 2}},
            },
        ),
        Notification(
            method="session.event",
            payload={
                "sessionId": "root",
                "event": {"type": "step/end", "data": {"turn": 1, "step": 2}},
            },
        ),
    ]

    assert [events.project_notification(item, "root") for item in notifications] == [
        events.RuntimeEvent(
            type="lifecycle",
            data={
                "session_id": "root",
                "event_type": "turn/end",
                "turn": 1,
                "reason": {"kind": "completed"},
            },
        ),
        events.RuntimeEvent(
            type="lifecycle",
            data={"session_id": "root", "event_type": "step/start", "turn": 1, "step": 2},
        ),
        events.RuntimeEvent(
            type="lifecycle",
            data={"session_id": "root", "event_type": "step/end", "turn": 1, "step": 2},
        ),
    ]


@pytest.mark.parametrize("kind", [None, "", 7])
def test_projection_drops_turn_end_with_missing_empty_or_nonstring_reason_kind(
    kind: object,
) -> None:
    events = load_events()
    reason = {} if kind is None else {"kind": kind}
    notification = Notification(
        method="session.event",
        payload={
            "sessionId": "root",
            "event": {"type": "turn/end", "data": {"turn": 1, "reason": reason}},
        },
    )

    assert events.project_notification(notification, "root") is None


def test_projection_preserves_future_string_turn_end_reason_kind() -> None:
    events = load_events()
    notification = Notification(
        method="session.event",
        payload={
            "sessionId": "root",
            "event": {
                "type": "turn/end",
                "data": {"turn": 4, "reason": {"kind": "future-provider-stop"}},
            },
        },
    )

    assert events.project_notification(notification, "root") == events.RuntimeEvent(
        type="lifecycle",
        data={
            "session_id": "root",
            "event_type": "turn/end",
            "turn": 4,
            "reason": {"kind": "future-provider-stop"},
        },
    )
