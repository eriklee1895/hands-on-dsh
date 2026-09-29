"""Reuse one runtime process and one durable DSH session."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from deepseek_harness import DeepSeekHarness

from demo_resources import DemoResources


def main() -> None:
    """Run two turns through the same runtime and session."""
    parser = argparse.ArgumentParser(description="Reuse one runtime and session for two turns.")
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--session-id", default="python-demo-reuse")
    parser.add_argument("--dsh-home", type=Path)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--profile", default="sdk-minimal")
    parser.add_argument("--patch", type=Path, action="append", default=[])
    args = parser.parse_args()

    with DemoResources("dsh-python-reuse") as resources:
        root = resources.root
        workspace = (args.workspace or root / "workspace").resolve()
        workspace.mkdir(parents=True, exist_ok=True)
        home = (args.dsh_home or root / "home").resolve()
        with resources.own(
            DeepSeekHarness(
                provider=args.provider,
                model=args.model,
                cwd=str(workspace),
                dsh_home=str(home),
                profile=args.profile,
                patches=tuple(str(patch.resolve()) for patch in args.patch),
            )
        ) as harness:
            session = harness.start_session(args.session_id)
            first = session.run("Remember the code word SAFFRON. Reply only with: stored")
            second = session.run(
                "What code word did I ask you to remember? Reply with only that word."
            )

    if (
        first.finish_reason != "completed"
        or second.finish_reason != "completed"
        or first.final_response.strip() != "stored"
        or second.final_response.strip() != "SAFFRON"
    ):
        raise RuntimeError("session reuse did not produce the expected two completed answers")

    print(f"session_id: {session.id}")
    print(f"turn_1: {first.final_response}")
    print(f"turn_2: {second.final_response}")
    print(f"turn_2_finish_reason: {second.finish_reason}")


if __name__ == "__main__":
    main()
