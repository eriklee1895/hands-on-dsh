"""Strict dataset and observation contracts for the recoverable service evaluation."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

SDK_VERSION = "0.1.5rc1"
SCENARIOS = frozenset({"success", "tool-error", "aborted-turn", "transport-disconnect", "recovery"})
MODES = frozenset({"controlled-service", "real-provider"})
_EXPECTED_FINISH_BY_SCENARIO = {
    "success": "completed",
    "tool-error": "completed",
    "aborted-turn": "aborted",
    "transport-disconnect": None,
    "recovery": "completed",
}
OBSERVATION_FIELDS = (
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

_SLUG = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
_ARTIFACT_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_SHA256 = re.compile(r"[0-9a-fA-F]{64}\Z")


@dataclass(frozen=True)
class EvalCase:
    """One fixed input and expected service observation."""

    id: str
    scenario: str
    input: dict[str, object]
    expected: dict[str, object]
    metadata: dict[str, object]


@dataclass(frozen=True)
class Dataset:
    """Versioned collection of deterministic service cases."""

    dataset_id: str
    dataset_version: int
    sdk_version: str
    cases: tuple[EvalCase, ...]


def _record(value: object, keys: set[str], label: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"{label} fields are invalid")
    return value


def _nonempty(value: object, label: str) -> str:
    if type(value) is not str or not value.strip():
        raise ValueError(f"{label} must be nonempty text")
    return value


def _positive_int(value: object, label: str) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return value


def _slug(value: object, label: str) -> str:
    if type(value) is not str or _SLUG.fullmatch(value) is None or value.endswith("-"):
        raise ValueError(f"{label} must be a safe slug")
    return value


def _valid_observation_field(name: str, value: object) -> bool:
    if name == "state":
        return type(value) is str and value in {"succeeded", "failed"}
    if name == "error_code":
        return value is None or (
            type(value) is str and value in {"agent_outcome", "execution_uncertain"}
        )
    if name == "runtime_finish":
        return value is None or (
            type(value) is str
            and value in {"completed", "aborted", "error", "max-tokens", "refusal"}
        )
    if name == "conversation_state":
        return type(value) is str and value in {"active", "attention_required"}
    if name == "artifact_state":
        return type(value) is str and value in {"available", "missing", "invalid"}
    if name == "artifact_sha256":
        return value is None or (type(value) is str and _SHA256.fullmatch(value) is not None)
    if name == "artifact_bytes":
        return value is None or (type(value) is int and value >= 0)
    if name == "artifact_download_status":
        return type(value) is int and value in {200, 404}
    if name in {"tool_errors", "runtime_calls"}:
        return type(value) is int and value >= 0
    if name == "terminal_event":
        return type(value) is str and value in {"run.succeeded", "run.failed"}
    if name in {"recovery_rotated", "prior_run_preserved"}:
        return value is None or type(value) is bool
    return name in OBSERVATION_FIELDS and type(value) is bool


def validate_observation(value: object) -> dict[str, object]:
    """Return a detached observation with exactly the seventeen typed fields."""

    observation = _record(value, set(OBSERVATION_FIELDS), "observation")
    for name in OBSERVATION_FIELDS:
        if not _valid_observation_field(name, observation[name]):
            raise ValueError(f"observation field {name} is invalid")
    return {name: observation[name] for name in OBSERVATION_FIELDS}


def parse_dataset(value: object) -> Dataset:
    """Validate an already-decoded version-one dataset."""

    root = _record(
        value,
        {"schema_version", "dataset_id", "dataset_version", "sdk_version", "cases"},
        "dataset",
    )
    if type(root["schema_version"]) is not int or root["schema_version"] != 1:
        raise ValueError("dataset schema_version is invalid")
    dataset_id = _slug(root["dataset_id"], "dataset_id")
    dataset_version = _positive_int(root["dataset_version"], "dataset_version")
    if root["sdk_version"] != SDK_VERSION or type(root["sdk_version"]) is not str:
        raise ValueError("dataset sdk_version is invalid")
    raw_cases = root["cases"]
    if not isinstance(raw_cases, list) or not raw_cases:
        raise ValueError("dataset cases must be a nonempty list")

    cases: list[EvalCase] = []
    seen: set[str] = set()
    for raw_case in raw_cases:
        item = _record(raw_case, {"id", "scenario", "input", "expected", "metadata"}, "case")
        case_id = _slug(item["id"], "case id")
        if case_id in seen:
            raise ValueError("dataset case ids must be unique")
        seen.add(case_id)
        scenario = item["scenario"]
        if type(scenario) is not str or scenario not in SCENARIOS:
            raise ValueError("case scenario is invalid")
        input_data = _record(
            item["input"], {"prompt", "artifact_name", "artifact_content"}, "case input"
        )
        prompt = _nonempty(input_data["prompt"], "case prompt")
        artifact_name = input_data["artifact_name"]
        if (
            type(artifact_name) is not str
            or _ARTIFACT_NAME.fullmatch(artifact_name) is None
            or ".." in artifact_name
        ):
            raise ValueError("case artifact_name is invalid")
        artifact_content = _nonempty(input_data["artifact_content"], "case artifact_content")
        expected = validate_observation(item["expected"])
        if expected["runtime_finish"] != _EXPECTED_FINISH_BY_SCENARIO[scenario]:
            raise ValueError("case runtime_finish disagrees with scenario")
        if expected["artifact_state"] == "available":
            content_bytes = artifact_content.encode("utf-8")
            if (
                expected["artifact_sha256"] != sha256(content_bytes).hexdigest()
                or expected["artifact_bytes"] != len(content_bytes)
                or expected["artifact_download_status"] != 200
            ):
                raise ValueError("available artifact expectation disagrees with case input")
        elif (
            expected["artifact_sha256"] is not None
            or expected["artifact_bytes"] is not None
            or expected["artifact_download_status"] != 404
        ):
            raise ValueError("unavailable artifact expectation is invalid")
        recovery_fields = (expected["recovery_rotated"], expected["prior_run_preserved"])
        if scenario == "recovery":
            if recovery_fields != (True, True):
                raise ValueError("recovery expected fields are invalid")
        elif recovery_fields != (None, None):
            raise ValueError("non-recovery expected fields are invalid")
        metadata = _record(item["metadata"], {"description", "evidence"}, "case metadata")
        description = _nonempty(metadata["description"], "case description")
        if metadata["evidence"] != "controlled-service-contract":
            raise ValueError("case evidence is invalid")
        cases.append(
            EvalCase(
                id=case_id,
                scenario=scenario,
                input={
                    "prompt": prompt,
                    "artifact_name": artifact_name,
                    "artifact_content": artifact_content,
                },
                expected=expected,
                metadata={"description": description, "evidence": "controlled-service-contract"},
            )
        )
    return Dataset(dataset_id, dataset_version, SDK_VERSION, tuple(cases))


def _unique_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("dataset JSON has duplicate key")
        result[key] = value
    return result


def _invalid_constant(_value: str) -> None:
    raise ValueError("dataset JSON has invalid number")


def load_dataset(path: Path | str) -> Dataset:
    """Read JSON while refusing duplicate keys and non-finite numbers."""

    try:
        value = json.loads(
            Path(path).read_text(encoding="utf-8"),
            object_pairs_hook=_unique_pairs,
            parse_constant=_invalid_constant,
        )
    except json.JSONDecodeError as error:
        raise ValueError("dataset JSON is invalid") from error
    return parse_dataset(value)


def grade_case(case: EvalCase, observation: object) -> dict[str, object]:
    """Compare typed evidence without including observed values in the result."""

    expected = validate_observation(case.expected)
    actual = observation if isinstance(observation, dict) else {}
    unknown = set(actual) - set(OBSERVATION_FIELDS)
    checks = {
        name: not unknown
        and name in actual
        and _valid_observation_field(name, actual[name])
        and actual[name] == expected[name]
        for name in OBSERVATION_FIELDS
    }
    failed_checks = [name for name in OBSERVATION_FIELDS if not checks[name]]
    return {
        "case_id": case.id,
        "passed": not failed_checks,
        "checks": checks,
        "failed_checks": failed_checks,
    }


def build_report(dataset: Dataset, results: list[dict], mode: str) -> dict[str, object]:
    """Validate grade integrity and report selected versus unrun cases."""

    if type(mode) is not str or mode not in MODES:
        raise ValueError("evaluation mode is invalid")
    if not isinstance(results, list) or not results:
        raise ValueError("evaluation results must be a nonempty list")
    cases = {case.id: case for case in dataset.cases}
    selected: dict[str, dict[str, object]] = {}
    for result in results:
        item = _record(result, {"case_id", "passed", "checks", "failed_checks"}, "grade")
        case_id = item["case_id"]
        if type(case_id) is not str or case_id not in cases or case_id in selected:
            raise ValueError("grade case_id is invalid or repeated")
        if mode == "real-provider" and cases[case_id].scenario != "success":
            raise ValueError("real-provider mode permits only success")
        checks = _record(item["checks"], set(OBSERVATION_FIELDS), "grade checks")
        if any(type(checks[name]) is not bool for name in OBSERVATION_FIELDS):
            raise ValueError("grade checks must be booleans")
        failed = [name for name in OBSERVATION_FIELDS if not checks[name]]
        if (
            type(item["passed"]) is not bool
            or item["passed"] != (not failed)
            or type(item["failed_checks"]) is not list
            or item["failed_checks"] != failed
        ):
            raise ValueError("grade summary does not match checks")
        selected[case_id] = {
            "case_id": case_id,
            "passed": item["passed"],
            "checks": {name: checks[name] for name in OBSERVATION_FIELDS},
            "failed_checks": failed,
        }
    selected_ids = [case.id for case in dataset.cases if case.id in selected]
    not_run = [case.id for case in dataset.cases if case.id not in selected]
    passed = sum(selected[case_id]["passed"] is True for case_id in selected_ids)
    return {
        "dataset_id": dataset.dataset_id,
        "dataset_version": dataset.dataset_version,
        "sdk_version": dataset.sdk_version,
        "mode": mode,
        "selected": selected_ids,
        "not_run": not_run,
        "results": [selected[case_id] for case_id in selected_ids],
        "counts": {
            "selected": len(selected_ids),
            "passed": passed,
            "failed": len(selected_ids) - passed,
            "not_run": len(not_run),
        },
    }
