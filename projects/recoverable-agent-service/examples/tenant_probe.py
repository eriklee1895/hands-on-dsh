"""Run two tenant applications through one bounded loopback HTTP server."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
import logging
import re
import secrets
import shutil
import socket
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import httpx2
import uvicorn

from recoverable_agent_service.app import create_app
from recoverable_agent_service.coordinator import RunCoordinator
from recoverable_agent_service.events import RuntimeEvent
from recoverable_agent_service.runtime import RuntimeResult
from recoverable_agent_service.store import SQLiteStore
from recoverable_agent_service.tenancy import create_tenant_app

PROOFS = {
    "tenant-a": b"TENANT_A_PROOF_V1",
    "tenant-b": b"TENANT_B_PROOF_V1",
}
IDEMPOTENCY_KEY = "shared-tenant-proof-v1"
RUN_ID_PATTERN = re.compile(r"artifacts/([A-Za-z0-9-]+)/proof\.txt")


class ProofRuntime:
    """Deterministic RuntimeAdapter that writes only the requested artifact path."""

    def __init__(self, workspace: Path, proof: bytes) -> None:
        self.workspace = workspace
        self.proof = proof
        self.calls = 0
        self.closed = False

    async def run(self, dsh_session_id: str, runtime_input: str, emit: Any) -> RuntimeResult:
        match = RUN_ID_PATTERN.search(runtime_input)
        if match is None:
            raise AssertionError("runtime input omitted the service-owned proof path")
        target = self.workspace / "artifacts" / match.group(1) / "proof.txt"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.proof)
        self.calls += 1
        await emit(
            RuntimeEvent(
                type="assistant_message",
                data={"session_id": dsh_session_id, "text": "proof written"},
            )
        )
        return RuntimeResult(final_response="proof written", finish_reason="completed")

    async def close(self) -> None:
        self.closed = True


class ObservedRuntime:
    """Record that the coordinator awaited a successful adapter close."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.closed = False

    async def run(self, dsh_session_id: str, runtime_input: str, emit: Any) -> RuntimeResult:
        return await self.inner.run(dsh_session_id, runtime_input, emit)

    async def close(self) -> None:
        await self.inner.close()
        self.closed = True


def _assert_status(response: Any, expected: int, label: str) -> Any:
    if response.status_code != expected:
        raise AssertionError(f"{label}: expected HTTP {expected}, got {response.status_code}")
    return response


def _authorized(client: httpx2.Client, token: str, method: str, path: str, **kwargs: Any) -> Any:
    headers = {"Authorization": "Bearer " + token, **kwargs.pop("headers", {})}
    return client.request(method, path, headers=headers, **kwargs)


def _wait_terminal(client: httpx2.Client, token: str, run_id: str, real: bool) -> dict[str, Any]:
    deadline = time.monotonic() + (180 if real else 15)
    while time.monotonic() < deadline:
        response = _assert_status(
            _authorized(client, token, "GET", "/api/runs/" + run_id),
            200,
            "poll run",
        )
        body = response.json()
        if body["state"] in {"succeeded", "failed"}:
            if body["state"] != "succeeded" or body["finish_reason"] != "completed":
                raise AssertionError(
                    f"run {run_id} ended as {body['state']} ({body.get('error_code')})"
                )
            return body
        time.sleep(0.2 if real else 0.05)
    raise TimeoutError("run did not reach a terminal state before the bounded deadline")


def _parse_sse(text: str) -> tuple[list[int], list[str]]:
    ids = [int(line[4:]) for line in text.splitlines() if line.startswith("id: ")]
    names = [line[7:] for line in text.splitlines() if line.startswith("event: ")]
    if not ids or ids != sorted(set(ids)):
        raise AssertionError("SSE ids were absent, repeated, or unordered")
    if "assistant_message" not in names or names[-1] != "run.succeeded":
        raise AssertionError("SSE lacked committed assistant text or terminal success")
    return ids, names


