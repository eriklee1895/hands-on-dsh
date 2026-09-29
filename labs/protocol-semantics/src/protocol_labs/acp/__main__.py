"""Command-line entry point for the ACP raw-wire protocol lab."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets

from protocol_labs.acp.probe import AcpProbe
from protocol_labs.launch import resolve_launch
from protocol_labs.live import build_live_child_env, process_group_exists
from protocol_labs.owned_state import OwnedState

GENERIC_PROMPT = [
    {
        "type": "text",
        "text": "Do not use tools. Reply with one short sentence confirming ACP is live.",
    }
]


async def _run(server: str) -> dict[str, object]:
    state = OwnedState.create(
        prefix="acp-live-", owner_ids={"first", "restart"} if server == "package" else {"first"}
    )
    try:
        workspace = state.root / "workspace"
        home = state.root / "home"
        dsh_home = state.root / "dsh-home"
        launch = resolve_launch(
            server,
            protocol="acp",
            isolated_cwd=workspace if server == "package" else None,
        )
        child_env = (
            build_live_child_env(os.environ, home=home, dsh_home=dsh_home)
            if server == "package"
            else None
        )
        probe = await AcpProbe.start(
            launch,
            cwd=workspace,
            child_env=child_env,
            startup_timeout=1 if server == "fake" else 120,
        )
        process_group_id = probe.process_group_id
        running_during_probe = process_group_exists(process_group_id)
        try:
            if server == "fake":
                fixture = await probe.prompt([{"type": "text", "text": "fixture prompt"}])
                cancellation = await probe.cancel_prompt()
                permission = await probe.prompt(
                    [{"type": "text", "text": "lab:permission"}], request_id=0
                )
                await probe.close_session()
                listed = await probe.list_sessions(cwd=workspace)
                resumed_options = await probe.resume_session(workspace)
                selected_options = await probe.select_advertised_model()
            elif server == "package":
                await probe.select_advertised_model()
                nonce = secrets.token_hex(5).upper()
                first_prompt = [
                    {
                        "type": "text",
                        "text": f"Do not use tools. Remember this codeword: {nonce}. Reply only: remembered.",
                    }
                ]
                fixture = await probe.prompt(first_prompt, timeout=300)
                await probe.close_session()
                listed = await probe.list_sessions(cwd=workspace)
                if not any(
                    item.get("sessionId") == probe.session_id
                    for item in listed["sessions"]
                    if isinstance(item, dict)
                ):
                    raise RuntimeError("closed ACP session was absent from session/list")
                resumed_options = []
                selected_options = []
            else:
                fixture = await probe.prompt(GENERIC_PROMPT, timeout=300)
                listed = {"sessions": []}
                resumed_options = []
                selected_options = []
        finally:
            close_outcome = await probe.close()
        reaped_after_close = not process_group_exists(process_group_id)
        state.confirm_closed("first", close_outcome, group_absent=reaped_after_close)

        restart: dict[str, object] | None = None
        if server == "package":
            resumed = await AcpProbe.start(
                launch,
                cwd=workspace,
                child_env=child_env,
                startup_timeout=120,
                resume_session_id=probe.session_id,
            )
            resumed_options = resumed.config_options
            resumed_process_group = resumed.process_group_id
            try:
                replayed = await resumed.historical_replay_count()
                selected_options = await resumed.select_advertised_model()
                second_prompt = [
                    {
                        "type": "text",
                        "text": "Do not use tools. What codeword did I ask you to remember? Reply with only the codeword.",
                    }
                ]
                second = await resumed.prompt(second_prompt, timeout=300)
                await resumed.close_session()
            finally:
                restart_close = await resumed.close()
            second_reaped_after_close = not process_group_exists(resumed_process_group)
            state.confirm_closed("restart", restart_close, group_absent=second_reaped_after_close)
            restart = {
                "resumedSameSession": resumed.session_id == probe.session_id,
                "historicalUpdatesAfterResume": replayed,
                "secondCommittedAnswer": second.get("committedAnswer"),
                "secondStopReason": second.get("stopReason"),
                "secondToolUpdates": second.get("toolUpdates"),
                "nonceRecalled": second.get("committedAnswer", "").strip() == nonce,
                "closeOutcome": restart_close.to_evidence(),
                "processGroupReaped": second_reaped_after_close,
                "cleanClose": (
                    restart_close.returncode == 0
                    and restart_close.escalation_signal is None
                    and restart_close.group_gone
                ),
            }

        common = {
            "mode": launch.mode,
            "versionEvidence": launch.version_evidence,
            "packageEvidence": launch.package_evidence,
            "agentInfo": probe.agent_info,
            "agentCapabilities": probe.agent_capabilities,
            "authMethods": probe.auth_methods,
            "sessionId": probe.session_id,
            "configOptionIds": [
                item.get("id") for item in probe.config_options if isinstance(item, dict)
            ],
            "selectedOptionIds": [
                item.get("id") for item in selected_options if isinstance(item, dict)
            ],
            "lifecycle": {
                "listedAfterClose": any(
                    item.get("sessionId") == probe.session_id
                    for item in listed["sessions"]
                    if isinstance(item, dict)
                ),
                "resumedOptionCount": len(resumed_options),
            },
            "processGroup": {
                "runningDuringProbe": running_during_probe,
                "reapedAfterClose": reaped_after_close,
            },
            "closeOutcome": close_outcome.to_evidence(),
            "diagnostics": list(fixture.get("diagnostics", [])),
        }
        if server == "fake":
            return {
                **common,
                "fixture": fixture,
                "cancellation": cancellation,
                "permission": permission,
                "liveAcceptance": None,
            }
        semantic_success = (
            bool(fixture.get("committedAnswer"))
            and fixture.get("stopReason") == "end_turn"
            and restart is not None
            and restart["resumedSameSession"] is True
            and restart["historicalUpdatesAfterResume"] == 0
            and restart["secondStopReason"] == "end_turn"
            and fixture.get("toolUpdates") == 0
            and restart["secondToolUpdates"] == 0
            and restart["nonceRecalled"] is True
            and restart["processGroupReaped"] is True
            and restart["cleanClose"] is True
            and close_outcome.returncode == 0
            and close_outcome.escalation_signal is None
            and close_outcome.group_gone
        )
        live_acceptance = server == "package" and semantic_success and reaped_after_close
        if server == "package" and not live_acceptance:
            raise RuntimeError(
                "ACP package probe did not satisfy live acceptance: "
                + json.dumps(
                    {
                        "firstAnswer": bool(fixture.get("committedAnswer")),
                        "firstStop": fixture.get("stopReason"),
                        "restart": restart,
                        "firstGroupReaped": reaped_after_close,
                    },
                    sort_keys=True,
                )
            )
        return {
            **common,
            "firstPrompt": fixture,
            "restart": restart,
            "liveAcceptance": live_acceptance if server == "package" else None,
        }

    finally:
        state.cleanup_if_confirmed()


def main() -> None:
    """Run one sanitized ACP fake, published-package, or command probe."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", choices=("fake", "package", "command"), default="fake")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(_run(args.server)), ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
