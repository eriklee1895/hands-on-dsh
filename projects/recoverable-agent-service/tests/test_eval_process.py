"""Case subprocess deadlines and owned POSIX process-group cleanup."""

from __future__ import annotations

import json
import math
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

DATASET_PATH = Path(__file__).resolve().parents[1] / "eval" / "cases.json"


def _group_gone(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return True
    return False


def test_isolated_case_executes_service_and_returns_typed_observation(tmp_path: Path) -> None:
    from recoverable_agent_service.eval_contract import load_dataset
    from recoverable_agent_service.eval_process import run_isolated_case
    from recoverable_agent_service.eval_records import dataset_digest

    observation = run_isolated_case(
        DATASET_PATH,
        "success",
        tmp_path / "case",
        real=False,
        timeout_seconds=15,
        expected_dataset_sha256=dataset_digest(load_dataset(DATASET_PATH)),
    )
    assert observation["state"] == "succeeded"
    assert observation["runtime_finish"] == "completed"
    assert observation["artifact_bytes"] == 21
    assert observation["cleanup_confirmed"] is True
    assert (tmp_path / "case" / "service.db").is_file()


def test_isolated_case_refuses_dataset_changed_after_parent_selection(tmp_path: Path) -> None:
    from recoverable_agent_service.eval_contract import load_dataset
    from recoverable_agent_service.eval_process import run_isolated_case
    from recoverable_agent_service.eval_records import dataset_digest

    copied = tmp_path / "cases.json"
    copied.write_bytes(DATASET_PATH.read_bytes())
    expected_digest = dataset_digest(load_dataset(copied))
    changed = json.loads(copied.read_text(encoding="utf-8"))
    changed["cases"][0]["input"]["prompt"] = "A different public prompt"
    copied.write_text(json.dumps(changed), encoding="utf-8")
    root = tmp_path / "unstarted"

    with pytest.raises(RuntimeError):
        run_isolated_case(
            copied,
            "success",
            root,
            real=False,
            timeout_seconds=5,
            expected_dataset_sha256=expected_digest,
        )
    assert not root.exists()


@pytest.mark.parametrize("digest", ["", "0" * 63, "G" * 64, "A" * 64])
def test_isolated_case_refuses_invalid_parent_digest_without_starting(
    tmp_path: Path, digest: str
) -> None:
    from recoverable_agent_service.eval_process import run_isolated_case

    root = tmp_path / "unstarted"
    with pytest.raises(ValueError, match="digest"):
        run_isolated_case(DATASET_PATH, "success", root, False, 5, digest)
    assert not root.exists()


def test_owned_runner_times_out_and_kills_term_ignoring_group(tmp_path: Path) -> None:
    from recoverable_agent_service.eval_process import _run_owned

    marker = tmp_path / "pgid"
    script = (
        "import os,time,pathlib,signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        f"pathlib.Path({str(marker)!r}).write_text(str(os.getpgrp())); "
        "time.sleep(30)"
    )
    started = time.monotonic()
    with pytest.raises(TimeoutError):
        _run_owned([sys.executable, "-c", script], 0.25)
    assert time.monotonic() - started < 3
    assert _group_gone(int(marker.read_text()))


def test_owned_runner_reaps_orphan_group_and_rejects_leader_success(tmp_path: Path) -> None:
    from recoverable_agent_service.eval_process import _run_owned

    marker = tmp_path / "pgid"
    script = (
        "import os,pathlib,subprocess,sys; "
        "subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']); "
        f"pathlib.Path({str(marker)!r}).write_text(str(os.getpgrp()))"
    )
    with pytest.raises(RuntimeError, match="group"):
        _run_owned([sys.executable, "-c", script], 2)
    assert _group_gone(int(marker.read_text()))


def test_owned_runner_reaps_group_when_waiter_is_interrupted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from recoverable_agent_service.eval_process import _run_owned

    marker = tmp_path / "pgid"
    script = (
        "import os,time,pathlib; "
        f"pathlib.Path({str(marker)!r}).write_text(str(os.getpgrp())); "
        "time.sleep(30)"
    )
    original_wait = subprocess.Popen.wait
    interrupted = False

    def interrupt_once(process: subprocess.Popen, timeout: float | None = None) -> int:
        nonlocal interrupted
        if not interrupted:
            deadline = time.monotonic() + 2
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            interrupted = True
            raise KeyboardInterrupt
        return original_wait(process, timeout=timeout)

    monkeypatch.setattr(subprocess.Popen, "wait", interrupt_once)
    try:
        with pytest.raises(KeyboardInterrupt):
            _run_owned([sys.executable, "-c", script], 3)
        assert _group_gone(int(marker.read_text()))
    finally:
        if marker.exists() and not _group_gone(int(marker.read_text())):
            os.killpg(int(marker.read_text()), signal.SIGKILL)


@pytest.mark.parametrize("output", ["", "not-json", "[]", '{"error_type":"RuntimeError"}'])
def test_owned_runner_rejects_missing_or_invalid_result(output: str) -> None:
    from recoverable_agent_service.eval_process import _run_owned

    script = f"import sys;sys.stdout.write({output!r})"
    with pytest.raises(RuntimeError):
        _run_owned([sys.executable, "-c", script], 2)


@pytest.mark.parametrize("timeout", [0, -1, True, math.inf, math.nan, 3601])
def test_owned_runner_refuses_invalid_deadline(timeout: object) -> None:
    from recoverable_agent_service.eval_process import _run_owned

    with pytest.raises(ValueError, match="timeout"):
        _run_owned([sys.executable, "-c", "pass"], timeout)


def test_child_reports_only_safe_error_type_for_bad_case(tmp_path: Path) -> None:
    from recoverable_agent_service.eval_contract import load_dataset
    from recoverable_agent_service.eval_records import dataset_digest

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "recoverable_agent_service.eval_process",
            "--dataset",
            str(DATASET_PATH),
            "--case",
            "not-a-case",
            "--root",
            str(tmp_path),
            "--dataset-sha256",
            dataset_digest(load_dataset(DATASET_PATH)),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=5,
    )
    assert result.returncode == 2
    assert json.loads(result.stdout) == {"error_type": "ValueError"}
    assert "not-a-case" not in result.stdout
