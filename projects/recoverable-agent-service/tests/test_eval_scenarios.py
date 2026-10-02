"""Behavioral checks for the service-backed evaluation runner."""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from recoverable_agent_service.eval_contract import EvalCase, grade_case, load_dataset
from recoverable_agent_service.eval_scenarios import run_case

CASES_PATH = Path(__file__).parents[1] / "eval" / "cases.json"
OBSERVATION_FIELDS = {
    "state",
    "error_code",
    "conversation_state",
    "artifact_state",
    "artifact_sha256",
    "artifact_bytes",
    "artifact_download_status",
    "artifact_metadata_matches",
    "tool_errors",
    "runtime_calls",
    "runtime_finish",
    "terminal_event",
    "replay_exact",
    "idempotent_replay",
    "recovery_rotated",
    "prior_run_preserved",
    "cleanup_confirmed",
}


def cases() -> list[EvalCase]:
    return load_dataset(CASES_PATH).cases


@pytest.mark.parametrize("case", cases(), ids=lambda case: case.id)
def test_controlled_case_observes_service_state_and_exact_fixture(case, tmp_path: Path) -> None:
    observed = run_case(case, tmp_path / case.id)

    assert set(observed) == OBSERVATION_FIELDS
    assert observed == case.expected
    assert (tmp_path / case.id / "service.db").is_file()


@pytest.mark.parametrize(
    ("scenario", "finish"),
    [
        ("success", "completed"),
        ("tool-error", "completed"),
        ("aborted-turn", "aborted"),
        ("transport-disconnect", None),
        ("recovery", "completed"),
    ],
)
def test_runtime_finish_is_observed_from_adapter_settlement(
    scenario: str, finish: str | None, tmp_path: Path
) -> None:
    case = next(item for item in cases() if item.scenario == scenario)

    assert run_case(case, tmp_path / scenario)["runtime_finish"] == finish


def test_runner_uses_input_not_expected_to_write_artifact(tmp_path: Path) -> None:
    original = next(case for case in cases() if case.scenario == "success")

    class PoisonExpected(SimpleNamespace):
        def __getattribute__(self, name: str) -> object:
            if name == "expected":
                raise AssertionError("runner read expected")
            return super().__getattribute__(name)

    changed = PoisonExpected(
        id=original.id,
        scenario=original.scenario,
        input={**original.input, "artifact_content": "ACTUAL_FROM_INPUT_ONLY"},
        expected=object(),
        metadata=original.metadata,
    )

    observed = run_case(changed, tmp_path / "changed")

    assert observed["artifact_sha256"] == hashlib.sha256(b"ACTUAL_FROM_INPUT_ONLY").hexdigest()
    assert observed["artifact_sha256"] != original.expected["artifact_sha256"]
    assert observed["artifact_bytes"] == len(b"ACTUAL_FROM_INPUT_ONLY")


def test_controlled_artifact_content_uses_utf8_bytes(tmp_path: Path) -> None:
    original = next(case for case in cases() if case.scenario == "success")
    content = "EVAL_你好"
    changed = SimpleNamespace(
        id=original.id,
        scenario=original.scenario,
        input={**original.input, "artifact_content": content},
        expected=object(),
        metadata=original.metadata,
    )

    observed = run_case(changed, tmp_path / "unicode")

    assert observed["state"] == "succeeded"
    assert observed["artifact_sha256"] == hashlib.sha256(content.encode("utf-8")).hexdigest()
    assert observed["artifact_bytes"] == len(content.encode("utf-8"))


def test_recovery_requires_prior_uncertain_outcome_before_rotation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from recoverable_agent_service.store import SQLiteStore

    original = SQLiteStore.recover_running_runs

    def misclassify_recovered_run(store: SQLiteStore) -> int:
        count = original(store)
        with sqlite3.connect(store.database_path) as connection:
            connection.execute(
                "UPDATE runs SET error_code = 'agent_outcome' WHERE state = 'failed'"
            )
        return count

    monkeypatch.setattr(SQLiteStore, "recover_running_runs", misclassify_recovered_run)
    case = next(item for item in cases() if item.scenario == "recovery")

    observed = run_case(case, tmp_path / "misclassified")

    assert observed["recovery_rotated"] is False