def _exercise(client: httpx2.Client, tokens: dict[str, str], real: bool) -> dict[str, object]:
    a = tokens["tenant-a"]
    b = tokens["tenant-b"]
    for path in ("/api/health", "/docs", "/openapi.json", "/api/conversations"):
        unauthorized = _assert_status(client.get(path), 401, "unauthenticated route")
        if "Bearer" not in unauthorized.headers.get("www-authenticate", ""):
            raise AssertionError("unauthenticated route lacks Bearer challenge")
    _assert_status(
        _authorized(client, "invalid-token-placeholder", "GET", "/api/health"),
        401,
        "invalid credential",
    )
    for token in (a, b):
        health = _assert_status(
            _authorized(client, token, "GET", "/api/health"), 200, "authenticated health"
        )
        if health.json()["status"] != "ok":
            raise AssertionError("tenant health is not ready")
        if health.headers.get("cache-control") != "no-store":
            raise AssertionError("tenant response is cacheable")
        if "Authorization" not in health.headers.get("vary", ""):
            raise AssertionError("tenant response does not vary by authorization")

    spoof_count = 0
    for name, value in (("X-Tenant-ID", "tenant-b"), ("X-Session-ID", "spoof")):
        _assert_status(
            _authorized(client, a, "GET", "/api/health", headers={name: value}),
            400,
            "forbidden selector header",
        )
        spoof_count += 1
    for name in ("tenant_id", "session_id", "dsh_session_id", "access_token"):
        _assert_status(
            _authorized(
                client,
                a,
                "GET",
                "/api/health",
                params={name: a if name == "access_token" else "spoof"},
            ),
            400,
            "forbidden selector query",
        )
        spoof_count += 1

    conversations: dict[str, dict[str, Any]] = {}
    for tenant, token in (("tenant-a", a), ("tenant-b", b)):
        response = _assert_status(
            _authorized(
                client,
                token,
                "POST",
                "/api/conversations",
                json={"title": tenant + " proof"},
            ),
            201,
            "create conversation",
        )
        conversations[tenant] = response.json()
    if conversations["tenant-a"]["dsh_session_id"] == conversations["tenant-b"]["dsh_session_id"]:
        raise AssertionError("tenant sessions were not distinct")

    cross_denials = 0
    a_conversation = conversations["tenant-a"]
    a_conversation_path = "/api/conversations/" + a_conversation["id"]
    for method, path, kwargs in (
        ("GET", a_conversation_path, {}),
        ("POST", a_conversation_path + "/acknowledge-recovery", {}),
        (
            "POST",
            a_conversation_path + "/runs",
            {
                "headers": {"Idempotency-Key": IDEMPOTENCY_KEY},
                "json": {"prompt": "cross tenant", "artifacts": ["proof.txt"]},
            },
        ),
    ):
        _assert_status(
            _authorized(client, b, method, path, **kwargs), 404, "cross-tenant conversation"
        )
        cross_denials += 1

    for field, value in (
        ("tenant_id", "tenant-b"),
        ("session_id", a_conversation["dsh_session_id"]),
        ("dsh_session_id", a_conversation["dsh_session_id"]),
    ):
        _assert_status(
            _authorized(
                client,
                a,
                "POST",
                a_conversation_path + "/runs",
                headers={"Idempotency-Key": "spoof-" + field},
                json={"prompt": "spoof", "artifacts": ["proof.txt"], field: value},
            ),
            422,
            "forbidden selector body",
        )
        spoof_count += 1

    runs: dict[str, dict[str, Any]] = {}
    events: dict[str, list[str]] = {}
    artifacts: dict[str, dict[str, Any]] = {}
    for tenant, token in (("tenant-a", a), ("tenant-b", b)):
        conversation = conversations[tenant]
        prompt = (
            "Write exactly these ASCII bytes, with no trailing newline, to the "
            "service-required proof.txt artifact path: " + PROOFS[tenant].decode("ascii")
        )
        path = "/api/conversations/" + conversation["id"] + "/runs"
        request = {"prompt": prompt, "artifacts": ["proof.txt"]}
        submitted = _assert_status(
            _authorized(
                client,
                token,
                "POST",
                path,
                headers={"Idempotency-Key": IDEMPOTENCY_KEY},
                json=request,
            ),
            202,
            "submit run",
        ).json()
        repeated = _assert_status(
            _authorized(
                client,
                token,
                "POST",
                path,
                headers={"Idempotency-Key": IDEMPOTENCY_KEY},
                json=request,
            ),
            200,
            "repeat idempotent run",
        ).json()
        if repeated["id"] != submitted["id"]:
            raise AssertionError("idempotent replay changed the run id")
        terminal = _wait_terminal(client, token, submitted["id"], real)
        runs[tenant] = terminal
        if terminal["dsh_session_id"] != conversation["dsh_session_id"]:
            raise AssertionError("run did not use its tenant conversation session")
        artifact = terminal["artifacts"][0]
        if artifact["state"] != "available":
            raise AssertionError("proof artifact is unavailable")
        downloaded = _assert_status(
            _authorized(client, token, "GET", artifact["download_url"]),
            200,
            "download proof",
        )
        expected = PROOFS[tenant]
        if downloaded.content != expected:
            raise AssertionError("downloaded proof bytes differ from tenant expectation")
        digest = hashlib.sha256(expected).hexdigest()
        if artifact["sha256"] != digest or artifact["byte_size"] != len(expected):
            raise AssertionError("artifact metadata differs from external byte check")
        artifacts[tenant] = {"id": artifact["id"], "sha256": digest, "bytes": len(expected)}
        stream = _assert_status(
            _authorized(client, token, "GET", terminal["events_url"]), 200, "read SSE"
        )
        ids, names = _parse_sse(stream.text)
        replay = _assert_status(
            _authorized(
                client,
                token,
                "GET",
                terminal["events_url"],
                headers={"Last-Event-ID": str(ids[0])},
            ),
            200,
            "replay SSE",
        )
        replay_ids, _ = _parse_sse(replay.text)
        if replay_ids != [event_id for event_id in ids if event_id > ids[0]]:
            raise AssertionError("SSE cursor replay did not match durable event sequence")
        events[tenant] = names

    if runs["tenant-a"]["id"] == runs["tenant-b"]["id"]:
        raise AssertionError("two tenants unexpectedly shared a Run ID")
    if artifacts["tenant-a"]["sha256"] == artifacts["tenant-b"]["sha256"]:
        raise AssertionError("distinct tenant proofs unexpectedly matched")

    a_run = runs["tenant-a"]
    a_artifact = artifacts["tenant-a"]
    for method, path in (
        ("GET", "/api/runs/" + a_run["id"]),
        ("GET", "/api/runs/" + a_run["id"] + "/events"),
        ("GET", "/api/runs/" + a_run["id"] + "/artifacts/" + a_artifact["id"]),
    ):
        _assert_status(_authorized(client, b, method, path), 404, "cross-tenant run resource")
        cross_denials += 1

    return {
        "mode": "real" if real else "fake",
        "tenantA": {
            "conversationId": conversations["tenant-a"]["id"],
            "sessionId": conversations["tenant-a"]["dsh_session_id"],
            "runId": runs["tenant-a"]["id"],
            "sha256": artifacts["tenant-a"]["sha256"],
            "bytes": artifacts["tenant-a"]["bytes"],
            "sseEvents": len(events["tenant-a"]),
        },
        "tenantB": {
            "conversationId": conversations["tenant-b"]["id"],
            "sessionId": conversations["tenant-b"]["dsh_session_id"],
            "runId": runs["tenant-b"]["id"],
            "sha256": artifacts["tenant-b"]["sha256"],
            "bytes": artifacts["tenant-b"]["bytes"],
            "sseEvents": len(events["tenant-b"]),
        },
        "unauthorizedRoutes": 5,
        "crossTenant404": cross_denials,
        "selectorRejections": spoof_count,
        "sameIdempotencyKeyAcrossTenants": True,
    }


