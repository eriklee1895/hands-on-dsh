from __future__ import annotations

import hashlib
import importlib
from pathlib import Path

from api_support import ControlledCoordinator, load_app_module, make_store
from fastapi.testclient import TestClient


def make_client(tmp_path: Path):
    app_module = load_app_module()
    repository = make_store(tmp_path / "service.db")
    coordinator = ControlledCoordinator(repository)
    client = TestClient(
        app_module.create_app(
            store=repository,
            coordinator=coordinator,
            heartbeat_interval=0.01,
        )
    )
    return client, repository, coordinator


def test_lifespan_owns_coordinator_and_health_reports_components(tmp_path: Path) -> None:
    client, _repository, coordinator = make_client(tmp_path)

    with client:
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json() == {
            "status": "ok",
            "database": "available",
            "coordinator": "accepting",
            "worker": "running",
        }
        assert coordinator.started == 1

    assert coordinator.closed == 1


def test_lifespan_closes_coordinator_when_startup_fails(tmp_path: Path) -> None:
    app_module = load_app_module()
    repository = make_store(tmp_path / "startup-failure.db")
    coordinator = ControlledCoordinator(repository)

    async def fail_start() -> None:
        coordinator.started += 1
        raise RuntimeError("startup failed")

    coordinator.start = fail_start
    client = TestClient(app_module.create_app(store=repository, coordinator=coordinator))

    try:
        with client:
            raise AssertionError("lifespan startup unexpectedly succeeded")
    except RuntimeError as error:
        assert str(error) == "startup failed"

    assert coordinator.started == 1
    assert coordinator.closed == 1


def test_openapi_matches_run_submission_validation_errors(tmp_path: Path) -> None:
    client, _repository, _coordinator = make_client(tmp_path)

    with client:
        document = client.get("/openapi.json").json()

    submit_responses = document["paths"]["/api/conversations/{conversation_id}/runs"]["post"][
        "responses"
    ]
    assert {"200", "202", "404", "409", "422", "503"} <= set(submit_responses)
    assert submit_responses["404"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ErrorOutput"
    }
    validation_schema = submit_responses["422"]["content"]["application/json"]["schema"]
    assert validation_schema == {
        "oneOf": [
            {"$ref": "#/components/schemas/HTTPValidationError"},
            {"$ref": "#/components/schemas/ErrorOutput"},
        ]
    }


def test_openapi_matches_sse_and_binary_artifact_media_types(tmp_path: Path) -> None:
    client, _repository, _coordinator = make_client(tmp_path)

    with client:
        document = client.get("/openapi.json").json()

    schemas = document["components"]["schemas"]
    assert "runtime_input" not in schemas["RunOutput"]["properties"]
    assert "content" not in schemas["ArtifactOutput"]["properties"]

    sse_responses = document["paths"]["/api/runs/{run_id}/events"]["get"]["responses"]
    assert sse_responses["200"]["content"] == {"text/event-stream": {"schema": {"type": "string"}}}
    for status_code in ("400", "404", "409"):
        assert sse_responses[status_code]["content"]["application/json"]["schema"] == {
            "$ref": "#/components/schemas/ErrorOutput"
        }

    artifact_content = document["paths"]["/api/runs/{run_id}/artifacts/{artifact_id}"]["get"][
        "responses"
    ]["200"]["content"]
    assert artifact_content == {
        "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}
    }


def test_conversation_create_get_and_recent_run_projection(tmp_path: Path) -> None:
    client, _repository, _coordinator = make_client(tmp_path)

    with client:
        created = client.post("/api/conversations", json={"title": "  recovery demo  "})
        assert created.status_code == 201
        conversation = created.json()
        assert conversation["title"] == "recovery demo"
        assert conversation["state"] == "active"

        submitted = client.post(
            f"/api/conversations/{conversation['id']}/runs",
            headers={"Idempotency-Key": " request-1 "},
            json={"prompt": "keep exact whitespace\n", "artifacts": ["proof.txt"]},
        )
        assert submitted.status_code == 202

        loaded = client.get(f"/api/conversations/{conversation['id']}")
        assert loaded.status_code == 200
        body = loaded.json()
        assert body["id"] == conversation["id"]
        assert [run["id"] for run in body["recent_runs"]] == [submitted.json()["id"]]
        assert body["recent_runs"][0]["state"] == "queued"

        assert client.get("/api/conversations/missing").status_code == 404


def test_run_submission_status_idempotency_and_validation(tmp_path: Path) -> None:
    client, _repository, _coordinator = make_client(tmp_path)

    with client:
        conversation_id = client.post("/api/conversations", json={}).json()["id"]
        path = f"/api/conversations/{conversation_id}/runs"
        request = {"prompt": "make proof", "artifacts": ["proof.txt"]}

        created = client.post(path, headers={"Idempotency-Key": "key-1"}, json=request)
        replayed = client.post(path, headers={"Idempotency-Key": " key-1 "}, json=request)
        changed = client.post(
            path,
            headers={"Idempotency-Key": "key-1"},
            json={"prompt": "different", "artifacts": ["proof.txt"]},
        )
        competing = client.post(
            path,
            headers={"Idempotency-Key": "key-2"},
            json=request,
        )

        assert created.status_code == 202
        assert replayed.status_code == 200
        assert replayed.json()["id"] == created.json()["id"]
        assert changed.status_code == 409
        assert competing.status_code == 409
        assert client.post(path, json=request).status_code == 422
        assert client.post(path, headers={"Idempotency-Key": " "}, json=request).status_code == 422
        assert (
            client.post(
                path,
                headers={"Idempotency-Key": "x" * 129},
                json=request,
            ).status_code
            == 422
        )
        assert (
            client.post(
                path,
                headers={"Idempotency-Key": "key-3"},
                json={"prompt": " ", "artifacts": []},
            ).status_code
            == 422
        )
        assert (
            client.post(
                path,
                headers={"Idempotency-Key": "key-3"},
                json={"prompt": "valid", "artifacts": ["../escape"]},
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/api/conversations/missing/runs",
                headers={"Idempotency-Key": "key"},
                json=request,
            ).status_code
            == 404
        )


