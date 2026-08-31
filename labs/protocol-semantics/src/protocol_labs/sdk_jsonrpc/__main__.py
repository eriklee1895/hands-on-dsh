"""Command-line entry point for the SDK JSON-RPC protocol lab."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import tempfile
from pathlib import Path

from protocol_labs.launch import resolve_launch
from protocol_labs.live import build_live_child_env, process_group_exists
from protocol_labs.sdk_jsonrpc.probe import SdkProbe

GENERIC_PROMPT = "Do not use tools. Reply with one short sentence confirming the protocol is live."


async def _run(server: str, *, allow_version_mismatch: bool = False) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="sdk-jsonrpc-live-") as temporary:
        root = Path(temporary)
        workspace = root / "workspace"
        isolated_cwd = root / "server-cwd"
        session_root = root / "sdk-sessions"
        snapshot_sessions_root = root / "acp-sessions"
        home = root / "home"
        dsh_home = root / "dsh-home"
        for path in (
            workspace,
            isolated_cwd,
            session_root,
            snapshot_sessions_root,
            home,
            dsh_home,
        ):
            path.mkdir()
        launch = resolve_launch(
            server,
            protocol="sdk",
            isolated_cwd=isolated_cwd if server == "source" else None,
            allow_version_mismatch=allow_version_mismatch,
        )
        child_env = (
            build_live_child_env(
                os.environ,
                workspace=workspace,
                session_root=session_root,
                snapshot_sessions_root=snapshot_sessions_root,
                home=home,
                dsh_home=dsh_home,
            )
            if server == "source"
            else None
        )
        probe = await SdkProbe.start(
            launch,
            cwd=workspace,
            provider="deepseek" if server == "fake" else "deepseek-official",
            model="deepseek-chat" if server == "fake" else "deepseek-v4-flash",
            child_env=child_env,
            startup_timeout=1 if server == "fake" else 60,
        )
        process_group_id = probe.process_group_id
        running_during_probe = process_group_exists(process_group_id)
        try:
            evidence = await probe.prompt(
                "fixture prompt" if server == "fake" else GENERIC_PROMPT,
                timeout=1 if server == "fake" else 300,
            )
        finally:
            close_outcome = await probe.close()
        reaped_after_close = not process_group_exists(process_group_id)
    semantic_success = (
        bool(evidence.get("committedAnswer"))
        and evidence.get("receiptMatched") is True
        and evidence.get("settlement") == "receipt-to-root-idle"
    )
    close_success = (
        close_outcome.shutdown_request_succeeded is True
        and close_outcome.returncode == 0
        and close_outcome.escalation_signal is None
        and close_outcome.group_gone
        and reaped_after_close
    )
    source_conforming = launch.source_evidence.get("conforming") is True
    live_acceptance = (
        server == "source" and source_conforming and semantic_success and close_success
    )
    if server == "source" and source_conforming and not live_acceptance:
        raise RuntimeError("SDK source probe did not satisfy the live evidence contract")
    diagnostics = list(evidence.get("diagnostics", []))
    for diagnostic in close_outcome.diagnostics:
        if diagnostic not in diagnostics:
            diagnostics.append(dict(diagnostic))
    return {
        "mode": launch.mode,
        "versionEvidence": launch.version_evidence,
        "sourceEvidence": launch.source_evidence,
        "serverInfo": probe.server_info,
        "processGroup": {
            "runningDuringProbe": running_during_probe,
            "reapedAfterClose": reaped_after_close,
        },
        **evidence,
        "diagnostics": diagnostics,
        "closeOutcome": close_outcome.to_evidence(),
        "liveAcceptance": live_acceptance if server == "source" else None,
    }


def main() -> None:
    """Run one sanitized SDK fake or explicit-command probe."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", choices=("fake", "source", "command"), default="fake")
    parser.add_argument("--allow-version-mismatch", action="store_true")
    args = parser.parse_args()
    if args.allow_version_mismatch and args.server != "source":
        parser.error("--allow-version-mismatch requires --server source")
    print(
        json.dumps(
            asyncio.run(_run(args.server, allow_version_mismatch=args.allow_version_mismatch)),
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
