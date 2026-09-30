"""Bounded, payload-free observations for local regrading against one dataset revision."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .eval_contract import Dataset, build_report, grade_case, validate_observation

MAX_RECORD_BYTES = 8 * 1024 * 1024


def dataset_digest(dataset: Dataset) -> str:
    """Identify exact inputs, expectations, and metadata; this is not a signature."""
    encoded = json.dumps(asdict(dataset), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _entries(dataset: Dataset, observations: object, mode: str) -> list[dict[str, Any]]:
    if not isinstance(observations, list) or not observations:
        raise ValueError("Invalid evaluation observations")
    cases = {case.id: case for case in dataset.cases}
    result = []
    grades = []
    for item in observations:
        if not isinstance(item, dict) or set(item) != {"case_id", "observation"}:
            raise ValueError("Invalid evaluation observation entry")
        case_id = item["case_id"]
        if not isinstance(case_id, str) or case_id not in cases:
            raise ValueError("Unknown evaluation case")
        observed = validate_observation(item["observation"])
        result.append({"case_id": case_id, "observation": observed})
        grades.append(grade_case(cases[case_id], observed))
    build_report(dataset, grades, mode)
    return result


def write_record(path: Path, dataset: Dataset, observations: object, mode: str) -> None:
    """Write a new mode-0600 record, refusing to overwrite any existing path."""
    packet = {
        "schema_version": 1,
        "dataset_id": dataset.dataset_id,
        "dataset_version": dataset.dataset_version,
        "dataset_sha256": dataset_digest(dataset),
        "mode": mode,
        "observations": _entries(dataset, observations, mode),
    }
    content = json.dumps(packet, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    if len(content.encode("utf-8")) > MAX_RECORD_BYTES:
        raise ValueError("Evaluation record exceeds size limit")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def _unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate record key")
        value[key] = item
    return value


def read_record(path: Path, dataset: Dataset) -> tuple[str, list[dict[str, Any]]]:
    """Revalidate every field and the dataset digest before returning saved observations."""
    try:
        with path.open("rb") as stream:
            content = stream.read(MAX_RECORD_BYTES + 1)
        if len(content) > MAX_RECORD_BYTES:
            raise ValueError("record too large")
        packet = json.loads(content, object_pairs_hook=_unique)
        if not isinstance(packet, dict) or set(packet) != {
            "schema_version",
            "dataset_id",
            "dataset_version",
            "dataset_sha256",
            "mode",
            "observations",
        }:
            raise ValueError("invalid record fields")
        if type(packet["schema_version"]) is not int or packet["schema_version"] != 1:
            raise ValueError("invalid record schema")
        if (
            type(packet["dataset_version"]) is not int
            or packet["dataset_version"] != dataset.dataset_version
        ):
            raise ValueError("dataset version changed")
        if packet["dataset_id"] != dataset.dataset_id or packet["dataset_sha256"] != dataset_digest(
            dataset
        ):
            raise ValueError("dataset changed")
        return packet["mode"], _entries(dataset, packet["observations"], packet["mode"])
    except (OSError, ValueError, TypeError, RecursionError):
        # JSON decoder errors can include source fragments; do not echo their contents.
        raise ValueError("Invalid evaluation record or mismatched dataset") from None
