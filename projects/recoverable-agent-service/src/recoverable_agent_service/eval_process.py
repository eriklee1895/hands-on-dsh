"""Run one evaluation in an owned POSIX process group with a hard deadline."""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import re
import select
import signal
import subprocess
import sys
import time
from pathlib import Path

from .eval_contract import load_dataset, validate_observation
from .eval_records import dataset_digest

_TERM_GRACE_SECONDS = 0.5
_KILL_GRACE_SECONDS = 1.5
_MAX_OUTPUT_BYTES = 65536
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


def _require_digest(value: object) -> str:
    if type(value) is not str or _SHA256.fullmatch(value) is None:
        raise ValueError("expected dataset digest must be lowercase SHA-256")
    return value


def _group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_group_gone(pgid: int, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while _group_exists(pgid):
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.01)
    return True


def _signal_group(pgid: int, sig: signal.Signals) -> None:
    with contextlib.suppress(ProcessLookupError):
        os.killpg(pgid, sig)


def _reap_group(process: subprocess.Popen[bytes]) -> None:
    pgid = process.pid  # start_new_session makes this child the group leader.
    if _group_exists(pgid):
        _signal_group(pgid, signal.SIGTERM)
    try:
        process.wait(timeout=_TERM_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        if _group_exists(pgid):
            _signal_group(pgid, signal.SIGKILL)
        try:
            process.wait(timeout=_KILL_GRACE_SECONDS)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("evaluation child leader did not exit") from error
    if not _wait_group_gone(pgid, _TERM_GRACE_SECONDS):
        _signal_group(pgid, signal.SIGKILL)
        if not _wait_group_gone(pgid, _KILL_GRACE_SECONDS):
            raise RuntimeError("evaluation child process group did not drain")


def _read_result(process: subprocess.Popen[bytes], deadline: float) -> dict[str, object]:
    if process.stdout is None:
        raise RuntimeError("evaluation child has no result channel")
    output = bytearray()
    while True:
        remaining = max(0.0, deadline - time.monotonic())
        ready, _, _ = select.select([process.stdout], [], [], remaining)
        if not ready:
            raise TimeoutError("evaluation child result exceeded deadline")
        chunk = os.read(process.stdout.fileno(), 4096)
        if not chunk:
            break
        output.extend(chunk)
        if len(output) > _MAX_OUTPUT_BYTES:
            raise RuntimeError("evaluation child result is too large")
    if not output:
        raise RuntimeError("evaluation child emitted no result")
    try:
        value = json.loads(output)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("evaluation child result is not JSON") from error
    if not isinstance(value, dict) or "error_type" in value:
        raise RuntimeError("evaluation child emitted no observation")
    return value


def _run_owned(argv: list[str], timeout_seconds: float) -> dict[str, object]:
    """Execute a structured internal command and accept one bounded JSON object."""

    if os.name != "posix":
        raise RuntimeError("evaluation process isolation requires POSIX")
    if (
        type(timeout_seconds) not in {int, float}
        or not math.isfinite(timeout_seconds)
        or timeout_seconds <= 0
        or timeout_seconds > 3600
    ):
        raise ValueError("evaluation timeout must be finite and within 0..3600 seconds")
    deadline = time.monotonic() + timeout_seconds
    process = subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    try:
        try:
            process.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired as error:
            raise TimeoutError("evaluation case exceeded deadline") from error
        if _group_exists(process.pid):
            raise RuntimeError("evaluation child left an active process group")
        if process.returncode != 0:
            raise RuntimeError("evaluation child failed")
        return _read_result(process, deadline)
    except BaseException:
        if process.poll() is None or _group_exists(process.pid):
            _reap_group(process)
        raise
    finally:
        if process.stdout is not None:
            process.stdout.close()


def run_isolated_case(
    dataset_path: Path,
    case_id: str,
    root: Path,
    real: bool,
    timeout_seconds: float,
    expected_dataset_sha256: str,
) -> dict[str, object]:
    """Return a typed observation only after the child and its group have drained."""

    if type(real) is not bool:
        raise ValueError("real must be a boolean")
    digest = _require_digest(expected_dataset_sha256)
    argv = [
        sys.executable,
        "-m",
        "recoverable_agent_service.eval_process",
        "--dataset",
        str(Path(dataset_path).resolve()),
        "--case",
        case_id,
        "--root",
        str(Path(root).resolve()),
        "--dataset-sha256",
        digest,
    ]
    if real:
        argv.append("--real")
    return validate_observation(_run_owned(argv, timeout_seconds))


class _SafeParser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        raise ValueError("invalid evaluation child arguments")


def main(argv: list[str] | None = None) -> int:
    """Child entrypoint: emit one observation or a safe error type, then exit."""

    try:
        parser = _SafeParser(description=__doc__)
        parser.add_argument("--dataset", required=True, type=Path)
        parser.add_argument("--case", required=True)
        parser.add_argument("--root", required=True, type=Path)
        parser.add_argument("--dataset-sha256", required=True)
        parser.add_argument("--real", action="store_true")
        args = parser.parse_args(argv)
        with contextlib.redirect_stdout(sys.stderr):
            dataset = load_dataset(args.dataset)
            if dataset_digest(dataset) != _require_digest(args.dataset_sha256):
                raise ValueError("evaluation dataset changed before child execution")
            case = next((case for case in dataset.cases if case.id == args.case), None)
            if case is None:
                raise ValueError("unknown evaluation case")
            from .eval_scenarios import run_case

            observation = validate_observation(run_case(case, args.root, real=args.real))
        sys.stdout.write(json.dumps(observation, separators=(",", ":")) + "\n")
        return 0
    except Exception as error:
        sys.stdout.write(json.dumps({"error_type": type(error).__name__}) + "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
