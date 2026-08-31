"""Project DSH notifications into persisted application events."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from deepseek_harness import Notification

SUBAGENT_STOP_REASONS = {"completed", "aborted", "error", "max-tokens", "refusal"}


@dataclass(frozen=True)
class RuntimeEvent:
    """One stable event emitted by a runtime adapter."""

    type: str
    data: dict[str, Any]


def project_notification(notification: Notification, root_session_id: str) -> RuntimeEvent | None:
    """Map one supported SDK notification without exposing reasoning or unknown events."""
    payload = notification.payload
    if notification.method == "session.status":
        session_id = payload.get("sessionId")
        status = payload.get("status")
        if (
            isinstance(session_id, str)
            and isinstance(status, str)
            and status in {"idle", "running"}
        ):
            return RuntimeEvent(type="status", data={"session_id": session_id, "status": status})
        return None

    if notification.method == "subagent.started":
        parent = payload.get("parentSessionId")
        child = payload.get("childSessionId")
        if isinstance(parent, str) and isinstance(child, str):
            return RuntimeEvent(
                type="subagent_started",
                data={"session_id": child, "parent_session_id": parent},
            )
        return None

    if notification.method == "subagent.finished":
        provider = payload.get("provider")
        agent_id = payload.get("agentId")
        parent = payload.get("parentSessionId")
        child = payload.get("childSessionId")
        status = payload.get("status")
        stop_reason = payload.get("stopReason")
        if (
            isinstance(provider, str)
            and isinstance(agent_id, str)
            and isinstance(parent, str)
            and isinstance(child, str)
            and isinstance(status, str)
            and status in {"ok", "error"}
            and isinstance(stop_reason, str)
            and stop_reason in SUBAGENT_STOP_REASONS
        ):
            return RuntimeEvent(
                type="subagent_finished",
                data={
                    "session_id": child,
                    "parent_session_id": parent,
                    "status": status,
                    "stop_reason": stop_reason,
                },
            )
        return None

    if notification.method != "session.event":
        return None
    session_id = payload.get("sessionId")
    event = payload.get("event")
    if not isinstance(session_id, str) or not isinstance(event, dict):
        return None
    event_type = event.get("type")
    data = event.get("data")
    if not isinstance(event_type, str) or not isinstance(data, dict):
        return None

    if event_type == "assistant/chunk":
        if session_id != root_session_id:
            return None
        chunk = data.get("chunk")
        if not isinstance(chunk, dict) or chunk.get("type") != "text-delta":
            return None
        text = chunk.get("text")
        if not isinstance(text, str):
            return None
        return RuntimeEvent(type="text_delta", data={"session_id": session_id, "text": text})

    if event_type == "tool/call":
        call_id = data.get("callId")
        name = data.get("name")
        arguments = data.get("arguments")
        if not (isinstance(call_id, str) and isinstance(name, str) and isinstance(arguments, str)):
            return None
        return RuntimeEvent(
            type="tool_call",
            data={
                "session_id": session_id,
                "call_id": call_id,
                "name": name,
                "arguments": _decode_arguments(arguments),
            },
        )

    if event_type == "tool/result":
        result = _tool_result(data)
        if result is None:
            return None
        call_id, text, is_error = result
        return RuntimeEvent(
            type="tool_result",
            data={
                "session_id": session_id,
                "call_id": call_id,
                "text": text,
                "is_error": is_error,
            },
        )

    turn = data.get("turn")
    if event_type == "turn/start":
        if type(turn) is not int:
            return None
        return RuntimeEvent(
            type="lifecycle",
            data={"session_id": session_id, "event_type": event_type, "turn": turn},
        )

    if event_type == "turn/end":
        reason = data.get("reason")
        if type(turn) is not int or not isinstance(reason, dict):
            return None
        reason_kind = reason.get("kind")
        if not isinstance(reason_kind, str) or not reason_kind:
            return None
        return RuntimeEvent(
            type="lifecycle",
            data={
                "session_id": session_id,
                "event_type": event_type,
                "turn": turn,
                "reason": reason,
            },
        )

    if event_type in {"step/start", "step/end"}:
        step = data.get("step")
        if type(turn) is not int or type(step) is not int:
            return None
        return RuntimeEvent(
            type="lifecycle",
            data={
                "session_id": session_id,
                "event_type": event_type,
                "turn": turn,
                "step": step,
            },
        )
    return None


def _decode_arguments(value: object) -> object:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def _tool_result(data: dict[str, Any]) -> tuple[str, str, bool] | None:
    message = data.get("message")
    source = message.get("source") if isinstance(message, dict) else None
    call_id = source.get("callId") if isinstance(source, dict) else None
    blocks = message.get("content") if isinstance(message, dict) else None
    if not isinstance(call_id, str) or not isinstance(blocks, list):
        return None
    texts: list[str] = []
    is_error = False
    found_result = False
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "tool-result":
            continue
        block_error = block.get("isError")
        content = block.get("content")
        if not isinstance(block_error, bool) or not isinstance(content, list):
            return None
        found_result = True
        is_error = is_error or block_error
        texts.extend(
            item["text"]
            for item in content
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        )
    if not found_result:
        return None
    return call_id, "".join(texts), is_error
