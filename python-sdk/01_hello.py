"""Run the smallest useful DeepSeek Harness Python SDK example."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from deepseek_harness import DeepSeekHarness


def main() -> None:
    """Run one prompt and print the interval result."""
    parser = argparse.ArgumentParser(
        description="Run one prompt through the high-level Python SDK."
    )
    parser.add_argument("prompt", nargs="?", default="Reply with exactly: hello from dsh")
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--max-tokens", type=int)
    parser.add_argument("--session-root", type=Path, default=Path(".dsh-python-demo-sessions"))
    args = parser.parse_args()

    with DeepSeekHarness(
        provider=args.provider,
        model=args.model,
        max_tokens=args.max_tokens,
        session_root=str(args.session_root.resolve()),
    ) as harness:
        result = harness.run(args.prompt)

    print(f"session_id: {result.session_id}")
    print(f"finish_reason: {result.finish_reason}")
    print("response:")
    print(result.final_response)


if __name__ == "__main__":
    main()
