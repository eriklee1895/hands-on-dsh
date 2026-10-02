from __future__ import annotations

import hashlib
import secrets
from collections.abc import Iterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from api_support import ControlledCoordinator, make_store
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from recoverable_agent_service.app import create_app
from recoverable_agent_service.tenancy import create_tenant_app


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def tenant_app() -> FastAPI:
    app = FastAPI()

    @app.api_route("/{rest:path}", methods=["GET", "POST"])
    async def echo(request: Request, rest: str) -> JSONResponse:
        return JSONResponse(
            {
                "path": rest,
                "authorization": request.headers.get("authorization"),
                "body": (await request.body()).decode("utf-8"),
            },
            headers={"Cache-Control": "public", "Vary": "Accept"},
        )

    return app


@pytest.mark.parametrize(
    ("tenant_ids", "credential_tenants"),
    [
        ({}, {}),
        ({"Bad": tenant_app()}, {"Bad": "Bad"}),
        ({"a": tenant_app()}, {}),
        ({"a": tenant_app()}, {"a": "missing"}),
        ({"a": tenant_app(), "b": tenant_app()}, {"a": "a"}),
    ],
)
def test_rejects_invalid_configuration_without_exposing_values(
    tenant_ids: dict[str, FastAPI], credential_tenants: dict[str, str]
) -> None:
    hashes = {digest(key): value for key, value in credential_tenants.items()}
    with pytest.raises(ValueError) as failure:
        create_tenant_app(tenant_ids, hashes)
    assert all(value not in str(failure.value) for value in hashes)


def test_rejects_invalid_digest_reused_app_and_unsafe_tenant_id() -> None:
    app = tenant_app()
    for tenants, credentials in [
        ({"tenant_a": app}, {digest("A" * 32): "tenant_a"}),
        ({"a": app}, {"A" * 64: "a"}),
        ({"a": app, "b": app}, {digest("A" * 32): "a", digest("B" * 32): "b"}),
    ]:
        with pytest.raises(ValueError):
            create_tenant_app(tenants, credentials)


def test_configuration_conversion_failure_does_not_expose_source_values() -> None:
    class BrokenMapping(Mapping[str, FastAPI]):
        def __iter__(self) -> Iterator[str]:
            raise ValueError("secret tenant configuration value")

        def __len__(self) -> int:
            return 1

        def __getitem__(self, key: str) -> FastAPI:
            raise KeyError(key)

    with pytest.raises(ValueError, match="invalid tenant configuration") as failure:
        create_tenant_app(BrokenMapping(), {digest("A" * 32): "a"})
    assert "secret" not in str(failure.value)
    assert failure.value.__cause__ is None
    assert failure.value.__suppress_context__ is True


def test_authentication_strips_header_blocks_selectors_and_marks_every_response_uncacheable() -> (
    None
):
    token = secrets.token_urlsafe(32)
    child = tenant_app()
    outer = create_tenant_app({"a": child}, {digest(token): "a"})
    with TestClient(outer) as client:
        for headers in (
            {},
            {"Authorization": "Bearer wrong"},
            {"Authorization": f"Basic {token}"},
            {"Authorization": "Bearer " + "x" * 31},
            {"Authorization": "Bearer " + "x" * 257},
            {"Authorization": "Bearer " + "x" * 31 + "!"},
            {"Authorization": f"Bearer {'Q' * 40}"},
            [("Authorization", f"Bearer {token}"), ("Authorization", f"Bearer {token}")],
        ):
            response = client.get("/api/health", headers=headers)
            assert response.status_code == 401
            assert response.headers["www-authenticate"] == "Bearer"
            assert response.headers["cache-control"] == "no-store"
            assert "Authorization" in response.headers["vary"]
            assert token not in response.text
        valid = client.post(
            "/echo", headers={"Authorization": f"bEaReR {token}"}, content=b"unread by router"
        )
        assert valid.status_code == 200
        assert valid.json() == {"path": "echo", "authorization": None, "body": "unread by router"}
        assert valid.headers["cache-control"] == "no-store"
        assert "Authorization" in valid.headers["vary"]
        assert "Accept" in valid.headers["vary"]
        for headers, path in (
            ({"Authorization": f"Bearer {token}", "X-Tenant-ID": "a"}, "/echo"),
            ({"Authorization": f"Bearer {token}", "X-Session-ID": "s"}, "/echo"),
            ({"Authorization": f"Bearer {token}"}, "/echo?tenant_id=a"),
            ({"Authorization": f"Bearer {token}"}, "/echo?session_id=s"),
            ({"Authorization": f"Bearer {token}"}, "/echo?dsh_session_id=s"),
            ({"Authorization": f"Bearer {token}"}, "/echo?access_token=secret"),
            ({"Authorization": f"Bearer {token}"}, "/echo?%74enant_id=a"),
        ):
            rejected = client.get(path, headers=headers)
            assert rejected.status_code == 400
            assert rejected.headers["cache-control"] == "no-store"
            assert token not in rejected.text
        with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws"):
            pass


