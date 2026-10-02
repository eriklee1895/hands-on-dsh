"""FastAPI application exposing blocking and streaming DSH runs."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .events import BrowserEvent, encode_sse
from .models import ChatRequest, RunOutput
from .runtime import AgentRunFailed, RuntimeService, ServiceClosedError

STATIC_DIR = Path(__file__).with_name("static")


def create_app(runtime: Any | None = None) -> FastAPI:
    """Create an application around the supplied runtime or a production service."""
    service = runtime or RuntimeService()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        try:
            await service.start()
            yield
        finally:
            await service.close()

    application = FastAPI(title="DSH FastAPI 101", lifespan=lifespan)

    @application.get("/api/health")
    async def health() -> dict[str, object]:
        return {"ok": True, "runtime_started": getattr(service, "started", True)}

    @application.get("/api/sessions")
    async def sessions() -> dict[str, list[str]]:
        return {"session_ids": service.session_ids()}

    @application.post("/api/chat", response_model=RunOutput)
    async def chat(request: ChatRequest) -> RunOutput | JSONResponse:
        try:
            return await service.run(request.prompt, request.session_id)
        except ServiceClosedError:
            return JSONResponse(
                status_code=503,
                content={"error": {"message": "Runtime is closing", "finish_reason": None}},
            )
        except AgentRunFailed as exc:
            return JSONResponse(
                status_code=502,
                content={"error": {"message": str(exc), "finish_reason": exc.finish_reason}},
            )
        except Exception:
            return JSONResponse(
                status_code=502,
                content={"error": {"message": "Agent runtime failed", "finish_reason": None}},
            )

    @application.post("/api/chat/stream")
    async def stream_chat(request: ChatRequest) -> Response:
        try:
            admitted_events = service.stream(request.prompt, request.session_id)
        except ServiceClosedError:
            return JSONResponse(
                status_code=503,
                content={"error": {"message": "Runtime is closing", "finish_reason": None}},
            )

        async def frames() -> AsyncIterator[bytes]:
            try:
                async for event in admitted_events:
                    yield encode_sse(event)
            except Exception:
                yield encode_sse(
                    BrowserEvent(
                        type="error",
                        session_id=request.session_id,
                        data={"message": "Agent runtime failed", "finish_reason": None},
                    )
                )

        return StreamingResponse(
            frames(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    @application.get("/")
    @application.get("/chapter/{chapter_id}")
    async def frontend(chapter_id: str | None = None) -> FileResponse:
        del chapter_id
        return FileResponse(STATIC_DIR / "index.html")

    application.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return application


app = create_app()
