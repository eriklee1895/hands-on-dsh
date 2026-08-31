"""Domain validation and deterministic request serialization."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

ARTIFACT_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


class StoreError(Exception):
    """Base class for repository errors that callers may map by type."""


class NotFoundError(StoreError):
    """Raised when an addressed domain record does not exist."""


class InvalidInputError(StoreError):
    """Raised when caller input cannot form a valid domain request."""


class ConflictError(StoreError):
    """Raised when a valid request conflicts with durable state."""


class InvalidTransitionError(StoreError):
    """Raised when a state transition is not permitted from the current state."""


class FutureSchemaVersionError(StoreError):
    """Raised when the database schema is newer than this application."""


class DatabaseConfigurationError(StoreError):
    """Raised when SQLite cannot provide a required repository setting."""


@dataclass(frozen=True)
class Conversation:
    """Authoritative business conversation with an external DSH session reference."""

    id: str
    dsh_session_id: str
    state: str
    title: str | None
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class Run:
    """Durable execution request and its current business state."""

    id: str
    conversation_id: str
    dsh_session_id: str
    idempotency_key: str
    request_fingerprint: str
    user_prompt: str
    runtime_input: str
    state: str
    last_event_seq: int
    final_response: str | None
    finish_reason: str | None
    error_code: str | None
    error_message: str | None
    created_at: str
    started_at: str | None
    finished_at: str | None


@dataclass(frozen=True)
class RunEvent:
    """One persisted event in a Run's strict sequence."""

    run_id: str
    seq: int
    type: str
    data: dict[str, Any]
    created_at: str


@dataclass(frozen=True)
class Artifact:
    """Artifact catalog metadata plus immutable content when available."""

    id: str
    run_id: str
    requested_name: str
    relative_path: str
    state: str
    content: bytes | None
    sha256: str | None
    byte_size: int | None
    media_type: str
    created_at: str


@dataclass(frozen=True)
class RunSubmission:
    """Result of a new or idempotently replayed Run submission."""

    run: Run
    created: bool


@dataclass(frozen=True)
class ArtifactUpdate:
    """Validated artifact outcome stored atomically with Run success."""

    requested_name: str
    state: str
    content: bytes | bytearray | memoryview | None = None
    media_type: str | None = None


def canonical_json(value: Any) -> str:
    """Serialize a JSON-compatible value to the repository's canonical representation."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def normalize_idempotency_key(value: object) -> str:
    """Return a bounded non-blank idempotency key with outer whitespace removed."""
    if not isinstance(value, str):
        raise InvalidInputError("Idempotency-Key must be a string")
    normalized = value.strip()
    if not normalized or len(normalized) > 128:
        raise InvalidInputError("Idempotency-Key must contain 1 to 128 characters")
    return normalized


def normalize_artifact_names(names: Iterable[str]) -> tuple[str, ...]:
    """Validate artifact filenames, reject duplicates, and return canonical order."""
    normalized = tuple(names)
    if len(set(normalized)) != len(normalized):
        raise InvalidInputError("artifact names must be unique")
    for name in normalized:
        if (
            not isinstance(name, str)
            or name in {".", ".."}
            or not ARTIFACT_NAME_PATTERN.fullmatch(name)
        ):
            raise InvalidInputError(f"unsafe artifact name: {name!r}")
    return tuple(sorted(normalized))


def validate_prompt(prompt: object) -> str:
    """Return the exact non-blank prompt used for fingerprinting and dispatch."""
    if not isinstance(prompt, str) or not prompt.strip():
        raise InvalidInputError("prompt must contain non-whitespace text")
    return prompt


def request_fingerprint(prompt: object, artifact_names: Iterable[str]) -> str:
    """Return the v1 fingerprint for the exact prompt and canonical artifact declarations."""
    exact_prompt = validate_prompt(prompt)
    names = normalize_artifact_names(artifact_names)
    payload = {
        "artifacts": [{"name": name} for name in names],
        "prompt": exact_prompt,
    }
    digest = hashlib.sha256(canonical_json(payload).encode()).hexdigest()
    return f"v1:{digest}"


def artifact_relative_path(run_id: str, name: str) -> str:
    """Return the staging path for one validated artifact name."""
    (validated_name,) = normalize_artifact_names([name])
    return f"artifacts/{run_id}/{validated_name}"


def build_runtime_input(run_id: str, prompt: object, artifact_names: Iterable[str]) -> str:
    """Build deterministic agent-facing instructions around the exact user prompt."""
    exact_prompt = validate_prompt(prompt)
    names = normalize_artifact_names(artifact_names)
    lines = [
        "Execute the exact user prompt delimited below.",
        f"<<<USER_PROMPT_START:{len(exact_prompt)}>>>",
        exact_prompt,
        "<<<USER_PROMPT_END>>>",
        "",
        "Service-owned artifact requirements:",
    ]
    if names:
        lines.extend(
            f"- You MUST write artifact `{name}` to exactly "
            f"`{artifact_relative_path(run_id, name)}`."
            for name in names
        )
        lines.append("- Do not rename these artifacts or substitute alternate paths.")
    else:
        lines.append("- No service-owned artifacts were requested.")
    return "\n".join(lines)
