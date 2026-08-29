"""HTTP request and response models owned by the tutorial application."""

from __future__ import annotations

import uuid

from pydantic import BaseModel, Field, field_validator


class ChatRequest(BaseModel):
    """One business prompt addressed to an application-owned session ID."""

    prompt: str = Field(min_length=1, max_length=40_000)
    session_id: str = Field(
        default_factory=lambda: f"web-{uuid.uuid4().hex}",
        min_length=1,
        max_length=160,
    )

    @field_validator("prompt", "session_id")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        """Strip edge whitespace and reject values that become empty."""
        stripped = value.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped


class RunOutput(BaseModel):
    """Final result projected from one DSH owned activity interval."""

    session_id: str
    response: str
    finish_reason: str | None
