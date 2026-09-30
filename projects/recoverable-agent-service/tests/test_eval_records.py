from __future__ import annotations

import json
from pathlib import Path

import pytest

from recoverable_agent_service.eval_contract import load_dataset
from recoverable_agent_service.eval_records import read_record, write_record

DATASET = Path(__file__).parents[1] / "eval" / "cases.json"


def test_roundtrip_regrades_safe_observations_and_refuses_overwrite(tmp_path):
    dataset = load_dataset(DATASET)
    case = dataset.cases[0]
    observations = [{"case_id": case.id, "observation": dict(case.expected)}]
    path = tmp_path / "observations.json"
    write_record(path, dataset, observations, "controlled-service")
    mode, loaded = read_record(path, dataset)
    assert mode == "controlled-service"
    assert loaded == observations
    assert path.stat().st_mode & 0o777 == 0o600
    assert "prompt" not in path.read_text()
    with pytest.raises(FileExistsError):
        write_record(path, dataset, observations, mode)


def test_record_rejects_wrong_dataset_or_extra_payload(tmp_path):
    dataset = load_dataset(DATASET)
    case = dataset.cases[0]
    path = tmp_path / "observations.json"
    write_record(
        path,
        dataset,
        [{"case_id": case.id, "observation": dict(case.expected)}],
        "controlled-service",
    )
    original = json.loads(path.read_text())
    for modified in [
        dict(original, dataset_sha256="0" * 64),
        dict(original, private="DO_NOT_ECHO"),
    ]:
        path.write_text(json.dumps(modified))
        with pytest.raises(ValueError) as error:
            read_record(path, dataset)
        assert "DO_NOT_ECHO" not in str(error.value)
    modified = json.loads(json.dumps(original))
    modified["observations"][0]["observation"]["prompt"] = "DO_NOT_ECHO"
    path.write_text(json.dumps(modified))
    with pytest.raises(ValueError):
        read_record(path, dataset)


def test_record_rejects_duplicate_keys_and_empty_runs(tmp_path):
    dataset = load_dataset(DATASET)
    path = tmp_path / "observations.json"
    path.write_text('{"schema_version":1,"schema_version":1}')
    with pytest.raises(ValueError):
        read_record(path, dataset)
    with pytest.raises(ValueError):
        write_record(tmp_path / "empty.json", dataset, [], "controlled-service")
