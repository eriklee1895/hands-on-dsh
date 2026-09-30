"""Execute fixed evaluation inputs through the real service lifecycle."""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from .app import create_app
from .coordinator import RunCoordinator
from .domain import normalize_artifact_names
from .eval_contract import EvalCase
from .events import RuntimeEvent
from .runtime import (
    DSHRuntimeAdapter,
    EmitEvent,
    ExecutionUncertainError,
    RuntimeAdapter,
    RuntimeResult,
)
from .store import SQLiteStore

SCENARIOS = frozenset({"success", "tool-error", "aborted-turn", "transport-disconnect", "recovery"})
TERMINAL_STATES = frozenset({"succeeded", "failed"})
CONTROLLED_DEADLINE_SECONDS = 5.0
REAL_DEADLINE_SECONDS = 180.0


class ControlledRuntime:
    """Return one scenario-specific result using only validated case input."""

    def __init__(self, scenario: str, case_input: dict[str, object], workspace: Path) -> None:
        self.scenario = scenario
        self.case_input = case_input
        self.workspace = workspace
        self.closed = False

    async def run(self, dsh_session_id: str, runtime_input: str, emit: EmitEvent) -> RuntimeResult:
        """Write requested bytes or emit a controlled terminal outcome."""
        prompt = self.case_input["prompt"]
        artifact_name = self.case_input["artifact_name"]
        artifact_content = self.case_input["artifact_content"]
        if not all(isinstance(value, str) for value in (prompt, artifact_name, artifact_content)):
            raise ValueError("evaluation input strings are required")
        if prompt not in runtime_input:
            raise ValueError("runtime input omitted the case prompt")
        (safe_name,) = normalize_artifact_names([artifact_name])
        path_expression = rf"`artifacts/([0-9a-f-]{{36}})/{re.escape(safe_name)}`"
        path_match = re.search(path_expression, runtime_input)
        if path_match is None:
            raise ValueError("runtime input omitted the declared artifact path")

        if self.scenario == "transport-disconnect":
            raise ExecutionUncertainError("controlled transport disconnected")
        if self.scenario == "aborted-turn":
            return RuntimeResult(final_response="partial", finish_reason="aborted")
        if self.scenario == "tool-error":
            await emit(
                RuntimeEvent(
                    type="tool_call",
                    data={
                        "session_id": dsh_session_id,
                        "call_id": "controlled-call",
                        "name": "controlled-tool",
                        "arguments": {},
                    },
                )
            )
            await emit(
                RuntimeEvent(
                    type="tool_result",
                    data={
                        "session_id": dsh_session_id,
                        "call_id": "controlled-call",
                        "text": "controlled tool failure",
                        "is_error": True,
                    },
                )
            )
            return RuntimeResult(final_response="tool failed", finish_reason="completed")

        artifact_path = self.workspace / "artifacts" / path_match.group(1) / safe_name
        artifact_path.write_bytes(artifact_content.encode("utf-8"))
        await emit(
            RuntimeEvent(
                type="assistant_message",
                data={"session_id": dsh_session_id, "text": "controlled completion"},
            )
        )
        return RuntimeResult(final_response="controlled completion", finish_reason="completed")

    async def close(self) -> None:
        """Confirm the controlled adapter has no owned runtime process."""
        self.closed = True


class CountingRuntime:
    """Count actual adapter invocations and confirm adapter shutdown."""

    def __init__(self, adapter: RuntimeAdapter) -> None:
        self.adapter = adapter
        self.calls = 0
        self.finish_reason: str | None = None
        self.closed = False

    async def run(self, dsh_session_id: str, runtime_input: str, emit: EmitEvent) -> RuntimeResult:
        """Count an attempt before invoking the underlying adapter."""
        self.calls += 1
        result = await self.adapter.run(dsh_session_id, runtime_input, emit)
        self.finish_reason = result.finish_reason
        return result

    async def close(self) -> None:
        """Mark cleanup confirmed only after the underlying close returns."""
        await self.adapter.close()
        self.closed = True


def _case_input(case: EvalCase) -> tuple[str, str, str]:
    values = case.input
    prompt = values.get("prompt")
    artifact_name = values.get("artifact_name")
    artifact_content = values.get("artifact_content")
    if not all(isinstance(value, str) for value in (prompt, artifact_name, artifact_content)):
        raise ValueError("evaluation input strings are required")
    (safe_name,) = normalize_artifact_names([artifact_name])
    return prompt, safe_name, artifact_content


def _wait_terminal(client: TestClient, run_id: str, *, real: bool) -> dict[str, Any]:
    deadline = time.monotonic() + (REAL_DEADLINE_SECONDS if real else CONTROLLED_DEADLINE_SECONDS)
    while time.monotonic() < deadline:
        response = client.get(f"/api/runs/{run_id}")
        if response.status_code != 200:
            raise RuntimeError("evaluation Run could not be loaded")
        body = response.json()
        if body["state"] in TERMINAL_STATES:
            return body
        time.sleep(0.01 if not real else 0.2)
    raise TimeoutError("evaluation Run did not settle before its deadline")


