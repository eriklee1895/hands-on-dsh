"""Strict, value-free regression grading of durable service observations."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

DATASET_PATH = Path(__file__).resolve().parents[1] / "eval" / "cases.json"
EXPECTED_FIELDS = (
    "state",
    "error_code",
    "runtime_finish",
    "conversation_state",
    "artifact_state",
    "artifact_sha256",
    "artifact_bytes",
    "artifact_download_status",
    "artifact_metadata_matches",
    "tool_errors",
    "runtime_calls",
    "terminal_event",
    "replay_exact",
    "idempotent_replay",
    "recovery_rotated",
    "prior_run_preserved",
    "cleanup_confirmed",
)


def dataset_value() -> dict:
    return json.loads(DATASET_PATH.read_text(encoding="utf-8"))


def test_loads_fixed_dataset_and_preserves_case_order() -> None:
    from recoverable_agent_service.eval_contract import load_dataset

    dataset = load_dataset(DATASET_PATH)
    assert (dataset.dataset_id, dataset.dataset_version, dataset.sdk_version) == (
        "recoverable-service-regression",
        1,
        "0.1.5rc1",
    )
    assert [case.id for case in dataset.cases] == [
        "success",
        "tool-error",
        "aborted-turn",
        "transport-disconnect",
        "recovery",
    ]
    assert set(dataset.cases[0].expected) == set(EXPECTED_FIELDS)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value.update(extra="surprise"),
        lambda value: value.update(schema_version=True),
        lambda value: value.update(dataset_version=0),
        lambda value: value.update(sdk_version="0.1.5rc2"),
        lambda value: value.update(cases=[]),
        lambda value: value["cases"].append(copy.deepcopy(value["cases"][0])),
        lambda value: value["cases"][0].update(id="../unsafe"),
        lambda value: value["cases"][0].update(scenario="unknown"),
        lambda value: value["cases"][0]["input"].update(extra="secret"),
        lambda value: value["cases"][0]["expected"].update(runtime_calls=True),
        lambda value: value["cases"][0]["expected"].pop("replay_exact"),
        lambda value: value["cases"][0]["expected"].pop("runtime_finish"),
        lambda value: value["cases"][0]["metadata"].update(evidence="model-judge"),
        lambda value: value["cases"][0]["expected"].update(recovery_rotated=True),
        lambda value: value["cases"][4]["expected"].update(prior_run_preserved=None),
    ],
)
def test_rejects_invalid_dataset_without_echoing_values(mutate) -> None:
    from recoverable_agent_service.eval_contract import parse_dataset

    value = dataset_value()
    mutate(value)
    with pytest.raises(ValueError) as error:
        parse_dataset(value)
    assert "secret" not in str(error.value)


def test_loader_rejects_duplicate_json_keys(tmp_path: Path) -> None:
    from recoverable_agent_service.eval_contract import load_dataset

    path = tmp_path / "duplicate.json"
    path.write_text('{"schema_version":1,"schema_version":1}', encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate"):
        load_dataset(path)


@pytest.mark.parametrize(
    "change",
    [
        lambda value: value["cases"][0]["expected"].update(artifact_sha256="0" * 64),
        lambda value: value["cases"][0]["expected"].update(artifact_bytes=99),
        lambda value: value["cases"][0]["expected"].update(artifact_download_status=404),
        lambda value: value["cases"][1]["expected"].update(artifact_bytes=24),
    ],
)
def test_dataset_refuses_artifact_expectations_that_disagree_with_fixed_input(change) -> None:
    from recoverable_agent_service.eval_contract import parse_dataset

    value = dataset_value()
    change(value)
    with pytest.raises(ValueError, match="artifact"):
        parse_dataset(value)


def test_dataset_refuses_a_different_finish_for_aborted_turn() -> None:
    from recoverable_agent_service.eval_contract import parse_dataset

    value = dataset_value()
    value["cases"][2]["expected"]["runtime_finish"] = "max-tokens"
    with pytest.raises(ValueError, match="runtime_finish"):
        parse_dataset(value)


@pytest.mark.parametrize(
    "change",
    [
        lambda value: value.update(runtime_calls=True),
        lambda value: value.update(runtime_finish="unknown"),
        lambda value: value.update(runtime_finish=True),
        lambda value: value.update(artifact_bytes=-1),
        lambda value: value.update(artifact_sha256="wrong"),
        lambda value: value.update(replay_exact=1),
        lambda value: value.update(terminal_event="run.queued"),
        lambda value: value.update(extra="unsafe"),
        lambda value: value.pop("cleanup_confirmed"),
    ],
)
def test_observation_validator_rejects_schema_errors(change) -> None:
    from recoverable_agent_service.eval_contract import validate_observation

    value = copy.deepcopy(dataset_value()["cases"][0]["expected"])
    change(value)
    with pytest.raises(ValueError):
        validate_observation(value)


def test_grader_compares_all_fields_and_catches_incorrect_evidence() -> None:
    from recoverable_agent_service.eval_contract import grade_case, load_dataset

    case = load_dataset(DATASET_PATH).cases[0]
    observation = dict(case.expected)
    passed = grade_case(case, observation)
    assert passed == {
        "case_id": "success",
        "passed": True,
        "checks": dict.fromkeys(EXPECTED_FIELDS, True),
        "failed_checks": [],
    }

    observation.update(
        state="failed",
        runtime_calls=2,
        artifact_sha256="0" * 64,
        replay_exact=False,
    )
    failed = grade_case(case, observation)
    assert failed["passed"] is False
    assert failed["failed_checks"] == [
        "state",
        "artifact_sha256",
        "runtime_calls",
        "replay_exact",
    ]
    assert set(failed) == {"case_id", "passed", "checks", "failed_checks"}
    assert not any("000000" in str(value) for value in failed.values())


def test_grader_fails_missing_wrong_type_and_unknown_fields() -> None:
    from recoverable_agent_service.eval_contract import grade_case, load_dataset

    case = load_dataset(DATASET_PATH).cases[0]
    for mutation in (
        {key: value for key, value in case.expected.items() if key != "replay_exact"},
        {**case.expected, "runtime_calls": True},
        {**case.expected, "extra": "private-value"},
    ):
        result = grade_case(case, mutation)
        assert result["passed"] is False
        assert result["failed_checks"]
        assert "private-value" not in str(result)


def test_aborted_turn_rejects_max_tokens_finish_even_with_same_error_code() -> None:
    from recoverable_agent_service.eval_contract import grade_case, load_dataset

    case = next(
        case for case in load_dataset(DATASET_PATH).cases if case.scenario == "aborted-turn"
    )
    observation = dict(case.expected)
    observation["runtime_finish"] = "max-tokens"

    result = grade_case(case, observation)
    assert result["passed"] is False
    assert result["failed_checks"] == ["runtime_finish"]


def test_report_tracks_selection_and_rejects_forged_results() -> None:
    from recoverable_agent_service.eval_contract import build_report, grade_case, load_dataset

    dataset = load_dataset(DATASET_PATH)
    result = grade_case(dataset.cases[0], dict(dataset.cases[0].expected))
    report = build_report(dataset, [result], "controlled-service")
    assert report == {
        "dataset_id": "recoverable-service-regression",
        "dataset_version": 1,
        "sdk_version": "0.1.5rc1",
        "mode": "controlled-service",
        "selected": ["success"],
        "not_run": ["tool-error", "aborted-turn", "transport-disconnect", "recovery"],
        "results": [result],
        "counts": {"selected": 1, "passed": 1, "failed": 0, "not_run": 4},
    }
    for invalid in (
        [],
        [result, result],
        [{**result, "case_id": "outside"}],
        [{**result, "passed": False}],
        [{**result, "checks": {**result["checks"], "runtime_calls": 1}}],
        [{**result, "failed_checks": ["runtime_calls"]}],
        [{**result, "extra": "private-value"}],
    ):
        with pytest.raises(ValueError):
            build_report(dataset, invalid, "controlled-service")
    with pytest.raises(ValueError):
        build_report(dataset, [result], "invalid-mode")
    with pytest.raises(ValueError):
        build_report(dataset, [result], [])
    non_success = grade_case(dataset.cases[1], dict(dataset.cases[1].expected))
    with pytest.raises(ValueError):
        build_report(dataset, [non_success], "real-provider")