def test_all_child_lifespans_close_when_a_later_child_fails_to_start() -> None:
    seen: list[str] = []

    def app(label: str, fail: bool = False) -> FastAPI:
        @asynccontextmanager
        async def lifespan(_app: FastAPI):
            seen.append(f"start:{label}")
            if fail:
                raise RuntimeError("child startup failed")
            try:
                yield
            finally:
                seen.append(f"close:{label}")

        return FastAPI(lifespan=lifespan)

    outer = create_tenant_app(
        {"a": app("a"), "b": app("b", fail=True)},
        {digest("A" * 32): "a", digest("B" * 32): "b"},
    )
    with pytest.raises(RuntimeError, match="child startup failed"), TestClient(outer):
        pass
    assert seen == ["start:a", "start:b", "close:a"]


def test_multiple_credentials_are_scanned_and_input_mappings_are_copied(monkeypatch) -> None:
    from recoverable_agent_service import tenancy

    token_a = secrets.token_urlsafe(32)
    token_b = secrets.token_urlsafe(32)
    children = {"a": tenant_app()}
    configured = {digest(token_a): "a", digest(token_b): "a"}
    outer = create_tenant_app(children, configured)
    children.clear()
    configured.clear()
    observed: list[tuple[int, int]] = []
    original = tenancy.secrets.compare_digest

    def compare(left: str, right: str) -> bool:
        observed.append((len(left), len(right)))
        return original(left, right)

    monkeypatch.setattr(tenancy.secrets, "compare_digest", compare)
    with TestClient(outer) as client:
        for token in (token_a, token_b):
            observed.clear()
            response = client.get("/echo", headers={"Authorization": f"Bearer {token}"})
            assert response.status_code == 200
            assert observed == [(64, 64), (64, 64)]