def test_run_response_hides_private_fields_and_builds_resource_urls(tmp_path: Path) -> None:
    client, repository, _coordinator = make_client(tmp_path)

    with client:
        conversation_id = client.post("/api/conversations", json={}).json()["id"]
        created = client.post(
            f"/api/conversations/{conversation_id}/runs",
            headers={"Idempotency-Key": "key"},
            json={"prompt": "write proof", "artifacts": ["proof.txt"]},
        ).json()
        response = client.get(f"/api/runs/{created['id']}")

        assert response.status_code == 200
        body = response.json()
        assert "runtime_input" not in body
        assert body["events_url"] == f"/api/runs/{created['id']}/events"
        assert body["artifacts"][0]["download_url"] == (
            f"/api/runs/{created['id']}/artifacts/{body['artifacts'][0]['id']}"
        )
        assert "content" not in body["artifacts"][0]
        assert client.get("/api/runs/missing").status_code == 404

        claimed = repository.claim_oldest_run()
        assert claimed is not None
        domain = importlib.import_module("recoverable_agent_service.domain")
        repository.complete_run_success(
            claimed.id,
            final_response="done",
            finish_reason="completed",
            artifacts=[
                domain.ArtifactUpdate(
                    requested_name="proof.txt",
                    state="available",
                    content=b"immutable-proof",
                    media_type="text/plain",
                )
            ],
        )
        completed = client.get(f"/api/runs/{claimed.id}").json()
        assert completed["state"] == "succeeded"
        assert completed["final_response"] == "done"


def test_artifact_download_serves_only_matching_available_blob(tmp_path: Path) -> None:
    client, repository, _coordinator = make_client(tmp_path)

    with client:
        conversation_id = client.post("/api/conversations", json={}).json()["id"]
        run = client.post(
            f"/api/conversations/{conversation_id}/runs",
            headers={"Idempotency-Key": "artifact"},
            json={"prompt": "write", "artifacts": ["proof.txt", "missing.txt"]},
        ).json()
        claimed = repository.claim_oldest_run()
        assert claimed is not None
        domain = importlib.import_module("recoverable_agent_service.domain")
        repository.complete_run_success(
            claimed.id,
            final_response="done",
            finish_reason="completed",
            artifacts=[
                domain.ArtifactUpdate(
                    requested_name="proof.txt",
                    state="available",
                    content=b"exact-no-newline",
                    media_type="text/plain",
                ),
                domain.ArtifactUpdate(requested_name="missing.txt", state="missing"),
            ],
        )
        artifacts = client.get(f"/api/runs/{run['id']}").json()["artifacts"]
        available = next(item for item in artifacts if item["state"] == "available")
        missing = next(item for item in artifacts if item["state"] == "missing")

        downloaded = client.get(available["download_url"])
        assert downloaded.status_code == 200
        assert downloaded.content == b"exact-no-newline"
        assert downloaded.headers["content-type"].startswith("text/plain")
        assert downloaded.headers["content-disposition"] == 'attachment; filename="proof.txt"'
        assert available["sha256"] == hashlib.sha256(downloaded.content).hexdigest()
        assert client.get(missing["download_url"]).status_code == 404
        assert client.get(f"/api/runs/other-run/artifacts/{available['id']}").status_code == 404


def test_recovery_acknowledgement_rotates_session_visible_to_next_run(tmp_path: Path) -> None:
    client, repository, _coordinator = make_client(tmp_path)

    with client:
        conversation_id = client.post("/api/conversations", json={}).json()["id"]
        first = client.post(
            f"/api/conversations/{conversation_id}/runs",
            headers={"Idempotency-Key": "first"},
            json={"prompt": "uncertain", "artifacts": []},
        ).json()
        claimed = repository.claim_oldest_run()
        assert claimed is not None
        old_session = claimed.dsh_session_id
        repository.fail_run(
            first["id"],
            error_code="execution_uncertain",
            error_message="connection lost",
            uncertain=True,
        )

        blocked = client.post(
            f"/api/conversations/{conversation_id}/runs",
            headers={"Idempotency-Key": "second"},
            json={"prompt": "next", "artifacts": []},
        )
        acknowledged = client.post(f"/api/conversations/{conversation_id}/acknowledge-recovery")
        second = client.post(
            f"/api/conversations/{conversation_id}/runs",
            headers={"Idempotency-Key": "second"},
            json={"prompt": "next", "artifacts": []},
        )

        assert blocked.status_code == 409
        assert acknowledged.status_code == 200
        assert acknowledged.json()["state"] == "active"
        assert acknowledged.json()["dsh_session_id"] != old_session
        assert second.status_code == 202
        assert (
            repository.get_run(second.json()["id"]).dsh_session_id
            == acknowledged.json()["dsh_session_id"]
        )
