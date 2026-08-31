"""Validated HTTP request models and public response projections."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator

from .domain import Artifact, Conversation, Run, normalize_artifact_names, validate_prompt

MAX_TITLE_CHARACTERS = 200
MAX_PROMPT_CHARACTERS = 100_000
MAX_ARTIFACTS_PER_RUN = 32


class ConversationCreate(BaseModel):
    """Optional display metadata for a new Conversation."""

    title: str | None = Field(default=None, max_length=MAX_TITLE_CHARACTERS)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str | None) -> str | None:
        """Trim a present title and reject whitespace-only values."""
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("title must contain non-whitespace text")
        return normalized


class RunCreate(BaseModel):
    """Validated user prompt and bounded service-owned artifact declarations."""

    prompt: str = Field(max_length=MAX_PROMPT_CHARACTERS)
    artifacts: list[str] = Field(default_factory=list, max_length=MAX_ARTIFACTS_PER_RUN)

    @field_validator("prompt")
    @classmethod
    def validate_exact_prompt(cls, value: str) -> str:
        """Validate without trimming the prompt used for dispatch and fingerprinting."""
        return validate_prompt(value)

    @field_validator("artifacts")
    @classmethod
    def validate_artifacts(cls, value: list[str]) -> list[str]:
        """Return safe unique artifact names in deterministic order."""
        return list(normalize_artifact_names(value))


class ConversationOutput(BaseModel):
    """Public Conversation representation."""

    id: str
    dsh_session_id: str
    state: str
    title: str | None
    created_at: str
    updated_at: str


class RunSummaryOutput(BaseModel):
    """Public Run fields shared by summary and detail responses."""

    id: str
    conversation_id: str
    dsh_session_id: str
    state: str
    last_event_seq: int
    final_response: str | None
    finish_reason: str | None
    error_code: str | None
    error_message: str | None
    created_at: str
    started_at: str | None
    finished_at: str | None


class ArtifactOutput(BaseModel):
    """Downloadable artifact metadata without embedded content."""

    id: str
    run_id: str
    requested_name: str
    state: str
    sha256: str | None
    byte_size: int | None
    media_type: str
    created_at: str
    download_url: str


class RunOutput(RunSummaryOutput):
    """Detailed Run response with replay and artifact resource links."""

    events_url: str
    artifacts: list[ArtifactOutput]


class ConversationDetailOutput(ConversationOutput):
    """Conversation plus bounded recent Run summaries."""

    recent_runs: list[RunSummaryOutput]


class HealthOutput(BaseModel):
    """Database and worker availability without recovery guarantees."""

    status: str
    database: str
    coordinator: str
    worker: str


class ErrorOutput(BaseModel):
    """Typed HTTP error body."""

    detail: str


def conversation_data(conversation: Conversation) -> dict[str, Any]:
    """Project a Conversation without inventing runtime ownership."""
    return {
        "id": conversation.id,
        "dsh_session_id": conversation.dsh_session_id,
        "state": conversation.state,
        "title": conversation.title,
        "created_at": conversation.created_at,
        "updated_at": conversation.updated_at,
    }


def run_summary_data(run: Run) -> dict[str, Any]:
    """Project durable Run fields while withholding agent-facing runtime input."""
    return {
        "id": run.id,
        "conversation_id": run.conversation_id,
        "dsh_session_id": run.dsh_session_id,
        "state": run.state,
        "last_event_seq": run.last_event_seq,
        "final_response": run.final_response,
        "finish_reason": run.finish_reason,
        "error_code": run.error_code,
        "error_message": run.error_message,
        "created_at": run.created_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
    }


def artifact_data(artifact: Artifact) -> dict[str, Any]:
    """Project artifact metadata without embedding immutable content."""
    return {
        "id": artifact.id,
        "run_id": artifact.run_id,
        "requested_name": artifact.requested_name,
        "state": artifact.state,
        "sha256": artifact.sha256,
        "byte_size": artifact.byte_size,
        "media_type": artifact.media_type,
        "created_at": artifact.created_at,
        "download_url": f"/api/runs/{artifact.run_id}/artifacts/{artifact.id}",
    }


def run_data(run: Run, artifacts: list[Artifact]) -> dict[str, Any]:
    """Project one Run with public resource links and artifact metadata."""
    return {
        **run_summary_data(run),
        "events_url": f"/api/runs/{run.id}/events",
        "artifacts": [artifact_data(artifact) for artifact in artifacts],
    }
