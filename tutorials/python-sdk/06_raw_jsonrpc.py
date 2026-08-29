"""Drive the bundled DSH runtime with hand-written stdio JSON-RPC."""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import threading
from pathlib import Path
from typing import Any

from deepseek_harness_runtime import bundled_default_config_path, resolve_bundled_launch_args


def encode_request(request_id: int, method: str, params: dict[str, Any] | None = None) -> bytes:
    """Encode one compact newline-delimited JSON-RPC request."""
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        message["params"] = params
    return (json.dumps(message, separators=(",", ":")) + "\n").encode()


def inbox_message_ids(message: dict[str, Any]) -> set[str]:
    """Return message IDs inserted by one raw session event frame."""
    if message.get("method") != "session.event":
        return set()
    params = message.get("params")
    event = params.get("event") if isinstance(params, dict) else None
    if not isinstance(event, dict) or event.get("type") != "agent/inbox/spliced":
        return set()
    data = event.get("data")
    inserted = data.get("inserted") if isinstance(data, dict) else None
    if not isinstance(inserted, list):
        return set()
    return {
        item["id"]
        for item in inserted
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }


def main() -> None:
    """Spawn the bundled runtime and manually correlate one prompt with notifications."""
    parser = argparse.ArgumentParser(
        description="Drive the bundled runtime without the SDK client."
    )
    parser.add_argument("prompt", nargs="?", default="Reply with exactly: raw json rpc ok")
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--session-id", default="python-demo-raw-jsonrpc")
    parser.add_argument("--session-root", type=Path, default=Path(".dsh-python-demo-sessions"))
    parser.add_argument("--timeout", type=float, default=120.0)
    args = parser.parse_args()

    cwd = Path.cwd().resolve()
    env = os.environ.copy()
    env.update(
        {
            "DSH_CORDIS_CONFIG": str(bundled_default_config_path()),
            "DSH_CWD": str(cwd),
            "DSH_SESSION_ROOT": str(args.session_root.resolve()),
        }
    )
    process = subprocess.Popen(
        resolve_bundled_launch_args(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        env=env,
    )
    messages: queue.Queue[dict[str, Any] | BaseException] = queue.Queue()
    stderr_lines: list[str] = []

    def read_stdout() -> None:
        assert process.stdout is not None
        try:
            for line in process.stdout:
                value = json.loads(line)
                if isinstance(value, dict):
                    messages.put(value)
        except BaseException as exc:
            messages.put(exc)

    def read_stderr() -> None:
        assert process.stderr is not None
        for line in process.stderr:
            stderr_lines.append(line.decode(errors="replace").rstrip())

    threading.Thread(target=read_stdout, name="dsh-raw-stdout", daemon=True).start()
    threading.Thread(target=read_stderr, name="dsh-raw-stderr", daemon=True).start()

    def send(request_id: int, method: str, params: dict[str, Any] | None = None) -> None:
        assert process.stdin is not None
        process.stdin.write(encode_request(request_id, method, params))
        process.stdin.flush()

    def next_message() -> dict[str, Any]:
        try:
            item = messages.get(timeout=args.timeout)
        except queue.Empty as exc:
            diagnostics = "\n".join(stderr_lines[-20:])
            raise TimeoutError(f"runtime response timed out\n{diagnostics}") from exc
        if isinstance(item, BaseException):
            raise item
        return item

    try:
        send(
            1,
            "initialize",
            {
                "cwd": str(cwd),
                "provider": args.provider,
                "model": args.model,
            },
        )
        while True:
            message = next_message()
            if message.get("id") == 1:
                if "error" in message:
                    raise RuntimeError(message["error"])
                print(f"initialized: {message.get('result')}")
                break

        send(
            2,
            "session/prompt",
            {
                "sessionId": args.session_id,
                "contentBlocks": [{"type": "text", "text": args.prompt}],
            },
        )
        prompt_message_id: str | None = None
        received_message_ids: set[str] = set()
        print("stream:")
        while True:
            message = next_message()
            if message.get("id") == 2:
                if "error" in message:
                    raise RuntimeError(message["error"])
                result = message.get("result")
                candidate = result.get("messageId") if isinstance(result, dict) else None
                if not isinstance(candidate, str):
                    raise RuntimeError("session/prompt response has no string messageId")
                prompt_message_id = candidate
                print(f"message_id: {prompt_message_id}")
                continue
            received_message_ids.update(inbox_message_ids(message))
            if message.get("method") == "session.event":
                params = message.get("params")
                event = params.get("event") if isinstance(params, dict) else None
                data = event.get("data") if isinstance(event, dict) else None
                chunk = data.get("chunk") if isinstance(data, dict) else None
                if (
                    isinstance(params, dict)
                    and params.get("sessionId") == args.session_id
                    and isinstance(chunk, dict)
                    and chunk.get("type") == "text-delta"
                ):
                    print(str(chunk.get("text", "")), end="", flush=True)
            if message.get("method") == "session.status":
                params = message.get("params")
                if (
                    prompt_message_id in received_message_ids
                    and isinstance(params, dict)
                    and params.get("sessionId") == args.session_id
                    and params.get("status") == "idle"
                ):
                    print()
                    break

        send(3, "shutdown")
        while next_message().get("id") != 3:
            pass
        if process.stdin is not None:
            process.stdin.close()
        process.wait(timeout=5)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
