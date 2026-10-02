"""Run DSH tools against a disposable or caller-selected workspace."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from deepseek_harness import DeepSeekHarness

from demo_resources import DemoResources


def main() -> None:
    """Ask the agent to transform a file and inspect the external result."""
    parser = argparse.ArgumentParser(description="Run an agent against an isolated workspace.")
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--dsh-home", type=Path)
    parser.add_argument("--profile", default="sdk")
    parser.add_argument("--patch", type=Path, action="append", default=[])
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    args = parser.parse_args()

    with DemoResources("dsh-python-workspace") as resources:
        root = resources.root
        workspace = (args.workspace or root / "workspace").resolve()
        workspace.mkdir(parents=True, exist_ok=True)
        source = workspace / "input.txt"
        output = workspace / "output.txt"
        if source.exists() or output.exists():
            parser.error("selected workspace already contains input.txt or output.txt")
        source.write_bytes(b"red\ngreen\nblue\n")
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
            result = harness.run(
                "Read input.txt, sort its lines alphabetically, and write the result to output.txt. "
                "Use your tools, then briefly report what you changed.",
                session_id="python-demo-workspace",
            )

        actual = output.read_bytes() if output.exists() else None
        expected = b"blue\ngreen\nred\n"
        if result.finish_reason != "completed" or actual != expected:
            raise RuntimeError(
                f"workspace result failed verification: finish_reason={result.finish_reason}, "
                f"output_bytes={actual!r}"
            )
        print("output_verified: exact bytes")
        print(f"finish_reason: {result.finish_reason}")
        print(f"agent_response: {result.final_response}")
        print("output.txt:")
        print(actual.decode("utf-8"), end="")


if __name__ == "__main__":
    main()
