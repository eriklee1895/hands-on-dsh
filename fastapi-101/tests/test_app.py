from __future__ import annotations

from fastapi.testclient import TestClient

from dsh_fastapi_101.app import create_app
from dsh_fastapi_101.events import BrowserEvent
from dsh_fastapi_101.models import RunOutput


class FakeRuntime:
    def __init__(self) -> None:
        self.started = False
        self.closed = False
        self.seen: set[str] = set()

    async def start(self) -> None:
        self.started = True

    async def close(self) -> None:
        self.closed = True

    async def run(self, prompt: str, session_id: str) -> RunOutput:
        self.seen.add(session_id)
        return RunOutput(session_id=session_id, response=prompt.upper(), finish_reason="completed")

    async def stream(self, prompt: str, session_id: str):
        self.seen.add(session_id)
        yield BrowserEvent(type="text_delta", session_id=session_id, data={"text": prompt})
        yield BrowserEvent(
            type="final",
            session_id=session_id,
            data={"response": prompt, "finish_reason": "completed"},
        )

    def session_ids(self) -> list[str]:
        return sorted(self.seen)


def test_lifespan_blocking_api_and_static_frontend() -> None:
    runtime = FakeRuntime()
    with TestClient(create_app(runtime=runtime)) as client:
        assert runtime.started
        page = client.get("/")
        assert page.status_code == 200
        assert "DSH FastAPI 101" in page.text
        assert 'rel="icon"' in page.text
        assert client.get("/static/favicon.svg").status_code == 200

        response = client.post("/api/chat", json={"prompt": "hello", "session_id": "web-a"})
        assert response.status_code == 200
        assert response.json() == {
            "session_id": "web-a",
            "response": "HELLO",
            "finish_reason": "completed",
        }
        assert client.get("/api/sessions").json() == {"session_ids": ["web-a"]}
    assert runtime.closed


def test_streaming_api_returns_named_sse_events() -> None:
    runtime = FakeRuntime()
    with TestClient(create_app(runtime=runtime)) as client:
        with client.stream(
            "POST",
            "/api/chat/stream",
            json={"prompt": "stream me", "session_id": "web-stream"},
        ) as response:
            body = "".join(response.iter_text())

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "event: text_delta" in body
    assert "event: final" in body
    assert '"session_id":"web-stream"' in body


def test_rejects_blank_prompts() -> None:
    with TestClient(create_app(runtime=FakeRuntime())) as client:
        response = client.post("/api/chat", json={"prompt": "   ", "session_id": "web-a"})

    assert response.status_code == 422