def test_replay_detects_event_omitted_by_http_projection(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from recoverable_agent_service import sse

    original = sse.encode_event

    def omit_second_frame(seq: int, event_type: str, data: object) -> str:
        return "" if seq == 2 else original(seq, event_type, data)

    monkeypatch.setattr(sse, "encode_event", omit_second_frame)
    case = next(item for item in cases() if item.scenario == "success")

    observed = run_case(case, tmp_path / "omitted")

    assert observed["replay_exact"] is False


def test_real_mode_rejects_non_success_without_runtime_launch(tmp_path: Path) -> None:
    case = next(item for item in cases() if item.scenario == "tool-error")

    with pytest.raises(ValueError, match="success"):
        run_case(case, tmp_path / "refused", real=True)

    assert not (tmp_path / "refused").exists()


def test_failed_close_retains_owned_root(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from recoverable_agent_service import eval_scenarios

    case = next(item for item in cases() if item.scenario == "success")

    async def fail_close(_self) -> None:
        raise RuntimeError("close failed")

    monkeypatch.setattr(eval_scenarios.ControlledRuntime, "close", fail_close)
    root = tmp_path / "retained"

    with pytest.raises(RuntimeError, match="cleanup was not confirmed"):
        run_case(case, root)

    assert (root / "service.db").is_file()


def test_late_runtime_work_during_close_invalidates_idempotency(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from recoverable_agent_service import eval_scenarios
    from recoverable_agent_service.runtime import RuntimeResult

    original_counted_run = eval_scenarios.CountingRuntime.run
    original_counted_close = eval_scenarios.CountingRuntime.close
    original_controlled_run = eval_scenarios.ControlledRuntime.run
    submitted: dict[object, tuple[str, str]] = {}
    controlled_calls: dict[object, int] = {}

    async def counted_run(self, session_id, runtime_input, emit):
        submitted[self] = (session_id, runtime_input)
        return await original_counted_run(self, session_id, runtime_input, emit)

    async def controlled_run(self, session_id, runtime_input, emit):
        controlled_calls[self] = controlled_calls.get(self, 0) + 1
        if controlled_calls[self] == 2:
            return RuntimeResult(final_response="late", finish_reason="max-tokens")
        return await original_controlled_run(self, session_id, runtime_input, emit)

    async def late_close(self):
        session_id, runtime_input = submitted[self]

        async def discard(_event) -> None:
            pass

        await self.run(session_id, runtime_input, discard)
        await original_counted_close(self)

    monkeypatch.setattr(eval_scenarios.CountingRuntime, "run", counted_run)
    monkeypatch.setattr(eval_scenarios.ControlledRuntime, "run", controlled_run)
    monkeypatch.setattr(eval_scenarios.CountingRuntime, "close", late_close)
    case = next(item for item in cases() if item.scenario == "success")
    root = tmp_path / "late-work"

    observed = run_case(case, root)

    assert observed["cleanup_confirmed"] is True
    assert observed["runtime_calls"] == 2
    assert observed["runtime_finish"] == "max-tokens"
    assert observed["idempotent_replay"] is False
    assert grade_case(case, observed)["passed"] is False
    assert (root / "service.db").is_file()


def test_event_sequence_change_during_close_invalidates_idempotency(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from recoverable_agent_service import eval_scenarios

    original_close = eval_scenarios.CountingRuntime.close
    root = tmp_path / "late-sequence"

    async def change_sequence_during_close(self) -> None:
        await original_close(self)
        with sqlite3.connect(root / "service.db") as connection:
            connection.execute("UPDATE runs SET last_event_seq = last_event_seq + 1")

    monkeypatch.setattr(eval_scenarios.CountingRuntime, "close", change_sequence_during_close)
    case = next(item for item in cases() if item.scenario == "success")

    observed = run_case(case, root)

    assert observed["runtime_calls"] == 1
    assert observed["idempotent_replay"] is False
    assert grade_case(case, observed)["passed"] is False
    assert (root / "service.db").is_file()
