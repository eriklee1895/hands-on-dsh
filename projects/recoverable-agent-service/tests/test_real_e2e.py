from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.e2e
PROOF = b"RECOVERABLE_AGENT_SERVICE_E2E_PROOF_V1"


def test_real_dsh_http_lifecycle_artifact_and_terminal_sse(tmp_path: Path) -> None:
    if not os.environ.get("DEEPSEEK_API_KEY"):
        pytest.skip("DEEPSEEK_API_KEY is required for the explicit real E2E")

    from recoverable_agent_service.app import create_app

    configured_root = os.environ.get("RECOVERABLE_AGENT_E2E_ROOT")
    root = Path(configured_root) if configured_root else tmp_path / "real-e2e"
    root.mkdir(parents=True, exist_ok=True)
    app = create_app(
        database_path=root / "service.db",
        workspace=root / "workspace",
        dsh_home=root / "home",
    )

    with TestClient(app) as client:
        conversation = client.post("/api/conversations", json={"title": "real e2e"})
        assert conversation.status_code == 201
        run = client.post(
            f"/api/conversations/{conversation.json()['id']}/runs",
            headers={"Idempotency-Key": "real-e2e-v1"},
            json={
                "prompt": (
                    "Write exactly these ASCII bytes with no trailing newline to the required "
                    f"artifact path: {PROOF.decode()}"
                ),
                "artifacts": ["proof.txt"],
            },
        )
        assert run.status_code == 202
        run_id = run.json()["id"]
        repeated = client.post(
            f"/api/conversations/{conversation.json()['id']}/runs",
            headers={"Idempotency-Key": "real-e2e-v1"},
            json={
                "prompt": (
                    "Write exactly these ASCII bytes with no trailing newline to the required "
                    f"artifact path: {PROOF.decode()}"
                ),
                "artifacts": ["proof.txt"],
            },
        )
        assert repeated.status_code == 200
        assert repeated.json()["id"] == run_id

        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            current = client.get(f"/api/runs/{run_id}")
            assert current.status_code == 200
            if current.json()["state"] in {"succeeded", "failed"}:
                break
            time.sleep(0.2)
        else:
            pytest.fail("real DSH Run did not reach a terminal state within 180 seconds")

        body = current.json()
        assert body["state"] == "succeeded", body
        artifact = body["artifacts"][0]
        assert artifact["state"] == "available"
        downloaded = client.get(artifact["download_url"])
        assert downloaded.content == PROOF
        assert artifact["sha256"] == hashlib.sha256(PROOF).hexdigest()
        assert artifact["byte_size"] == len(PROOF)

        events = client.get(body["events_url"])
        assert events.status_code == 200
        assert "event: run.succeeded\n" in events.text
        assert events.text.rstrip().endswith('data: {"finish_reason":"completed"}')
        frame_ids = [
            int(line.removeprefix("id: "))
            for line in events.text.splitlines()
            if line.startswith("id: ")
        ]
        assert frame_ids == sorted(set(frame_ids))
        assert len(frame_ids) >= 3
        cursor = frame_ids[1]
        replay = client.get(body["events_url"], headers={"Last-Event-ID": str(cursor)})
        replay_ids = [
            int(line.removeprefix("id: "))
            for line in replay.text.splitlines()
            if line.startswith("id: ")
        ]
        assert replay_ids == [event_id for event_id in frame_ids if event_id > cursor]
        assert replay.text.count("event: run.succeeded\n") == 1

        mutable_path = root / "workspace" / "artifacts" / run_id / "proof.txt"
        assert mutable_path.read_bytes() == PROOF
        mutable_path.write_bytes(b"changed workspace file")
        assert client.get(artifact["download_url"]).content == PROOF

    assert (
        root / "workspace" / "artifacts" / run_id / "proof.txt"
    ).read_bytes() == b"changed workspace file"
