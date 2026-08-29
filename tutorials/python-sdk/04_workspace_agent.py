"""Run DSH tools against a disposable or caller-selected workspace."""

from __future__ import annotations

import argparse
import os
import tempfile
from contextlib import nullcontext
from pathlib import Path

from deepseek_harness import DeepSeekHarness


def main() -> None:
    """Ask the agent to transform a file and inspect the external result."""
    parser = argparse.ArgumentParser(description="Run an agent against an isolated workspace.")
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    args = parser.parse_args()

    workspace_context = (
        nullcontext(args.workspace.resolve())
        if args.workspace is not None
        else tempfile.TemporaryDirectory(prefix="dsh-python-demo-")
    )
    with workspace_context as selected:
        workspace = Path(selected)
        workspace.mkdir(parents=True, exist_ok=True)
        source = workspace / "input.txt"
        output = workspace / "output.txt"
        source.write_text("red\ngreen\nblue\n", encoding="utf-8")

        with DeepSeekHarness(
            provider=args.provider,
            model=args.model,
            cwd=str(workspace),
            session_root=str(workspace / ".dsh-sessions"),
        ) as harness:
            result = harness.run(
                "Read input.txt, sort its lines alphabetically, and write the result to output.txt. "
                "Use your tools, then briefly report what you changed.",
                session_id="python-demo-workspace",
            )

        print(f"workspace: {workspace}")
        print(f"finish_reason: {result.finish_reason}")
        print(f"agent_response: {result.final_response}")
        print("output.txt:")
        print(output.read_text(encoding="utf-8") if output.exists() else "<not created>")


if __name__ == "__main__":
    main()
