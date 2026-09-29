"""Command-line entry point for the SDK JSON-RPC raw-wire protocol lab."""

from __future__ import annotations

import argparse
import asyncio
import json
import os

from protocol_labs.launch import resolve_launch
from protocol_labs.live import build_live_child_env, process_group_exists
from protocol_labs.owned_state import OwnedState
from protocol_labs.sdk_jsonrpc.probe import SdkProbe

GENERIC_PROMPT = "Do not use tools. Reply with one short sentence confirming the protocol is live."


async def _run(server: str) -> dict[str, object]:
    state = OwnedState.create(prefix="sdk-jsonrpc-live-", owner_ids={"sdk"})
    try:
        workspace = state.root / "workspace"
        launch = resolve_launch(
            server,
            protocol="sdk",
            isolated_cwd=workspace if server == "package" else None,
        )
        child_env = (
            build_live_child_env(
                os.environ, home=state.root / "home", dsh_home=state.root / "dsh-home"
            )
            if server == "package"
            else None
        )
        probe = await SdkProbe.start(
            launch,
            cwd=workspace,
            provider="deepseek" if server == "fake" else "deepseek-official",
            model="deepseek-chat" if server == "fake" else "deepseek-flash",
            child_env=child_env,
            startup_timeout=1 if server == "fake" else 120,
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
            state.confirm_closed("sdk", close_outcome, group_absent=reaped_after_close)
        semantic_success = (
            bool(evidence.get("committedAnswer"))
            and evidence.get("receiptMatched") is True
            and evidence.get("completedTurnObserved") is True
            and evidence.get("settlement") == "receipt-to-root-idle"
        )
        close_success = (
            close_outcome.shutdown_request_succeeded is True
            and close_outcome.returncode == 0
            and close_outcome.escalation_signal is None
            and close_outcome.group_gone
            and reaped_after_close
        )
        live_acceptance = server == "package" and semantic_success and close_success
        if server == "package" and not live_acceptance:
            raise RuntimeError("SDK package probe did not satisfy live acceptance")
        diagnostics = list(evidence.get("diagnostics", []))
        for diagnostic in close_outcome.diagnostics:
            if diagnostic not in diagnostics:
                diagnostics.append(dict(diagnostic))
        return {
            "mode": launch.mode,
            "versionEvidence": launch.version_evidence,
            "packageEvidence": launch.package_evidence,
            "serverInfo": probe.server_info,
            "processGroup": {
                "runningDuringProbe": running_during_probe,
                "reapedAfterClose": reaped_after_close,
            },
            **evidence,
            "diagnostics": diagnostics,
            "closeOutcome": close_outcome.to_evidence(),
            "liveAcceptance": live_acceptance if server == "package" else None,
        }
    finally:
        state.cleanup_if_confirmed()


def main() -> None:
    """Run one sanitized SDK fake, published-package, or command probe."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", choices=("fake", "package", "command"), default="fake")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(_run(args.server)), ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
