"""Deterministic SDK JSON-RPC fake server for wire choreography tests."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any

from protocol_labs.jsonl_peer import JsonRpcError, is_valid_jsonrpc_id

ROOT_SESSION = "root"
CHILD_SESSION = "child-1"
FOREIGN_SESSION = "foreign"
_PARAMS_OMITTED = object()


class FakeSdkServer:
    """Continuously dispatch SDK requests while handlers execute independently."""

    def __init__(self) -> None:
        self._write_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task[None]] = set()
        self._held = asyncio.Event()
        self._message_counter = 0
        self._initialized = False

    async def run(self) -> None:
        """Read JSONL stdin until EOF and drain handler tasks."""
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
        while line := await reader.readline():
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(frame, dict):
                continue
            method = frame.get("method")
            if not isinstance(method, str) or not method or "id" not in frame:
                continue
            request_id = frame["id"]
            if not is_valid_jsonrpc_id(request_id):
                continue
            task = asyncio.create_task(
                self._handle_request(
                    request_id,
                    method,
                    frame.get("params", _PARAMS_OMITTED),
                )
            )
            self._track(task)
        for task in tuple(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    async def _handle_request(self, request_id: object, method: str, params: object) -> None:
        try:
            result = await self._dispatch(method, params)
            response = {"jsonrpc": "2.0", "id": request_id, "result": result}
        except asyncio.CancelledError:
            raise
        except JsonRpcError as error:
            response = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": error.code,
                    "message": error.message,
                    "data": error.data,
                },
            }
        except Exception as error:
            response = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32603, "message": str(error)},
            }
        await self._write_json(response)

    async def _dispatch(self, method: str, params: object) -> object:
        if method == "initialize":
            self._validate_initialize(params)
            self._initialized = True
            return {
                "serverInfo": {
                    "name": "dsh-sdk-jsonrpc-lab-fake",
                    "version": "0.0.1",
                },
            }
        if method == "session/prompt":
            if not self._initialized:
                raise RuntimeError("initialize must run before session/prompt")
            session_id, prompt, content_blocks = self._validate_prompt(params)
            if prompt == "lab:timeout":
                await self._held.wait()
                return {"messageId": "unreachable"}
            if prompt == "lab:internal-error":
                raise RuntimeError("fake internal failure")
            if prompt == "lab:close":
                os.write(2, b"fake requested close")
                os._exit(23)
            if prompt == "lab:malformed":
                await self._write_raw(b"{not-json\n")
            self._message_counter += 1
            message_id = f"message-{self._message_counter}"
            await self._notify("session.status", {"sessionId": session_id, "status": "idle"})
            await self._session_event(
                session_id,
                0,
                "agent/inbox/spliced",
                {
                    "target": "next-turn",
                    "start": 0,
                    "inserted": [
                        {
                            "id": "stale-message",
                            "role": "user",
                            "content": [{"type": "text", "text": "stale prompt"}],
                            "source": {"kind": "user"},
                        }
                    ],
                },
            )
            await self._notify(
                "subagent.started",
                {"parentSessionId": session_id, "childSessionId": "stale-child"},
            )
            await self._notify("session.status", {"sessionId": "stale-child", "status": "running"})
            await self._notify(
                "subagent.finished",
                {
                    "provider": "fake",
                    "agentId": "stale-child",
                    "parentSessionId": session_id,
                    "childSessionId": "stale-child",
                    "status": "ok",
                    "stopReason": "completed",
                    "lastAssistantMessage": [{"type": "text", "text": "stale child answer"}],
                },
            )
            await self._session_event(session_id, 1, "turn/start", {"turn": 1})
            await self._session_event(
                session_id,
                2,
                "agent/inbox/spliced",
                {
                    "target": "next-turn",
                    "start": 0,
                    "removedCount": 1,
                    "inserted": [],
                },
            )
            await self._session_event(session_id, 3, "step/start", {"turn": 1, "step": 1})
            await self._session_event(
                session_id,
                4,
                "user/message",
                {
                    "id": "stale-message",
                    "role": "user",
                    "content": [{"type": "text", "text": "stale prompt"}],
                    "source": {"kind": "user"},
                },
                surface_op="append",
            )
            await self._session_event(
                session_id,
                5,
                "assistant/chunk",
                {
                    "turn": 1,
                    "step": 1,
                    "chunk": {
                        "type": "text-delta",
                        "index": 0,
                        "text": "stale raw answer",
                    },
                },
            )
            await self._session_event(
                session_id,
                6,
                "assistant/message",
                {
                    "turn": 1,
                    "step": 1,
                    "message": {
                        "id": "stale-assistant",
                        "role": "assistant",
                        "content": [{"type": "text", "text": "stale answer"}],
                        "source": {
                            "kind": "model",
                            "provider": "fake",
                            "model": "fake",
                        },
                    },
                },
                surface_op="append",
                source_event_seqs=[5],
            )
            await self._session_event(session_id, 7, "step/end", {"turn": 1, "step": 1})
            await self._session_event(
                session_id,
                8,
                "turn/end",
                {"turn": 1, "reason": {"kind": "completed"}},
            )
            await self._session_event(
                session_id,
                9,
                "agent/inbox/spliced",
                {
                    "target": "next-turn",
                    "start": 0,
                    "inserted": [
                        {
                            "id": message_id,
                            "role": "user",
                            "content": content_blocks,
                            "source": {"kind": "user"},
                        }
                    ],
                },
            )
            continuation = asyncio.create_task(
                self._continue_fixture(session_id, prompt, message_id, content_blocks)
            )
            self._track(continuation)
            return {"messageId": message_id}
        if method == "shutdown":
            if params is not _PARAMS_OMITTED:
                raise RuntimeError("shutdown params must be omitted")
            return {}
        raise RuntimeError(f"unknown SDK method: {method}")

    @staticmethod
    def _validate_initialize(params: object) -> None:
        if not isinstance(params, dict):
            raise RuntimeError("initialize params must be an object")
        allowed = {"cwd", "provider", "model", "maxTokens"}
        if set(params) - allowed or not {"cwd", "provider", "model"} <= set(params):
            raise RuntimeError("initialize params have incorrect fields")
        cwd = params["cwd"]
        if not isinstance(cwd, str) or not os.path.isabs(cwd):
            raise RuntimeError("initialize cwd must be absolute")
        for key in ("provider", "model"):
            if not isinstance(params[key], str) or not params[key]:
                raise RuntimeError(f"initialize {key} must be a non-empty string")
        max_tokens = params.get("maxTokens")
        if max_tokens is not None and (
            isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or max_tokens <= 0
        ):
            raise RuntimeError("initialize maxTokens must be a positive integer")

    @staticmethod
    def _validate_prompt(
        params: object,
    ) -> tuple[str, str, list[dict[str, str]]]:
        if not isinstance(params, dict) or set(params) != {"sessionId", "contentBlocks"}:
            raise RuntimeError("session/prompt params have incorrect fields")
        session_id = params["sessionId"]
        blocks = params["contentBlocks"]
        if not isinstance(session_id, str) or not session_id:
            raise RuntimeError("sessionId must be a non-empty string")
        if not isinstance(blocks, list) or not blocks:
            raise RuntimeError("contentBlocks must be non-empty")
        texts: list[str] = []
        for block in blocks:
            if (
                not isinstance(block, dict)
                or set(block) != {"type", "text"}
                or block["type"] != "text"
                or not isinstance(block["text"], str)
            ):
                raise RuntimeError("contentBlocks must contain exact text blocks")
            texts.append(block["text"])
        return session_id, "".join(texts), [dict(block) for block in blocks]

    async def _continue_fixture(
        self,
        session_id: str,
        prompt: str,
        message_id: str,
        content_blocks: list[dict[str, str]],
    ) -> None:
        await asyncio.sleep(0.01)
        if prompt == "lab:continuation-error":
            raise RuntimeError("scripted continuation failure")
        await self._notify("session.status", {"sessionId": session_id, "status": "running"})
        await self._session_event(session_id, 10, "turn/start", {"turn": 2})
        await self._session_event(
            session_id,
            11,
            "agent/inbox/spliced",
            {
                "target": "next-turn",
                "start": 0,
                "removedCount": 1,
                "inserted": [],
            },
        )
        await self._session_event(session_id, 12, "step/start", {"turn": 2, "step": 1})
        await self._session_event(
            session_id,
            13,
            "user/message",
            {
                "id": message_id,
                "role": "user",
                "content": content_blocks,
                "source": {"kind": "user"},
            },
            surface_op="append",
        )
        await self._notify(
            "subagent.started",
            {"parentSessionId": session_id, "childSessionId": CHILD_SESSION},
        )
        await self._notify("session.status", {"sessionId": CHILD_SESSION, "status": "running"})
        await self._session_event(CHILD_SESSION, 0, "turn/start", {"turn": 1})
        await self._session_event(CHILD_SESSION, 1, "step/start", {"turn": 1, "step": 1})
        await self._session_event(
            CHILD_SESSION,
            2,
            "assistant/chunk",
            {
                "turn": 1,
                "step": 1,
                "chunk": {
                    "type": "text-delta",
                    "index": 0,
                    "text": "child answer",
                },
            },
        )
        await self._session_event(
            CHILD_SESSION,
            3,
            "assistant/message",
            {
                "turn": 1,
                "step": 1,
                "message": {
                    "id": "child-assistant-1",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "child answer"}],
                    "source": {
                        "kind": "model",
                        "provider": "fake",
                        "model": "fake",
                    },
                },
            },
            surface_op="append",
            source_event_seqs=[2],
        )
        await self._session_event(CHILD_SESSION, 4, "step/end", {"turn": 1, "step": 1})
        await self._session_event(
            CHILD_SESSION,
            5,
            "turn/end",
            {"turn": 1, "reason": {"kind": "completed"}},
        )
        await self._notify("session.status", {"sessionId": CHILD_SESSION, "status": "idle"})
        await self._notify(
            "subagent.finished",
            {
                "provider": "fake",
                "agentId": CHILD_SESSION,
                "parentSessionId": session_id,
                "childSessionId": CHILD_SESSION,
                "status": "ok",
                "stopReason": "completed",
                "lastAssistantMessage": [{"type": "text", "text": "child answer"}],
            },
        )
        await self._notify("session.status", {"sessionId": FOREIGN_SESSION, "status": "running"})
        await self._session_event(
            session_id,
            14,
            "assistant/chunk",
            {
                "turn": 2,
                "step": 1,
                "chunk": {
                    "type": "text-delta",
                    "index": 0,
                    "text": "raw fixture answer",
                },
            },
        )
        await self._session_event(
            session_id,
            15,
            "assistant/message",
            {
                "turn": 2,
                "step": 1,
                "message": {
                    "id": "assistant-1",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "fixture answer"}],
                    "source": {
                        "kind": "model",
                        "provider": "fake",
                        "model": "fake",
                    },
                },
            },
            surface_op="append",
            source_event_seqs=[14],
        )
        await self._session_event(session_id, 16, "step/end", {"turn": 2, "step": 1})
        await self._session_event(
            session_id,
            17,
            "turn/end",
            {"turn": 2, "reason": {"kind": "completed"}},
        )
        await self._notify("session.status", {"sessionId": session_id, "status": "idle"})

    async def _session_event(
        self,
        session_id: str,
        seq: int,
        event_type: str,
        data: dict[str, object],
        *,
        surface_op: str | None = None,
        source_event_seqs: list[int] | None = None,
    ) -> None:
        event: dict[str, object] = {
            "type": event_type,
            "seq": seq,
            "time": 0,
            "data": data,
        }
        if surface_op is not None:
            event["surfaceOp"] = surface_op
        if source_event_seqs is not None:
            event["sourceEventSeqs"] = source_event_seqs
        await self._notify(
            "session.event",
            {
                "sessionId": session_id,
                "event": event,
            },
        )

    async def _notify(self, method: str, params: object) -> None:
        await self._write_json({"jsonrpc": "2.0", "method": method, "params": params})

    async def _write_json(self, frame: dict[str, Any]) -> None:
        payload = json.dumps(frame, separators=(",", ":")).encode() + b"\n"
        await self._write_raw(payload)

    async def _write_raw(self, payload: bytes) -> None:
        async with self._write_lock:
            remaining = memoryview(payload)
            while remaining:
                written = os.write(1, remaining)
                remaining = remaining[written:]

    def _track(self, task: asyncio.Task[None]) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._task_finished)

    def _task_finished(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            os.write(2, f"fake continuation task failed: {error}\n".encode())


def main() -> None:
    """Run the fake SDK server on process stdio."""
    asyncio.run(FakeSdkServer().run())


if __name__ == "__main__":
    main()
