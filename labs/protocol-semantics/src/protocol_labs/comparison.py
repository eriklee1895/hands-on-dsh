"""Compare narrow adapters without erasing their native completion and capability rules."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from uuid import uuid4

from protocol_labs.adapters import (
    AdapterExecutionError,
    AdapterStateError,
    UnsupportedCapability,
    describe_adapter,
    open_adapter,
)
from protocol_labs.launch import load_versions


def _row(protocol: str, scenario: str, checks: dict[str, bool], closed: dict) -> dict:
    checks = {
        **checks,
        "group_closed": closed.get("group_gone") is True,
        "state_removed": closed.get("state_removed") is True,
    }
    return {
        "protocol": protocol,
        "scenario": scenario,
        "checks": checks,
        "passed": all(checks.values()),
        "closed": closed,
    }


async def _prompt_case(protocol: str, server: str, prompt: str, expected: str) -> dict:
    adapter = await open_adapter(protocol, server)
    try:
        result = await adapter.prompt(prompt)
        checks = {
            "settled_normally": (
                result.status == "completed"
                and result.native.get("receiptMatched") is True
                and result.native.get("completedTurnObserved") is True
                and result.native.get("rootTurnEndReason") == "completed"
            )
            if protocol == "sdk"
            else (result.status == "settled" and result.native.get("stopReason") == "end_turn"),
            "exact_text": result.text == expected,
            "no_tools": result.tool_events == 0,
        }
        evidence = {
            "settlement": result.settlement,
            "native": result.native,
            "answer_sha256": hashlib.sha256((result.text or "").encode()).hexdigest(),
        }
    finally:
        closed = await adapter.close()
    checks["native_clean_exit"] = closed.get("native_clean_exit") is True
    return {**_row(protocol, "prompt", checks, closed), "evidence": evidence}


async def _fault_case(protocol: str, scenario: str, prompt: str, kind: str) -> dict:
    adapter = await open_adapter(protocol, "fake")
    observed = False
    uncertain = False
    reuse_rejected = False
    try:
        try:
            await adapter.prompt(prompt, timeout=0.1 if kind == "timeout" else 5.0)
        except AdapterExecutionError as error:
            observed = error.kind == kind
            uncertain = error.may_have_executed is True
        if observed:
            try:
                await adapter.prompt("fixture prompt")
            except AdapterStateError:
                reuse_rejected = True
    finally:
        closed = await adapter.close()
    return _row(
        protocol,
        scenario,
        {
            "expected_failure": observed,
            "execution_uncertain": uncertain,
            "reuse_rejected": reuse_rejected,
        },
        closed,
    )


async def _extensions() -> list[dict]:
    rows = []
    sdk = await open_adapter("sdk", "fake")
    refusals = {}
    try:
        for feature, operation in (
            ("session-close", sdk.close_session),
            ("resume", sdk.resume),
            ("cancel", sdk.cancel_probe),
        ):
            refused = False
            try:
                await operation()
            except UnsupportedCapability:
                refused = True
            refusals[feature] = refused
    finally:
        sdk_closed = await sdk.close()
    rows.extend(
        _row("sdk", "unsupported-" + feature, {"explicitly_rejected": refused}, sdk_closed)
        for feature, refused in refusals.items()
    )
    acp = await open_adapter("acp", "fake")
    try:
        primed = await acp.prompt("fixture prompt")
        closed_session = await acp.close_session()
        resumed = await acp.resume()
        resume_checks = {
            "prior_committed_text": primed.status == "settled" and primed.text == "fixture answer",
            "same_session": resumed["session_id"] == closed_session["session_id"],
            "no_history_replay": resumed["history_updates"] == 0,
        }
        cancelled = await acp.cancel_probe()
        cancel_checks = {
            "native_cancelled": cancelled.status == "cancelled",
            "not_completed": cancelled.status != "completed",
        }
    finally:
        acp_closed = await acp.close()
    rows.append(_row("acp", "session-resume", resume_checks, acp_closed))
    rows.append(_row("acp", "cancel-fixture", cancel_checks, acp_closed))
    return rows


async def compare(server: str, negative_control: bool = False) -> dict:
    """Run only the selected evidence tier; synthetic fault cases never count as live evidence."""
    if server not in {"fake", "package"}:
        raise ValueError("Unknown comparison mode")
    if negative_control and server != "fake":
        raise ValueError("Negative controls are keyless only")
    expected = "fixture answer" if server == "fake" else "ADAPTER_OK_" + uuid4().hex
    prompt = (
        "fixture prompt" if server == "fake" else "Do not use tools. Reply with exactly " + expected
    )
    rows = []
    for protocol in ("sdk", "acp"):
        rows.append(await _prompt_case(protocol, server, prompt, expected))
        if server == "fake":
            for scenario, trigger, kind in (
                ("timeout", "lab:timeout", "timeout"),
                ("peer-exit", "lab:close", "peer-exited"),
                ("rpc-error", "lab:internal-error", "rpc-error"),
            ):
                rows.append(await _fault_case(protocol, scenario, trigger, kind))
    if server == "fake":
        rows.extend(await _extensions())
    if negative_control:
        rows[0]["checks"]["exact_text"] = False
        rows[0]["passed"] = False
    return {
        "engine": "dsh",
        "protocols": ["sdk", "acp"],
        "evidence": "controlled-peers" if server == "fake" else "published-runtime",
        "release_reference": load_versions()["dsh"],
        "capabilities": [describe_adapter("dsh", protocol) for protocol in ("sdk", "acp")],
        "not_integrated": ["codex", "hermes"],
        "not_run": []
        if server == "fake"
        else [
            "timeout",
            "peer-exit",
            "rpc-error",
            "unsupported-extension-checks",
            "cancel-fixture",
            "session-resume",
        ],
        "negative_control": negative_control,
        "cases": rows,
        "counts": {
            "selected": len(rows),
            "passed": sum(row["passed"] for row in rows),
            "failed": sum(not row["passed"] for row in rows),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", choices=("fake", "package"), default="fake")
    parser.add_argument("--engine", choices=("dsh", "codex", "hermes"), default="dsh")
    parser.add_argument("--negative-control", action="store_true")
    args = parser.parse_args()
    try:
        if args.engine != "dsh":
            print(json.dumps({"engine": args.engine, "integration": "not-integrated"}))
            return 2
        report = asyncio.run(compare(args.server, args.negative_control))
    except Exception as error:
        print(
            json.dumps(
                {
                    "error": "Adapter comparison could not complete",
                    "error_type": type(error).__name__,
                }
            )
        )
        return 2
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    return 1 if report["counts"]["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
