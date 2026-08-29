"""Project detailed DSH notifications into a stable browser event vocabulary."""

from __future__ import annotations

import json
from typing import Any

from deepseek_harness import Notification
from pydantic import BaseModel


class BrowserEvent(BaseModel):
    """One event safe to serialize to the tutorial browser client."""

    type: str
    session_id: str
    data: dict[str, Any]


def encode_sse(event: BrowserEvent) -> bytes:
    """Encode one named server-sent event frame."""
    payload = json.dumps(event.model_dump(), ensure_ascii=False, separators=(",", ":"))
    return f"event: {event.type}\ndata: {payload}\n\n".encode()


def project_notification(notification: Notification, root_session_id: str) -> BrowserEvent | None:
    """Map one SDK notification to a browser event, omitting model reasoning."""
    payload = notification.payload
    if notification.method == "session.status":
        session_id = payload.get("sessionId")
        status = payload.get("status")
        if isinstance(session_id, str) and isinstance(status, str):
            return BrowserEvent(type="status", session_id=session_id, data={"status": status})
        return None

    if notification.method == "subagent.started":
        parent = payload.get("parentSessionId")
        child = payload.get("childSessionId")
        if isinstance(parent, str) and isinstance(child, str):
            return BrowserEvent(
                type="subagent_started",
                session_id=child,
                data={"parent_session_id": parent},
            )
        return None

    if notification.method == "subagent.finished":
        child = payload.get("childSessionId")
        if isinstance(child, str):
            return BrowserEvent(
                type="subagent_finished",
                session_id=child,
                data={
                    "parent_session_id": payload.get("parentSessionId"),
                    "status": payload.get("status"),
                    "stop_reason": payload.get("stopReason"),
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
        return BrowserEvent(type="text_delta", session_id=session_id, data={"text": text})

    if event_type == "tool/call":
        arguments = _decode_arguments(data.get("arguments"))
        return BrowserEvent(
            type="tool_call",
            session_id=session_id,
            data={
                "call_id": data.get("callId"),
                "name": data.get("name"),
                "arguments": arguments,
            },
        )

    if event_type == "tool/result":
        call_id, text, is_error = _tool_result(data)
        return BrowserEvent(
            type="tool_result",
            session_id=session_id,
            data={"call_id": call_id, "text": text, "is_error": is_error},
        )

    if event_type in {"turn/start", "turn/end", "step/start", "step/end"}:
        lifecycle = {"event_type": event_type, "turn": data.get("turn")}
        if "step" in data:
            lifecycle["step"] = data["step"]
        if "reason" in data:
            lifecycle["reason"] = data["reason"]
        return BrowserEvent(type="lifecycle", session_id=session_id, data=lifecycle)
    return None


def _decode_arguments(value: object) -> object:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def _tool_result(data: dict[str, Any]) -> tuple[object, str, bool]:
    message = data.get("message")
    source = message.get("source") if isinstance(message, dict) else None
    call_id = source.get("callId") if isinstance(source, dict) else None
    texts: list[str] = []
    is_error = False
    blocks = message.get("content") if isinstance(message, dict) else None
    if isinstance(blocks, list):
        for block in blocks:
            if not isinstance(block, dict) or block.get("type") != "tool-result":
                continue
            is_error = is_error or block.get("isError") is True
            content = block.get("content")
            if isinstance(content, list):
                texts.extend(
                    item["text"]
                    for item in content
                    if isinstance(item, dict) and isinstance(item.get("text"), str)
                )
    return call_id, "".join(texts), is_error
