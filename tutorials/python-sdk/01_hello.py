"""Run the smallest useful DeepSeek Harness Python SDK example."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from deepseek_harness import DeepSeekHarness

from demo_resources import DemoResources


def main() -> None:
    """Run one prompt and print the interval result."""
    parser = argparse.ArgumentParser(
        description="Run one prompt through the high-level Python SDK."
    )
    parser.add_argument("prompt", nargs="?", default="Reply with exactly: hello from dsh")
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--max-tokens", type=int)
    parser.add_argument("--dsh-home", type=Path)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--profile", default="sdk-minimal")
    parser.add_argument("--patch", type=Path, action="append", default=[])
    args = parser.parse_args()

    with DemoResources("dsh-python-hello") as resources:
        root = resources.root
        workspace = (args.workspace or root / "workspace").resolve()
        workspace.mkdir(parents=True, exist_ok=True)
        home = (args.dsh_home or root / "home").resolve()
        with resources.own(
            DeepSeekHarness(
                provider=args.provider,
                model=args.model,
                max_tokens=args.max_tokens,
                cwd=str(workspace),
                dsh_home=str(home),
                profile=args.profile,
                patches=tuple(str(patch.resolve()) for patch in args.patch),
            )
        ) as harness:
            result = harness.run(args.prompt)

    if result.finish_reason != "completed":
        raise RuntimeError(f"agent did not complete: {result.finish_reason}")

    print(f"session_id: {result.session_id}")
    print(f"finish_reason: {result.finish_reason}")
    print("response:")
    print(result.final_response)


if __name__ == "__main__":
    main()