def test_tenant_isolation_covers_write_sse_artifact_and_recovery(tmp_path: Path, caplog) -> None:
    token_a = secrets.token_urlsafe(32)
    token_b = secrets.token_urlsafe(32)
    stores = {tenant: make_store(tmp_path / tenant / "service.db") for tenant in ("a", "b")}
    children = {
        tenant: create_app(
            store=stores[tenant],
            coordinator=ControlledCoordinator(stores[tenant]),
            heartbeat_interval=0.01,
        )
        for tenant in ("a", "b")
    }
    outer = create_tenant_app(children, {digest(token_a): "a", digest(token_b): "b"})
    auth_a = {"Authorization": f"Bearer {token_a}"}
    auth_b = {"Authorization": f"Bearer {token_b}"}
    with TestClient(outer) as client:
        assert client.get("/api/health").status_code == 401
        assert client.get("/docs").status_code == 401
        assert client.get("/openapi.json").status_code == 401
        created_a = client.post("/api/conversations", headers=auth_a, json={"title": "A"})
        created_b = client.post("/api/conversations", headers=auth_b, json={"title": "B"})
        assert created_a.status_code == created_b.status_code == 201
        a_id, b_id = created_a.json()["id"], created_b.json()["id"]
        assert a_id != b_id
        assert client.get(f"/api/conversations/{a_id}", headers=auth_b).status_code == 404
        assert client.get(f"/api/conversations/{b_id}", headers=auth_a).status_code == 404
        for headers, conversation_id in ((auth_a, a_id), (auth_b, b_id)):
            submitted = client.post(
                f"/api/conversations/{conversation_id}/runs",
                headers={**headers, "Idempotency-Key": "same-key"},
                json={"prompt": "proof", "artifacts": ["proof.txt"]},
            )
            assert submitted.status_code == 202
        a_run = stores["a"].list_runs(a_id)[0]
        b_run = stores["b"].list_runs(b_id)[0]
        assert a_run.id != b_run.id
        assert (
            client.post(
                f"/api/conversations/{a_id}/runs",
                headers={**auth_b, "Idempotency-Key": "other"},
                json={"prompt": "cross-tenant", "artifacts": []},
            ).status_code
            == 404
        )
        assert client.get(f"/api/runs/{a_run.id}", headers=auth_b).status_code == 404
        assert client.get(f"/api/runs/{a_run.id}/events", headers=auth_b).status_code == 404
        stores["a"].claim_oldest_run()
        from recoverable_agent_service.domain import ArtifactUpdate

        stores["a"].complete_run_success(
            a_run.id,
            final_response="done",
            finish_reason="completed",
            artifacts=[
                ArtifactUpdate(requested_name="proof.txt", state="available", content=b"A proof")
            ],
        )
        artifact = stores["a"].list_artifacts(a_run.id)[0]
        url = f"/api/runs/{a_run.id}/artifacts/{artifact.id}"
        assert client.get(url, headers=auth_a).content == b"A proof"
        assert client.get(url, headers=auth_b).status_code == 404
        replay = client.get(f"/api/runs/{a_run.id}/events", headers=auth_a)
        assert "event: run.succeeded" in replay.text
        assert replay.headers["cache-control"] == "no-store"
        assert "Authorization" in replay.headers["vary"]
        assert (
            client.post(
                f"/api/conversations/{a_id}/acknowledge-recovery", headers=auth_b
            ).status_code
            == 404
        )
        recovery = client.post("/api/conversations", headers=auth_a, json={"title": "recovery"})
        recovery_id = recovery.json()["id"]
        waiting = client.post(
            f"/api/conversations/{recovery_id}/runs",
            headers={**auth_a, "Idempotency-Key": "uncertain"},
            json={"prompt": "could have run", "artifacts": []},
        )
        stores["a"].claim_oldest_run()
        stores["a"].fail_run(
            waiting.json()["id"],
            error_code="execution_uncertain",
            error_message="uncertain",
            uncertain=True,
        )
        assert (
            client.post(
                f"/api/conversations/{recovery_id}/acknowledge-recovery", headers=auth_b
            ).status_code
            == 404
        )
        acknowledged = client.post(
            f"/api/conversations/{recovery_id}/acknowledge-recovery", headers=auth_a
        )
        assert acknowledged.status_code == 200
        assert acknowledged.json()["dsh_session_id"] != recovery.json()["dsh_session_id"]
        assert (
            client.post("/api/conversations", headers=auth_a, json={"tenant_id": "b"}).status_code
            == 422
        )
        assert (
            client.post(
                f"/api/conversations/{b_id}/runs",
                headers={**auth_b, "Idempotency-Key": "extra-field"},
                json={"prompt": "x", "artifacts": [], "session_id": "forced"},
            ).status_code
            == 422
        )
    assert token_a not in caplog.text
    assert token_b not in caplog.text
