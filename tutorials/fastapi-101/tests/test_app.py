from __future__ import annotations

from fastapi.testclient import TestClient

from dsh_fastapi_101.app import create_app
from dsh_fastapi_101.events import BrowserEvent
from dsh_fastapi_101.models import RunOutput
from dsh_fastapi_101.runtime import AgentRunFailed, ServiceClosedError


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
        yield BrowserEvent(type="assistant_message", session_id=session_id, data={"text": prompt})
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
    with (
        TestClient(create_app(runtime=runtime)) as client,
        client.stream(
            "POST",
            "/api/chat/stream",
            json={"prompt": "stream me", "session_id": "web-stream"},
        ) as response,
    ):
        body = "".join(response.iter_text())

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "event: assistant_message" in body
    assert "event: final" in body
    assert '"session_id":"web-stream"' in body


def test_rejects_blank_prompts() -> None:
    with TestClient(create_app(runtime=FakeRuntime())) as client:
        response = client.post("/api/chat", json={"prompt": "   ", "session_id": "web-a"})

    assert response.status_code == 422


def test_json_agent_failure_returns_explicit_error_status() -> None:
    class FailingRuntime(FakeRuntime):
        async def run(self, prompt: str, session_id: str) -> RunOutput:
            raise RuntimeError("agent finished with error")

    with TestClient(create_app(runtime=FailingRuntime())) as client:
        response = client.post("/api/chat", json={"prompt": "fail", "session_id": "web-a"})

    assert response.status_code == 502
    assert response.json()["error"]["message"] == "Agent runtime failed"


def test_json_agent_turn_failure_preserves_finish_reason() -> None:
    class FailingRuntime(FakeRuntime):
        async def run(self, prompt: str, session_id: str) -> RunOutput:
            raise AgentRunFailed("max-tokens")

    with TestClient(create_app(runtime=FailingRuntime())) as client:
        response = client.post("/api/chat", json={"prompt": "fail", "session_id": "web-a"})

    assert response.status_code == 502
    assert response.json()["error"]["finish_reason"] == "max-tokens"


def test_stream_rejects_new_work_before_response_headers_when_closing() -> None:
    class ClosingRuntime(FakeRuntime):
        def stream(self, prompt: str, session_id: str):
            raise ServiceClosedError("runtime service is closing")

    with TestClient(create_app(runtime=ClosingRuntime())) as client:
        response = client.post("/api/chat/stream", json={"prompt": "late", "session_id": "web-a"})

    assert response.status_code == 503
    assert response.json()["error"]["message"] == "Runtime is closing"


def test_started_sse_response_ends_with_error_frame_on_runtime_exception() -> None:
    class FailingStream(FakeRuntime):
        async def stream(self, prompt: str, session_id: str):
            yield BrowserEvent(type="status", session_id=session_id, data={"status": "running"})
            raise RuntimeError("sensitive runtime details")

    with (
        TestClient(create_app(runtime=FailingStream())) as client,
        client.stream(
            "POST", "/api/chat/stream", json={"prompt": "fail", "session_id": "web-a"}
        ) as response,
    ):
        body = "".join(response.iter_text())

    assert response.status_code == 200
    assert "event: status" in body
    assert "event: error" in body
    assert "event: final" not in body
    assert "sensitive runtime details" not in body