def _frames(content: str) -> list[tuple[int, str, dict[str, object], str]]:
    frames = []
    for section in content.split("\n\n"):
        if not section.startswith("id: "):
            continue
        lines = section.splitlines()
        if (
            len(lines) != 3
            or not lines[1].startswith("event: ")
            or not lines[2].startswith("data: ")
        ):
            raise RuntimeError("evaluation received malformed SSE")
        event_id = int(lines[0].removeprefix("id: "))
        data = json.loads(lines[2].removeprefix("data: "))
        if not isinstance(data, dict):
            raise RuntimeError("evaluation received malformed SSE data")
        frames.append((event_id, lines[1].removeprefix("event: "), data, section))
    return frames


def _observe_sse(
    client: TestClient,
    events_url: str,
    store: SQLiteStore,
    run_id: str,
    last_event_seq: int,
) -> tuple[str, int, bool]:
    all_response = client.get(events_url)
    if all_response.status_code != 200:
        raise RuntimeError("evaluation SSE request failed")
    frames = _frames(all_response.text)
    if not frames:
        raise RuntimeError("evaluation SSE had no durable events")
    terminal_event = frames[-1][1]
    tool_errors = sum(
        frame[1] == "tool_result" and frame[2].get("is_error") is True for frame in frames
    )
    ids = [frame[0] for frame in frames]
    persisted = store.list_events(run_id)
    full_matches_store = ids == list(range(1, last_event_seq + 1)) and [
        (frame[0], frame[1], frame[2]) for frame in frames
    ] == [(event.seq, event.type, event.data) for event in persisted]
    if len(frames) < 2 or ids != sorted(set(ids)):
        return terminal_event, tool_errors, False
    cursor = frames[len(frames) // 2 - 1][0]
    replay = client.get(events_url, headers={"Last-Event-ID": str(cursor)})
    terminal_cursor = client.get(events_url, headers={"Last-Event-ID": str(ids[-1])})
    replay_exact = (
        full_matches_store
        and replay.status_code == 200
        and _frames(replay.text) == [frame for frame in frames if frame[0] > cursor]
        and terminal_cursor.status_code == 200
        and _frames(terminal_cursor.text) == []
    )
    return terminal_event, tool_errors, replay_exact


def _observe_artifact(
    client: TestClient, run: dict[str, Any], artifact_name: str
) -> tuple[str, str | None, int | None, int, bool]:
    artifacts = run.get("artifacts")
    artifact = (
        next((item for item in artifacts if item.get("requested_name") == artifact_name), None)
        if isinstance(artifacts, list)
        else None
    )
    if artifact is None:
        return "missing", None, None, 404, False
    response = client.get(artifact["download_url"])
    status = response.status_code
    if status == 200:
        content = response.content
        digest = hashlib.sha256(content).hexdigest()
        byte_size = len(content)
        matches = (
            artifact["state"] == "available"
            and artifact["sha256"] == digest
            and artifact["byte_size"] == byte_size
        )
        return artifact["state"], digest, byte_size, status, matches
    matches = (
        status == 404
        and artifact["state"] in {"missing", "invalid"}
        and artifact["sha256"] is None
        and artifact["byte_size"] is None
    )
    return artifact["state"], None, None, status, matches


def _submit(
    client: TestClient, conversation_id: str, prompt: str, artifact_name: str, key: str
) -> tuple[str, str, dict[str, object]]:
    path = f"/api/conversations/{conversation_id}/runs"
    request: dict[str, object] = {"prompt": prompt, "artifacts": [artifact_name]}
    response = client.post(path, headers={"Idempotency-Key": key}, json=request)
    if response.status_code != 202:
        raise RuntimeError("evaluation Run submission failed")
    return response.json()["id"], path, request


def run_case(case: EvalCase, root: Path, real: bool = False) -> dict[str, object]:
    """Observe one case through SQLite, HTTP, SSE, artifacts, and owned cleanup.

    The caller owns ``root``. This function never reads ``case.expected`` and
    retains all state when execution or cleanup cannot be confirmed.
    """
    if case.scenario not in SCENARIOS:
        raise ValueError("unsupported evaluation scenario")
    if real and case.scenario != "success":
        raise ValueError("real evaluation supports only success")
    prompt, artifact_name, _artifact_content = _case_input(case)
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    store = SQLiteStore(root / "service.db")
    workspace = root / "workspace"
    prior_id: str | None = None
    original_session_id: str | None = None
    if case.scenario == "recovery":
        store.migrate()
        conversation = store.create_conversation()
        original_session_id = conversation.dsh_session_id
        prior_id = store.submit_run(conversation.id, "pre-restart", prompt, [artifact_name]).run.id
        claimed = store.claim_oldest_run()
        if claimed is None or claimed.id != prior_id:
            raise RuntimeError("evaluation recovery seed was not claimed")

    adapter: RuntimeAdapter = (
        DSHRuntimeAdapter(
            workspace, root / "home", provider="deepseek-official", model="deepseek-v4-flash"
        )
        if real
        else ControlledRuntime(case.scenario, case.input, workspace)
    )
    counted = CountingRuntime(adapter)
    coordinator = RunCoordinator(store, counted, workspace, poll_interval=0.01)
    app = create_app(store=store, coordinator=coordinator, heartbeat_interval=0.01)
    observation: dict[str, object]
    try:
        with TestClient(app) as client:
            recovered_before: dict[str, Any] | None = None
            prior_frames_before: list[tuple[int, str, dict[str, object], str]] | None = None
            recovery_rotated: bool | None = None
            prior_preserved: bool | None = None
            if prior_id is not None:
                recovered_before = client.get(f"/api/runs/{prior_id}").json()
                prior_terminal = recovered_before["state"] in TERMINAL_STATES
                if prior_terminal:
                    prior_events = client.get(recovered_before["events_url"])
                    prior_frames_before = _frames(prior_events.text)
                no_automatic_call = counted.calls == 0
                conversation_id = recovered_before["conversation_id"]
                pre_ack = client.get(f"/api/conversations/{conversation_id}").json()
                startup_uncertain = (
                    no_automatic_call
                    and recovered_before["state"] == "failed"
                    and recovered_before["error_code"] == "execution_uncertain"
                    and recovered_before["dsh_session_id"] == original_session_id
                    and pre_ack["state"] == "attention_required"
                    and pre_ack["dsh_session_id"] == original_session_id
                )
                acknowledgement = client.post(
                    f"/api/conversations/{conversation_id}/acknowledge-recovery"
                )
                if acknowledgement.status_code != 200:
                    raise RuntimeError("evaluation recovery acknowledgement failed")
                acknowledged = acknowledgement.json()
                recovery_rotated = (
                    startup_uncertain
                    and acknowledged["state"] == "active"
                    and acknowledged["dsh_session_id"] != original_session_id
                )
            else:
                created = client.post("/api/conversations", json={"title": "evaluation"})
                if created.status_code != 201:
                    raise RuntimeError("evaluation Conversation creation failed")
                conversation_id = created.json()["id"]

            run_id, submission_path, request = _submit(
                client, conversation_id, prompt, artifact_name, f"evaluation-{case.id}"
            )
            run = _wait_terminal(client, run_id, real=real)
            conversation = client.get(f"/api/conversations/{conversation_id}").json()
            terminal_event, tool_errors, replay_exact = _observe_sse(
                client, run["events_url"], store, run_id, run["last_event_seq"]
            )
            artifact_state, artifact_sha256, artifact_bytes, download_status, metadata_matches = (
                _observe_artifact(client, run, artifact_name)
            )
            calls_before_replay = counted.calls
            events_before_replay = run["last_event_seq"]
            repeated = client.post(
                submission_path,
                headers={"Idempotency-Key": f"evaluation-{case.id}"},
                json=request,
            )
            repeated_run = client.get(f"/api/runs/{run_id}")
            idempotent_replay = (
                repeated.status_code == 200
                and repeated.json()["id"] == run_id
                and counted.calls == calls_before_replay
                and repeated_run.status_code == 200
                and repeated_run.json()["last_event_seq"] == events_before_replay
            )
            if prior_id is not None and recovered_before is not None:
                prior_after = client.get(f"/api/runs/{prior_id}").json()
                prior_after_events = client.get(prior_after["events_url"])
                prior_preserved = (
                    prior_after == recovered_before
                    and prior_frames_before is not None
                    and _frames(prior_after_events.text) == prior_frames_before
                    and run["dsh_session_id"] == conversation["dsh_session_id"]
                    and run["dsh_session_id"] != original_session_id
                )
            observation = {
                "state": run["state"],
                "error_code": run["error_code"],
                "conversation_state": conversation["state"],
                "artifact_state": artifact_state,
                "artifact_sha256": artifact_sha256,
                "artifact_bytes": artifact_bytes,
                "artifact_download_status": download_status,
                "artifact_metadata_matches": metadata_matches,
                "tool_errors": tool_errors,
                "runtime_calls": counted.calls,
                "runtime_finish": counted.finish_reason,
                "terminal_event": terminal_event,
                "replay_exact": replay_exact,
                "idempotent_replay": idempotent_replay,
                "recovery_rotated": recovery_rotated,
                "prior_run_preserved": prior_preserved,
                "cleanup_confirmed": False,
            }
    except Exception as error:
        raise RuntimeError(
            f"evaluation failed or cleanup was not confirmed; retained state at {root}"
        ) from error
    final_event_seq = store.get_run(run_id).last_event_seq
    observation["runtime_calls"] = counted.calls
    observation["runtime_finish"] = counted.finish_reason
    observation["idempotent_replay"] = (
        bool(observation["idempotent_replay"])
        and counted.calls == calls_before_replay
        and final_event_seq == events_before_replay
    )
    observation["cleanup_confirmed"] = counted.closed and not coordinator.worker_running
    return observation