def _scan_credentials(root: Path, logs: str, tokens: dict[str, str]) -> int:
    candidates: list[Path] = []
    for tenant in PROOFS:
        directory = root / tenant
        candidates.extend(directory.glob("service.db*"))
        for base in (directory / "workspace" / "artifacts", directory / "dsh-home" / "sessions"):
            if base.exists():
                candidates.extend(path for path in base.rglob("*") if path.is_file())
    secrets_in_bytes = [token.encode("ascii") for token in tokens.values()]
    if any(token in logs for token in tokens.values()):
        raise AssertionError("a generated credential appeared in local server logs")
    for path in candidates:
        content = path.read_bytes()
        if any(token in content for token in secrets_in_bytes):
            raise AssertionError("a generated credential appeared in tenant storage")
    return len(candidates)


def _build_apps(root: Path, real: bool) -> tuple[dict[str, Any], dict[str, ObservedRuntime]]:
    from recoverable_agent_service.runtime import DSHRuntimeAdapter

    applications: dict[str, Any] = {}
    owners: dict[str, ObservedRuntime] = {}
    for tenant, proof in PROOFS.items():
        directory = root / tenant
        directory.mkdir(mode=0o700)
        workspace = directory / "workspace"
        home = directory / "dsh-home"
        repository = SQLiteStore(directory / "service.db")
        adapter = (
            DSHRuntimeAdapter(workspace, home, provider="deepseek-official", model="deepseek-flash")
            if real
            else ProofRuntime(workspace, proof)
        )
        owner = ObservedRuntime(adapter)
        owners[tenant] = owner
        coordinator = RunCoordinator(repository, owner, workspace, poll_interval=0.05)
        applications[tenant] = create_app(
            store=repository,
            coordinator=coordinator,
            workspace=workspace,
            dsh_home=home,
            heartbeat_interval=0.2,
        )
    return applications, owners


