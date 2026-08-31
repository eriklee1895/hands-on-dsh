"""Deterministic ACP v1 fake agent for wire choreography tests."""

from __future__ import annotations

import asyncio
import json
import math
import os
import sys

from protocol_labs.jsonl_peer import JsonRpcError, is_valid_jsonrpc_id

_PARAMS_OMITTED = object()


class FakeAcpServer:
    """Read ACP frames continuously while request handlers run independently."""

    def __init__(self) -> None:
        self._write_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task[None]] = set()
        self._initialized = False
        self._authenticated = False
        self._session_counter = 0
        self._sessions: set[str] = set()
        self._active_prompts: dict[str, asyncio.Event] = {}
        self._pending_client_requests: dict[int, asyncio.Future[object]] = {}
        self._held = asyncio.Event()

    async def run(self) -> None:
        """Dispatch JSONL input until EOF, then cancel owned handlers."""
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
            if method is None and "id" in frame and ("result" in frame or "error" in frame):
                self._resolve_client_response(frame)
                continue
            if not isinstance(method, str) or not method:
                continue
            if "id" not in frame:
                self._handle_notification(method, frame.get("params", _PARAMS_OMITTED))
                continue
            request_id = frame["id"]
            if not is_valid_jsonrpc_id(request_id):
                continue
            task = asyncio.create_task(
                self._handle_request(request_id, method, frame.get("params", _PARAMS_OMITTED))
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
        await self._write(response)

    async def _dispatch(self, method: str, params: object) -> object:
        if method == "initialize":
            requested_version = params.get("protocolVersion") if isinstance(params, dict) else None
            if (
                not isinstance(params, dict)
                or set(params) != {"protocolVersion", "clientCapabilities"}
                or isinstance(requested_version, bool)
                or not isinstance(requested_version, (int, float))
                or not math.isfinite(requested_version)
                or not float(requested_version).is_integer()
                or params["clientCapabilities"] != {}
            ):
                raise JsonRpcError(-32602, "invalid initialize params")
            self._initialized = True
            return {
                "protocolVersion": 1,
                "agentInfo": {"name": "dsh-acp-lab-fake", "version": "0.0.1"},
                "agentCapabilities": {
                    "promptCapabilities": {
                        "image": False,
                        "audio": False,
                        "embeddedContext": False,
                    }
                },
                "authMethods": [],
            }
        if method == "authenticate":
            if not self._initialized or params != {"methodId": "unused"}:
                raise JsonRpcError(-32602, "invalid authenticate params")
            self._authenticated = True
            return {}
        if method == "session/new":
            if not self._authenticated or not self._valid_new_session(params):
                raise JsonRpcError(-32602, "invalid session/new params")
            self._session_counter += 1
            session_id = f"acp-session-{self._session_counter}"
            self._sessions.add(session_id)
            return {"sessionId": session_id}
        if method == "session/prompt":
            session_id, prompt = self._validate_prompt(params)
            if session_id not in self._sessions:
                raise JsonRpcError(-32602, "unknown session")
            if session_id in self._active_prompts:
                raise JsonRpcError(-32602, "session already has an in-flight prompt")
            cancelled = asyncio.Event()
            self._active_prompts[session_id] = cancelled
            try:
                if prompt == "lab:internal-error":
                    raise RuntimeError("fake internal failure")
                if prompt == "lab:timeout":
                    await self._held.wait()
                    return {"stopReason": "end_turn"}
                if prompt == "lab:close":
                    os.write(2, b"fake requested close")
                    os._exit(23)
                if prompt == "lab:cancel":
                    await self._update(session_id, "ready to cancel")
                    await cancelled.wait()
                    return {"stopReason": "cancelled"}
                if prompt == "lab:permission":
                    permission = await self._request_permission(session_id)
                    if permission == "allowed":
                        chunks = ("fixture ", "answer")
                    elif permission == "denied":
                        chunks = ("permission denied",)
                    else:
                        chunks = ("permission unavailable",)
                    for text in chunks:
                        await self._update(session_id, text)
                    return {"stopReason": "end_turn"}
                if prompt == "lab:malformed":
                    await self._notify(
                        "session/update",
                        {
                            "sessionId": session_id,
                            "update": {"sessionUpdate": "agent_message_chunk"},
                        },
                    )
                for text in ("fixture ", "answer"):
                    await self._update(session_id, text)
                return {"stopReason": "end_turn"}
            finally:
                self._active_prompts.pop(session_id, None)
        raise JsonRpcError(-32601, f"unknown method: {method}")

    async def _request_permission(self, session_id: str) -> str:
        request_id = 0
        waiter = asyncio.get_running_loop().create_future()
        if request_id in self._pending_client_requests:
            raise RuntimeError("permission request ID is already pending")
        self._pending_client_requests[request_id] = waiter
        await self._write(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "session/request_permission",
                "params": {
                    "sessionId": session_id,
                    "toolCall": {"toolCallId": "call-1"},
                    "options": [
                        {
                            "optionId": "allow-once",
                            "name": "Allow once",
                            "kind": "allow_once",
                        },
                        {
                            "optionId": "reject-once",
                            "name": "Reject",
                            "kind": "reject_once",
                        },
                    ],
                },
            }
        )
        try:
            result = await waiter
        except JsonRpcError:
            return "unavailable"
        finally:
            self._pending_client_requests.pop(request_id, None)
        if not isinstance(result, dict) or set(result) != {"outcome"}:
            return "unavailable"
        outcome = result["outcome"]
        if not isinstance(outcome, dict):
            return "unavailable"
        if outcome == {"outcome": "selected", "optionId": "allow-once"}:
            return "allowed"
        if outcome in (
            {"outcome": "selected", "optionId": "reject-once"},
            {"outcome": "cancelled"},
        ):
            return "denied"
        if outcome.get("outcome") == "selected":
            return "denied"
        return "unavailable"

    def _resolve_client_response(self, frame: dict[str, object]) -> None:
        request_id = frame["id"]
        if not is_valid_jsonrpc_id(request_id) or request_id != 0:
            return
        waiter = self._pending_client_requests.get(request_id)
        if waiter is None or waiter.done():
            return
        error = frame.get("error")
        if error is not None:
            if isinstance(error, dict):
                code = error.get("code")
                message = error.get("message")
            else:
                code = None
                message = None
            waiter.set_exception(
                JsonRpcError(
                    code if isinstance(code, int) and not isinstance(code, bool) else -32603,
                    message if isinstance(message, str) else "malformed permission error",
                )
            )
            return
        waiter.set_result(frame.get("result"))

    def _handle_notification(self, method: str, params: object) -> None:
        if method != "session/cancel":
            return
        if not isinstance(params, dict) or set(params) != {"sessionId"}:
            return
        session_id = params["sessionId"]
        if not isinstance(session_id, str):
            return
        cancelled = self._active_prompts.get(session_id)
        if cancelled is not None:
            cancelled.set()

    async def _update(self, session_id: str, text: str) -> None:
        await self._notify(
            "session/update",
            {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": text},
                },
            },
        )

    @staticmethod
    def _valid_new_session(params: object) -> bool:
        return (
            isinstance(params, dict)
            and set(params) == {"cwd", "mcpServers"}
            and isinstance(params["cwd"], str)
            and os.path.isabs(params["cwd"])
            and params["mcpServers"] == []
        )

    @staticmethod
    def _validate_prompt(params: object) -> tuple[str, str]:
        if not isinstance(params, dict) or set(params) != {"sessionId", "prompt"}:
            raise JsonRpcError(-32602, "invalid session/prompt params")
        session_id = params["sessionId"]
        prompt = params["prompt"]
        if not isinstance(session_id, str) or not session_id or not isinstance(prompt, list):
            raise JsonRpcError(-32602, "invalid session/prompt params")
        texts: list[str] = []
        for block in prompt:
            if (
                not isinstance(block, dict)
                or set(block) != {"type", "text"}
                or block["type"] != "text"
                or not isinstance(block["text"], str)
            ):
                raise JsonRpcError(-32602, "prompt must contain exact text blocks")
            texts.append(block["text"])
        if not texts:
            raise JsonRpcError(-32602, "prompt must contain text")
        return session_id, "".join(texts)

    async def _notify(self, method: str, params: object) -> None:
        await self._write({"jsonrpc": "2.0", "method": method, "params": params})

    async def _write(self, frame: dict[str, object]) -> None:
        payload = json.dumps(frame, separators=(",", ":"), ensure_ascii=False).encode()
        async with self._write_lock:
            await asyncio.to_thread(os.write, 1, payload + b"\n")

    def _track(self, task: asyncio.Task[None]) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._task_finished)

    def _task_finished(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            os.write(2, f"fake ACP task failed: {error}".encode())


async def _main() -> None:
    await FakeAcpServer().run()


if __name__ == "__main__":
    asyncio.run(_main())
