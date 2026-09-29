"""Drive the bundled DSH CLI over newline-delimited JSON-RPC."""

from __future__ import annotations

import argparse
import json
import os
import queue
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from deepseek_harness_runtime import resolve_bundled_launch_args

from demo_resources import DemoResources, finite_positive_timeout


def encode_request(request_id: int, method: str, params: dict[str, Any] | None = None) -> bytes:
    """Encode one compact newline-delimited JSON-RPC request."""
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        message["params"] = params
    return (json.dumps(message, separators=(",", ":")) + "\n").encode()


def inbox_message_ids(message: dict[str, Any], session_id: str | None = None) -> set[str]:
    """Return root-session IDs inserted by one durable inbox event."""
    if message.get("method") != "session.event":
        return set()
    params = message.get("params")
    if not isinstance(params, dict) or (
        session_id is not None and params.get("sessionId") != session_id
    ):
        return set()
    event = params.get("event")
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


def committed_text(message: dict[str, Any], session_id: str) -> str | None:
    """Project a committed root-session assistant message."""
    if message.get("method") != "session.event":
        return None
    params = message.get("params")
    if not isinstance(params, dict) or params.get("sessionId") != session_id:
        return None
    event = params.get("event")
    if not isinstance(event, dict) or event.get("type") != "assistant/message":
        return None
    data = event.get("data")
    message_data = data.get("message") if isinstance(data, dict) else None
    content_owner = message_data if isinstance(message_data, dict) else data
    content = content_owner.get("content") if isinstance(content_owner, dict) else None
    if not isinstance(content, list):
        return None
    return "".join(
        str(block.get("text") or "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    )


@dataclass
class PromptProjection:
    """Correlate a prompt response with earlier or later root notifications."""

    session_id: str
    message_id: str | None = None
    sequence: int = 0
    receipts: dict[str, int] = field(default_factory=dict)
    idle_at: list[int] = field(default_factory=list)
    messages: list[tuple[int, str]] = field(default_factory=list)
    turn_reasons: list[tuple[int, str | None]] = field(default_factory=list)

    def observe(self, frame: dict[str, Any]) -> None:
        """Record a frame in wire order, including receipt-before-response traffic."""
        self.sequence += 1
        if frame.get("id") == 2:
            if "error" in frame:
                raise RuntimeError("session/prompt returned a JSON-RPC error")
            result = frame.get("result")
            candidate = result.get("messageId") if isinstance(result, dict) else None
            if not isinstance(candidate, str) or not candidate:
                raise RuntimeError("session/prompt response has no string messageId")
            self.message_id = candidate
        for message_id in inbox_message_ids(frame, self.session_id):
            self.receipts[message_id] = self.sequence
        text = committed_text(frame, self.session_id)
        if text is not None:
            self.messages.append((self.sequence, text))
        if frame.get("method") == "session.event":
            params = frame.get("params")
            event = params.get("event") if isinstance(params, dict) else None
            if (
                isinstance(params, dict)
                and params.get("sessionId") == self.session_id
                and isinstance(event, dict)
                and event.get("type") == "turn/end"
            ):
                data = event.get("data")
                reason = data.get("reason") if isinstance(data, dict) else None
                kind = reason.get("kind") if isinstance(reason, dict) else None
                self.turn_reasons.append((self.sequence, kind if isinstance(kind, str) else None))
        if frame.get("method") == "session.status":
            params = frame.get("params")
            if (
                isinstance(params, dict)
                and params.get("sessionId") == self.session_id
                and params.get("status") == "idle"
            ):
                self.idle_at.append(self.sequence)

    def settled_at(self) -> int | None:
        """Return the first root idle after the selected durable receipt."""
        receipt = self.receipts.get(self.message_id) if self.message_id is not None else None
        if receipt is None:
            return None
        return next((seq for seq in self.idle_at if seq > receipt), None)

    def final_text(self) -> str:
        """Return the last root committed message in the settled interval."""
        receipt = self.receipts.get(self.message_id) if self.message_id is not None else None
        settled = self.settled_at()
        if receipt is None or settled is None:
            return ""
        return next(
            (text for seq, text in reversed(self.messages) if receipt <= seq <= settled), ""
        )

    def verified_final_text(self) -> str:
        """Require a settled, completed turn with committed root text."""
        text = self.final_text()
        receipt = self.receipts.get(self.message_id) if self.message_id is not None else None
        settled = self.settled_at()
        reason = next(
            (
                kind
                for seq, kind in reversed(self.turn_reasons)
                if receipt is not None and settled is not None and receipt <= seq <= settled
            ),
            None,
        )
        if settled is None or reason != "completed" or not text:
            raise RuntimeError(f"agent did not commit a completed response: {reason}")
        return text


def stop_process(process: subprocess.Popen[bytes]) -> None:
    """Reap the owned CLI, signaling its process group on POSIX if still running."""
    if process.poll() is not None:
        return
    if os.name == "posix":
        os.killpg(process.pid, signal.SIGTERM)
    else:
        process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.wait(timeout=3)


def receive_frame(
    frames: queue.Queue[dict[str, Any] | BaseException | None],
    deadline: float,
    exit_code: Callable[[], int | None],
) -> dict[str, Any]:
    """Read one frame before the deadline; fail immediately at EOF."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("runtime did not respond before deadline")
    try:
        item = frames.get(timeout=remaining)
    except queue.Empty as exc:
        raise TimeoutError("runtime did not respond before deadline") from exc
    if item is None:
        raise EOFError(f"runtime closed stdout before completion (exit={exit_code()})")
    if isinstance(item, BaseException):
        raise item
    return item


def main() -> None:
    """Spawn a public profile and correlate its prompt, receipt, and idle frames."""
    parser = argparse.ArgumentParser(
        description="Drive the bundled runtime without the SDK client."
    )
    parser.add_argument("prompt", nargs="?", default="Reply with exactly: raw json rpc ok")
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--session-id", default="python-demo-raw-jsonrpc")
    parser.add_argument("--dsh-home", type=Path)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--profile", default="sdk-minimal")
    parser.add_argument("--patch", type=Path, action="append", default=[])
    parser.add_argument("--initialize-timeout", type=finite_positive_timeout, default=30.0)
    parser.add_argument("--timeout", type=finite_positive_timeout, default=180.0)
    args = parser.parse_args()

    with DemoResources("dsh-python-jsonrpc") as resources:
        root = resources.root
        workspace = (args.workspace or root / "workspace").resolve()
        workspace.mkdir(parents=True, exist_ok=True)
        home = (args.dsh_home or root / "home").resolve()
        env = os.environ.copy()
        env["DSH_HOME"] = str(home)
        command = (
            *resolve_bundled_launch_args(),
            "--profile",
            args.profile,
            *(part for patch in args.patch for part in ("--patch", str(patch.resolve()))),
        )
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=workspace,
            env=env,
            start_new_session=os.name == "posix",
        )
        frames: queue.Queue[dict[str, Any] | BaseException | None] = queue.Queue()

        def read_stdout() -> None:
            assert process.stdout is not None
            try:
                for line in process.stdout:
                    frame = json.loads(line)
                    if not isinstance(frame, dict):
                        raise RuntimeError("JSON-RPC frame is not an object")
                    frames.put(frame)
            except BaseException as exc:
                frames.put(exc)
            finally:
                frames.put(None)

        def drain_stderr() -> None:
            assert process.stderr is not None
            for _ in process.stderr:
                pass

        stdout_reader = threading.Thread(target=read_stdout, name="dsh-jsonrpc-stdout", daemon=True)
        stderr_reader = threading.Thread(
            target=drain_stderr, name="dsh-jsonrpc-stderr", daemon=True
        )
        stdout_reader.start()
        stderr_reader.start()

        def send(request_id: int, method: str, params: dict[str, Any] | None = None) -> None:
            assert process.stdin is not None
            process.stdin.write(encode_request(request_id, method, params))
            process.stdin.flush()

        try:
            send(
                1,
                "initialize",
                {"cwd": str(workspace), "provider": args.provider, "model": args.model},
            )
            init_deadline = time.monotonic() + args.initialize_timeout
            while True:
                frame = receive_frame(frames, init_deadline, process.poll)
                if frame.get("id") == 1:
                    if "error" in frame:
                        raise RuntimeError("initialize returned a JSON-RPC error")
                    break

            send(
                2,
                "session/prompt",
                {
                    "sessionId": args.session_id,
                    "contentBlocks": [{"type": "text", "text": args.prompt}],
                },
            )
            projection = PromptProjection(args.session_id)
            activity_deadline = time.monotonic() + args.timeout
            while projection.settled_at() is None:
                projection.observe(receive_frame(frames, activity_deadline, process.poll))
            final_text = projection.verified_final_text()
            print(f"message_id: {projection.message_id}")
            print(f"committed_response: {final_text}")
            send(3, "shutdown")
            shutdown_deadline = time.monotonic() + 5
            while True:
                frame = receive_frame(frames, shutdown_deadline, process.poll)
                if frame.get("id") == 3:
                    if "error" in frame:
                        raise RuntimeError("shutdown returned a JSON-RPC error")
                    break
            assert process.stdin is not None
            process.stdin.close()
            process.wait(timeout=5)
            if process.returncode != 0:
                raise RuntimeError(f"runtime exited with status {process.returncode}")
        finally:
            stop_process(process)
            stdout_reader.join(timeout=1)
            stderr_reader.join(timeout=1)
            if process.poll() is not None:
                resources.confirm_closed()


if __name__ == "__main__":
    main()
