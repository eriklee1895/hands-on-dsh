from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "examples" / "evaluate.py"


def invoke(tmp_path, *args):
    environment = dict(os.environ)
    environment.pop("DEEPSEEK_API_KEY", None)
    return subprocess.run(
        [sys.executable, str(SCRIPT), *map(str, args)],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_default_suite_records_and_regrades_the_same_checks_from_foreign_cwd(tmp_path):
    record = tmp_path / "result.json"
    first = invoke(tmp_path, "--record", record)
    assert first.returncode == 0, first.stdout + first.stderr
    report = json.loads(first.stdout)
    assert report["counts"] == {"selected": 5, "passed": 5, "failed": 0, "not_run": 0}
    assert report["execution"] == "controlled-run"
    replay = invoke(tmp_path, "--replay", record)
    assert replay.returncode == 0, replay.stdout + replay.stderr
    regraded = json.loads(replay.stdout)
    assert regraded["execution"] == "record-replay"
    assert regraded["results"] == report["results"]
    assert regraded["counts"] == report["counts"]


def test_negative_control_returns_a_failed_gate_without_overwriting_expectations(tmp_path):
    failed = invoke(tmp_path, "--negative-control")
    assert failed.returncode == 1, failed.stdout + failed.stderr
    report = json.loads(failed.stdout)
    assert report["counts"]["failed"] == 1
    assert report["results"][0]["failed_checks"] == ["runtime_calls"]
    assert report["negative_control"] is True


def test_subset_is_explicit_and_unknown_case_or_missing_real_key_fails(tmp_path):
    selected = invoke(tmp_path, "--case", "success")
    assert selected.returncode == 0, selected.stdout + selected.stderr
    report = json.loads(selected.stdout)
    assert report["selected"] == ["success"]
    assert len(report["not_run"]) == 4
    for args in [("--case", "unknown"), ("--real",), ("--real", "--negative-control")]:
        assert invoke(tmp_path, *args).returncode == 2


def test_cleanup_failure_is_infrastructure_error_not_a_passing_report(
    tmp_path, monkeypatch, capsys
):
    import runpy
    from types import SimpleNamespace

    from recoverable_agent_service.eval_contract import load_dataset

    dataset = load_dataset(SCRIPT.parents[1] / "eval" / "cases.json")
    root = tmp_path / "owned"
    root.mkdir()
    namespace = runpy.run_path(str(SCRIPT), run_name="eval_cli_unit_test")
    fake = SimpleNamespace(run_isolated_case=lambda *args: dict(dataset.cases[0].expected))
    monkeypatch.setitem(sys.modules, "recoverable_agent_service.eval_process", fake)
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--case", "success"])
    monkeypatch.setattr(namespace["tempfile"], "mkdtemp", lambda **kwargs: str(root))
    monkeypatch.setattr(
        namespace["shutil"], "rmtree", lambda path: (_ for _ in ()).throw(OSError("cleanup failed"))
    )
    assert namespace["main"]() == 2
    output = capsys.readouterr()
    report = json.loads(output.out)
    assert "counts" not in report
    assert report["error"] == "Evaluation cleanup failed"
    assert root.exists()