def main() -> None:
    """Run the keyless probe by default; --real calls the configured DSH provider."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--real", action="store_true")
    args = parser.parse_args()
    if args.real:
        import os

        if not os.environ.get("DEEPSEEK_API_KEY"):
            parser.error("--real requires DEEPSEEK_API_KEY")

    root = Path(tempfile.mkdtemp(prefix="tenant-http-probe-"))
    tokens = {tenant: secrets.token_urlsafe(32) for tenant in PROOFS}
    credentials = {
        hashlib.sha256(token.encode("ascii")).hexdigest(): tenant
        for tenant, token in tokens.items()
    }
    apps, owners = _build_apps(root, args.real)
    app = create_tenant_app(apps, credentials)

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    logs = io.StringIO()
    handler = logging.StreamHandler(logs)
    loggers = [logging.getLogger("uvicorn.error"), logging.getLogger("uvicorn.access")]
    for logger in loggers:
        logger.addHandler(handler)
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, access_log=False)
    )
    failures: list[BaseException] = []

    def serve() -> None:
        try:
            asyncio.run(server.serve(sockets=[listener]))
        except BaseException as error:
            failures.append(error)

    thread = threading.Thread(target=serve, name="tenant-http-probe", daemon=True)
    thread.start()
    evidence: dict[str, object] | None = None
    close_confirmed = False
    try:
        with httpx2.Client(
            base_url=f"http://127.0.0.1:{port}",
            timeout=httpx2.Timeout(5.0),
            trust_env=False,
        ) as client:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if failures:
                    raise RuntimeError("tenant server failed during startup") from failures[0]
                try:
                    ready = _authorized(client, tokens["tenant-a"], "GET", "/api/health")
                except httpx2.RequestError:
                    time.sleep(0.05)
                    continue
                if ready.status_code == 200 and ready.json().get("status") == "ok":
                    break
                time.sleep(0.05)
            else:
                raise TimeoutError("tenant server did not become ready")
            evidence = _exercise(client, tokens, args.real)
    finally:
        server.should_exit = True
        thread.join(timeout=45 if args.real else 15)
        close_confirmed = not thread.is_alive() and not failures
        listener.close()
        for logger in loggers:
            logger.removeHandler(handler)
        if close_confirmed and evidence is not None:
            if not all(owner.closed for owner in owners.values()):
                raise RuntimeError(
                    "a tenant runtime close was unconfirmed; owned probe state retained at "
                    + str(root)
                )
            scanned = _scan_credentials(root, logs.getvalue(), tokens)
            evidence["storageFilesScanned"] = scanned
            evidence["credentialsAbsentFromStorageAndLogs"] = True
            evidence["tenantRuntimesClosed"] = True
            evidence["serverStopped"] = True
            shutil.rmtree(root)
        elif not close_confirmed:
            raise RuntimeError(
                "tenant server close was unconfirmed; owned probe state retained at " + str(root)
            )
    if evidence is None:
        raise RuntimeError("tenant probe produced no evidence")
    print(json.dumps(evidence, sort_keys=True))


if __name__ == "__main__":
    main()
