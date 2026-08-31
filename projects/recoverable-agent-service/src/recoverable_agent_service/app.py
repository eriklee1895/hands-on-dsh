"""FastAPI assembly for the recoverable agent service."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Response, status
from fastapi.responses import JSONResponse, StreamingResponse

from .coordinator import CoordinatorClosedError, RunCoordinator
from .domain import (
    ConflictError,
    InvalidInputError,
    InvalidTransitionError,
    NotFoundError,
)
from .models import (
    ConversationCreate,
    ConversationDetailOutput,
    ConversationOutput,
    ErrorOutput,
    HealthOutput,
    RunCreate,
    RunOutput,
    conversation_data,
    run_data,
    run_summary_data,
)
from .runtime import DSHRuntimeAdapter
from .sse import create_sse_response
from .store import SQLiteStore

DEFAULT_DATABASE_PATH = ".data/service.db"
DEFAULT_WORKSPACE_PATH = "workspace"
DEFAULT_SESSION_ROOT = ".sessions"
DEFAULT_PROVIDER = "deepseek-official"
DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_HEARTBEAT_SECONDS = 15.0


def create_app(
    *,
    store: SQLiteStore | None = None,
    coordinator: RunCoordinator | Any | None = None,
    database_path: str | Path | None = None,
    workspace: str | Path | None = None,
    session_root: str | Path | None = None,
    provider: str | None = None,
    model: str | None = None,
    heartbeat_interval: float = DEFAULT_HEARTBEAT_SECONDS,
) -> FastAPI:
    """Construct an application without starting runtime or creating filesystem state."""
    repository = store or SQLiteStore(
        database_path or os.environ.get("RECOVERABLE_AGENT_DATABASE", DEFAULT_DATABASE_PATH)
    )
    workspace_path = Path(
        workspace or os.environ.get("RECOVERABLE_AGENT_WORKSPACE", DEFAULT_WORKSPACE_PATH)
    )
    if coordinator is None:
        adapter = DSHRuntimeAdapter(
            workspace_path,
            session_root or os.environ.get("RECOVERABLE_AGENT_SESSION_ROOT", DEFAULT_SESSION_ROOT),
            provider=provider or os.environ.get("DSH_PROVIDER", DEFAULT_PROVIDER),
            model=model or os.environ.get("DSH_MODEL", DEFAULT_MODEL),
        )
        coordinator = RunCoordinator(repository, adapter, workspace_path)

    @asynccontextmanager
    async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
        try:
            await coordinator.start()
            yield
        finally:
            await coordinator.close()

    application = FastAPI(title="Recoverable Agent Service", lifespan=lifespan)
    application.state.store = repository
    application.state.coordinator = coordinator

    @application.exception_handler(NotFoundError)
    async def handle_not_found(_request: Any, error: NotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(error)})

    @application.exception_handler(InvalidInputError)
    async def handle_invalid_input(_request: Any, error: InvalidInputError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(error)})

    @application.exception_handler(ConflictError)
    @application.exception_handler(InvalidTransitionError)
    async def handle_conflict(_request: Any, error: Exception) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(error)})

    @application.exception_handler(CoordinatorClosedError)
    async def handle_closed(_request: Any, error: CoordinatorClosedError) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(error)})

    @application.get("/api/health", response_model=HealthOutput)
    async def health() -> dict[str, str]:
        database_available = await asyncio.to_thread(repository.health_check)
        accepting = bool(coordinator.accepting)
        worker_running = bool(coordinator.worker_running)
        healthy = database_available and accepting and worker_running
        return {
            "status": "ok" if healthy else "degraded",
            "database": "available" if database_available else "unavailable",
            "coordinator": "accepting" if accepting else "not_accepting",
            "worker": "running" if worker_running else "stopped",
        }

    @application.post(
        "/api/conversations",
        status_code=status.HTTP_201_CREATED,
        response_model=ConversationOutput,
    )
    async def create_conversation(request: ConversationCreate) -> dict[str, Any]:
        conversation = await asyncio.to_thread(repository.create_conversation, request.title)
        return conversation_data(conversation)

    @application.get(
        "/api/conversations/{conversation_id}",
        response_model=ConversationDetailOutput,
        responses={404: {"model": ErrorOutput}},
    )
    async def get_conversation(conversation_id: str) -> dict[str, Any]:
        conversation = await asyncio.to_thread(repository.get_conversation, conversation_id)
        runs = await asyncio.to_thread(repository.list_runs, conversation_id)
        return {
            **conversation_data(conversation),
            "recent_runs": [run_summary_data(run) for run in reversed(runs[-20:])],
        }

    @application.post(
        "/api/conversations/{conversation_id}/runs",
        status_code=status.HTTP_202_ACCEPTED,
        response_model=RunOutput,
        responses={
            200: {"model": RunOutput},
            404: {"model": ErrorOutput},
            409: {"model": ErrorOutput},
            422: {
                "content": {
                    "application/json": {
                        "schema": {
                            "oneOf": [
                                {"$ref": "#/components/schemas/HTTPValidationError"},
                                {"$ref": "#/components/schemas/ErrorOutput"},
                            ]
                        }
                    }
                }
            },
            503: {"model": ErrorOutput},
        },
    )
    async def submit_run(
        conversation_id: str,
        request: RunCreate,
        response: Response,
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> dict[str, Any]:
        submission = await coordinator.submit_run(
            conversation_id,
            idempotency_key,
            request.prompt,
            request.artifacts,
        )
        response.status_code = 202 if submission.created else 200
        artifacts = await asyncio.to_thread(repository.list_artifacts, submission.run.id)
        return run_data(submission.run, artifacts)

    @application.get(
        "/api/runs/{run_id}",
        response_model=RunOutput,
        responses={404: {"model": ErrorOutput}},
    )
    async def get_run(run_id: str) -> dict[str, Any]:
        run = await asyncio.to_thread(repository.get_run, run_id)
        artifacts = await asyncio.to_thread(repository.list_artifacts, run_id)
        return run_data(run, artifacts)

    @application.get(
        "/api/runs/{run_id}/events",
        response_class=StreamingResponse,
        responses={
            200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}},
            400: {"model": ErrorOutput},
            404: {"model": ErrorOutput},
            409: {"model": ErrorOutput},
        },
    )
    async def get_run_events(
        run_id: str,
        last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    ) -> Response:
        return await create_sse_response(
            repository,
            coordinator.notifier,
            run_id,
            last_event_id,
            heartbeat_interval=heartbeat_interval,
        )

    @application.get(
        "/api/runs/{run_id}/artifacts/{artifact_id}",
        response_class=Response,
        responses={
            200: {
                "content": {
                    "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}
                }
            },
            404: {"model": ErrorOutput},
        },
    )
    async def download_artifact(run_id: str, artifact_id: str) -> Response:
        artifact = await asyncio.to_thread(
            repository.get_available_artifact,
            run_id,
            artifact_id,
        )
        if artifact.content is None:
            raise HTTPException(status_code=404, detail="artifact content is unavailable")
        return Response(
            content=artifact.content,
            media_type=artifact.media_type,
            headers={"Content-Disposition": f'attachment; filename="{artifact.requested_name}"'},
        )

    @application.post(
        "/api/conversations/{conversation_id}/acknowledge-recovery",
        response_model=ConversationOutput,
        responses={404: {"model": ErrorOutput}, 503: {"model": ErrorOutput}},
    )
    async def acknowledge_recovery(conversation_id: str) -> dict[str, Any]:
        conversation = await coordinator.acknowledge_recovery(conversation_id)
        return conversation_data(conversation)

    return application


app = create_app()
