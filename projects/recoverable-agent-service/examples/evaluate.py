"""Grade fixed service scenarios, or regrade a saved record without executing the runtime."""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import shutil
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path

from recoverable_agent_service.eval_contract import build_report, grade_case, load_dataset
from recoverable_agent_service.eval_records import dataset_digest, read_record, write_record

DEFAULT_DATASET = Path(__file__).resolve().parents[1] / "eval" / "cases.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--case")
    parser.add_argument("--real", action="store_true")
    parser.add_argument("--record", type=Path)
    parser.add_argument("--replay", type=Path)
    parser.add_argument("--negative-control", action="store_true")
    parser.add_argument("--case-timeout", type=float, help="per-case process deadline in seconds")
    args = parser.parse_args()
    if args.replay and (
        args.real
        or args.case
        or args.record
        or args.negative_control
        or args.case_timeout is not None
    ):
        parser.error("--replay cannot be combined with execution options")
    if args.negative_control and (args.real or args.record):
        parser.error("negative controls are keyless and cannot be saved as actual observations")
    if args.case_timeout is not None and (
        not math.isfinite(args.case_timeout) or not 0 < args.case_timeout <= 3600
    ):
        parser.error("--case-timeout must be finite and between 0 and 3600 seconds")
    root: Path | None = None
    cleanup_confirmed = False
    exit_code = 2
    report: dict = {}
    try:
        dataset = load_dataset(args.dataset)
        cases = {case.id: case for case in dataset.cases}
        if args.replay:
            mode, observations = read_record(args.replay, dataset)
            execution = "record-replay"
        else:
            # Import only for execution, so regrading does not construct a runtime or service.
            from recoverable_agent_service.eval_process import run_isolated_case

            if any(
                version(package) != dataset.sdk_version
                for package in ("deepseek-harness-sdk", "deepseek-harness-runtime-bin")
            ):
                raise ValueError("Installed SDK/runtime does not match the dataset pin")
            selected = list(dataset.cases)
            if args.case:
                if args.case not in cases:
                    raise ValueError("Unknown case selection")
                selected = [cases[args.case]]
            if args.real:
                selected = [case for case in selected if case.scenario == "success"]
                if len(selected) != 1 or not os.environ.get("DEEPSEEK_API_KEY"):
                    raise ValueError(
                        "Real execution requires exactly one success case and a provider key"
                    )
            mode = "real-provider" if args.real else "controlled-service"
            execution = "real-run" if args.real else "controlled-run"
            if args.record and (
                args.record.exists() or args.record.is_symlink() or not args.record.parent.is_dir()
            ):
                raise ValueError("Record destination must be a new path in an existing directory")
            root = Path(tempfile.mkdtemp(prefix="dsh-eval-"))
            observations = [
                {
                    "case_id": case.id,
                    "observation": run_isolated_case(
                        args.dataset,
                        case.id,
                        root / case.id,
                        args.real,
                        args.case_timeout
                        if args.case_timeout is not None
                        else (240.0 if args.real else 15.0),
                        dataset_digest(dataset),
                    ),
                }
                for case in selected
            ]
            cleanup_confirmed = all(
                item["observation"].get("cleanup_confirmed") is True for item in observations
            )
            if args.negative_control:
                observations = copy.deepcopy(observations)
                observations[0]["observation"]["runtime_calls"] += 1
            if args.record:
                write_record(args.record, dataset, observations, mode)
        grades = [grade_case(cases[item["case_id"]], item["observation"]) for item in observations]
        report = build_report(dataset, grades, mode)
        report["execution"] = execution
        report["negative_control"] = args.negative_control
        exit_code = 1 if report["counts"]["failed"] else 0
    except Exception as error:
        report = {"error": "Evaluation could not complete", "error_type": type(error).__name__}
        exit_code = 2
    finally:
        if root is not None:
            if cleanup_confirmed:
                try:
                    shutil.rmtree(root)
                except OSError as error:
                    cleanup_confirmed = False
                    report = {
                        "error": "Evaluation cleanup failed",
                        "error_type": type(error).__name__,
                    }
                    exit_code = 2
            if not cleanup_confirmed:
                print(
                    json.dumps({"retained_directory": str(root), "cleanup_confirmed": False}),
                    file=sys.stderr,
                )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
