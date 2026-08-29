"""Reuse one runtime process and one durable DSH session."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from deepseek_harness import DeepSeekHarness


def main() -> None:
    """Run two turns through the same runtime and session."""
    parser = argparse.ArgumentParser(description="Reuse one runtime and session for two turns.")
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--session-id", default="python-demo-reuse")
    parser.add_argument("--session-root", type=Path, default=Path(".dsh-python-demo-sessions"))
    args = parser.parse_args()

    with DeepSeekHarness(
        provider=args.provider,
        model=args.model,
        session_root=str(args.session_root.resolve()),
    ) as harness:
        session = harness.start_session(args.session_id)
        first = session.run("Remember the code word SAFFRON. Reply only with: stored")
        second = session.run("What code word did I ask you to remember? Reply with only that word.")

    print(f"session_id: {session.id}")
    print(f"turn_1: {first.final_response}")
    print(f"turn_2: {second.final_response}")
    print(f"turn_2_finish_reason: {second.finish_reason}")


if __name__ == "__main__":
    main()
