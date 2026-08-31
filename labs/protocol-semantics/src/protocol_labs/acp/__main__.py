"""Command-line entry point for the ACP raw-wire protocol lab."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import tempfile
from pathlib import Path

from protocol_labs.acp.probe import AcpProbe
from protocol_labs.launch import resolve_launch
from protocol_labs.live import build_live_child_env, process_group_exists

GENERIC_PROMPT = [
    {
        "type": "text",
        "text": "Do not use tools. Reply with one short sentence confirming ACP is live.",
    }
]


async def _run(server: str, *, allow_version_mismatch: bool = False) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="acp-live-") as temporary:
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
            protocol="acp",
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
        probe = await AcpProbe.start(
            launch,
            cwd=workspace,
            child_env=child_env,
            startup_timeout=1 if server == "fake" else 60,
        )
        process_group_id = probe.process_group_id
        running_during_probe = process_group_exists(process_group_id)
        try:
            if server != "fake":
                generic = await probe.prompt(GENERIC_PROMPT, timeout=300)
            else:
                fixture = await probe.prompt([{"type": "text", "text": "fixture prompt"}])
                cancellation = await probe.cancel_prompt()
                permission = await probe.prompt(
                    [{"type": "text", "text": "lab:permission"}], request_id=0
                )
        finally:
            close_outcome = await probe.close()
        reaped_after_close = not process_group_exists(process_group_id)
    common = {
        "mode": launch.mode,
        "versionEvidence": launch.version_evidence,
        "sourceEvidence": launch.source_evidence,
        "agentInfo": probe.agent_info,
        "agentCapabilities": probe.agent_capabilities,
        "authMethods": probe.auth_methods,
        "processGroup": {
            "runningDuringProbe": running_during_probe,
            "reapedAfterClose": reaped_after_close,
        },
        "closeOutcome": close_outcome.to_evidence(),
    }
    if server != "fake":
        semantic_success = (
            bool(generic.get("committedAnswer")) and generic.get("stopReason") == "end_turn"
        )
        source_conforming = launch.source_evidence.get("conforming") is True
        live_acceptance = (
            server == "source"
            and source_conforming
            and semantic_success
            and close_outcome.group_gone
            and reaped_after_close
        )
        if server == "source" and source_conforming and not live_acceptance:
            raise RuntimeError("ACP source probe did not satisfy the live evidence contract")
        diagnostics = list(generic.get("diagnostics", []))
        for diagnostic in close_outcome.diagnostics:
            if diagnostic not in diagnostics:
                diagnostics.append(dict(diagnostic))
        return {
            **common,
            **generic,
            "diagnostics": diagnostics,
            "liveAcceptance": live_acceptance if server == "source" else None,
        }
    diagnostics = list(permission["diagnostics"])
    for diagnostic in close_outcome.diagnostics:
        if diagnostic not in diagnostics:
            diagnostics.append(dict(diagnostic))
    return {
        **common,
        "fixture": fixture,
        "cancellation": cancellation,
        "permission": permission,
        "diagnostics": diagnostics,
        "liveAcceptance": None,
    }


def main() -> None:
    """Run one sanitized ACP fake or explicit-command probe."""
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
