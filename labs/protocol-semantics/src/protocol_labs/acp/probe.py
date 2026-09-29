"""ACP v1 lifecycle, committed-output, cancel, and permission probe."""

from __future__ import annotations

import asyncio
from pathlib import Path

from protocol_labs.jsonl_peer import CloseOutcome, JsonlPeer, JsonRpcError
from protocol_labs.launch import LaunchSpec
from protocol_labs.normalize import TextBlock, normalize_committed_transcript


class AcpProbe:
    """Drive the narrow ACP surface and retain only committed text updates."""

    def __init__(
        self,
        peer: JsonlPeer,
        launch: LaunchSpec,
        *,
        agent_info: dict[str, object],
        agent_capabilities: dict[str, object],
        auth_methods: list[object],
        session_id: str,
        config_options: list[object],
        permission_requests: list[dict[str, object]],
        permission_responses: list[dict[str, object]],
    ) -> None:
        self._peer = peer
        self.launch = launch
        self.agent_info = agent_info
        self.agent_capabilities = agent_capabilities
        self.auth_methods = auth_methods
        self.session_id = session_id
        self.config_options = config_options
        self._permission_requests = permission_requests
        self._permission_responses = permission_responses

    @classmethod
    async def start(
        cls,
        launch: LaunchSpec,
        *,
        cwd: Path,
        permission_decision: str = "allow-once",
        child_env: dict[str, str] | None = None,
        startup_timeout: float = 1,
        resume_session_id: str | None = None,
    ) -> AcpProbe:
        """Start, initialize, authenticate, and create one fresh ACP session.

        Args:
            launch: Validated ACP launch specification.
            cwd: Absolute workspace sent to ``session/new``.
            permission_decision: Allow, reject, cancel, unknown, or handler-error policy.
            child_env: Optional complete child-process environment.
            startup_timeout: Bound for each startup request in seconds.

        Returns:
            An initialized probe with one fresh session.
        """
        if not cwd.is_absolute():
            raise ValueError("ACP session cwd must be absolute")
        if permission_decision not in {
            "allow-once",
            "reject-once",
            "cancel",
            "unknown",
            "error",
        }:
            raise ValueError("unknown ACP permission decision")
        permission_requests: list[dict[str, object]] = []
        permission_responses: list[dict[str, object]] = []
        expected_session: dict[str, str | None] = {"id": None}

        async def handle_request(method: str, params: object) -> object:
            permission_requests.append({"method": method, "params": params})
            if method != "session/request_permission":
                raise JsonRpcError(-32601, f"unknown method: {method}")
            if params != {
                "sessionId": expected_session["id"],
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
            }:
                raise JsonRpcError(-32602, "invalid permission request")
            if permission_decision == "error":
                failure = {
                    "error": {
                        "code": -32603,
                        "message": "permission decision unavailable",
                    }
                }
                permission_responses.append(failure)
                raise JsonRpcError(-32603, "permission decision unavailable")
            if permission_decision == "cancel":
                response = {"outcome": {"outcome": "cancelled"}}
            else:
                option_id = {
                    "allow-once": "allow-once",
                    "reject-once": "reject-once",
                    "unknown": "missing-option",
                }[permission_decision]
                response = {"outcome": {"outcome": "selected", "optionId": option_id}}
            permission_responses.append(response)
            return response

        peer = await JsonlPeer.start(
            launch.argv,
            cwd=launch.cwd,
            env=child_env,
            request_handler=handle_request,
        )
        try:
            initialized = await peer.request(
                "initialize",
                {"protocolVersion": 1, "clientCapabilities": {}},
                timeout=startup_timeout,
            )
            agent_info, agent_capabilities, auth_methods = cls._validate_initialize(initialized)
            authenticated = await peer.request(
                "authenticate", {"methodId": "unused"}, timeout=startup_timeout
            )
            if authenticated != {}:
                raise RuntimeError("authenticate returned an invalid result")
            expected_session["id"] = resume_session_id
            method = "session/resume" if resume_session_id is not None else "session/new"
            params: dict[str, object] = {"cwd": str(cwd), "mcpServers": []}
            if resume_session_id is not None:
                params["sessionId"] = resume_session_id
            created = await peer.request(method, params, timeout=startup_timeout)
            if (
                not isinstance(created, dict)
                or not isinstance(created.get("configOptions"), list)
                or (resume_session_id is None and not isinstance(created.get("sessionId"), str))
            ):
                raise RuntimeError(f"{method} returned invalid session metadata")
            session_id = resume_session_id or created["sessionId"]
            if not session_id:
                raise RuntimeError(f"{method} returned an empty sessionId")
            expected_session["id"] = session_id
        except BaseException:
            await peer.close()
            raise
        return cls(
            peer,
            launch,
            agent_info=agent_info,
            agent_capabilities=agent_capabilities,
            auth_methods=auth_methods,
            session_id=session_id,
            config_options=created["configOptions"],
            permission_requests=permission_requests,
            permission_responses=permission_responses,
        )

    @property
    def process_group_id(self) -> int:
        """Return the process group owned by the transport."""
        return self._peer.process_group_id

    async def historical_replay_count(self) -> int:
        """Drain queued updates and count prior text/tool replay, excluding config publication."""
        count = 0
        while self._peer.queued_notification_count:
            notification = await self._peer.next_notification()
            if notification.get("method") != "session/update":
                continue
            params = notification.get("params")
            if not isinstance(params, dict) or params.get("sessionId") != self.session_id:
                continue
            update = params.get("update")
            if isinstance(update, dict) and update.get("sessionUpdate") in {
                "user_message_chunk",
                "agent_message_chunk",
                "agent_thought_chunk",
                "tool_call",
                "tool_call_update",
            }:
                count += 1
        return count

    async def close(self) -> CloseOutcome:
        """Close ACP with stdin EOF and return final process evidence."""
        return await self._peer.close()

    async def list_sessions(self, *, cwd: Path | None = None) -> dict[str, object]:
        """List inactive persisted root sessions through ACP."""
        params = {} if cwd is None else {"cwd": str(cwd)}
        result = await self._peer.request("session/list", params)
        if not isinstance(result, dict) or not isinstance(result.get("sessions"), list):
            raise RuntimeError("session/list returned invalid sessions")
        return result

    async def close_session(self) -> None:
        """Close the active ACP session while keeping its persisted log."""
        result = await self._peer.request("session/close", {"sessionId": self.session_id})
        if result != {}:
            raise RuntimeError("session/close returned an invalid result")

    async def resume_session(self, cwd: Path) -> list[object]:
        """Resume this session at the exact workspace without replaying prior updates."""
        result = await self._peer.request(
            "session/resume",
            {"sessionId": self.session_id, "cwd": str(cwd), "mcpServers": []},
        )
        if not isinstance(result, dict) or not isinstance(result.get("configOptions"), list):
            raise RuntimeError("session/resume returned invalid configOptions")
        self.config_options = result["configOptions"]
        return self.config_options

    async def select_advertised_model(self, preferred: str = "deepseek-flash") -> list[object]:
        """Select a model value advertised by the server, without constructing opaque IDs."""
        model = next(
            (
                option
                for option in self.config_options
                if isinstance(option, dict) and option.get("id") == "model"
            ),
            None,
        )
        if model is None or not isinstance(model.get("options"), list):
            raise RuntimeError("server advertised no model option")
        choices: list[dict[str, object]] = []
        for item in model["options"]:
            if isinstance(item, dict):
                members = item.get("options")
                if isinstance(members, list):
                    choices.extend(member for member in members if isinstance(member, dict))
                else:
                    choices.append(item)
        choice = next(
            (
                item
                for item in choices
                if isinstance(item.get("value"), str) and preferred in item["value"]
            ),
            None,
        )
        if choice is None:
            raise RuntimeError(f"server did not advertise model {preferred}")
        result = await self._peer.request(
            "session/set_config_option",
            {
                "sessionId": self.session_id,
                "configId": model["id"],
                "value": choice["value"],
            },
        )
        if not isinstance(result, dict) or not isinstance(result.get("configOptions"), list):
            raise RuntimeError("session/set_config_option returned invalid configOptions")
        self.config_options = result["configOptions"]
        return self.config_options

    async def prompt(
        self,
        prompt: list[TextBlock],
        *,
        timeout: float = 1,
        request_id: str | int | float | None = None,
    ) -> dict[str, object]:
        """Send ordered text blocks and settle at the prompt result.

        Args:
            prompt: Ordered ACP text content blocks.
            timeout: Bounded prompt duration in seconds.
            request_id: Optional explicit direction-local request ID.

        Returns:
            Sanitized committed-output and settlement evidence.
        """
        result = await self._peer.request(
            "session/prompt",
            {"sessionId": self.session_id, "prompt": prompt},
            timeout=timeout,
            request_id=request_id,
        )
        if (
            not isinstance(result, dict)
            or set(result) != {"stopReason"}
            or result["stopReason"] not in {"end_turn", "cancelled"}
        ):
            raise RuntimeError("session/prompt returned an invalid stopReason")
        chunks: list[str] = []
        tool_updates = 0
        local_diagnostics: list[dict[str, object]] = []
        while self._peer.queued_notification_count:
            notification = await self._peer.next_notification()
            if self._is_tool_update(notification):
                tool_updates += 1
            text = self._committed_text(notification, local_diagnostics)
            if text is not None:
                chunks.append(text)
        return self._evidence(
            prompt, chunks, result["stopReason"], local_diagnostics, tool_updates=tool_updates
        )

    async def cancel_prompt(self, *, timeout: float = 1) -> dict[str, object]:
        """Wait for the fake readiness commit before sending ACP cancellation.

        Args:
            timeout: Bounded readiness and settlement duration in seconds.

        Returns:
            Sanitized cancellation evidence.
        """
        prompt = [{"type": "text", "text": "lab:cancel"}]
        request = asyncio.create_task(
            self._peer.request(
                "session/prompt",
                {"sessionId": self.session_id, "prompt": prompt},
                timeout=timeout,
            )
        )
        chunks: list[str] = []
        local_diagnostics: list[dict[str, object]] = []
        try:
            while "".join(chunks) != "ready to cancel":
                notification = await self._peer.next_notification(timeout=timeout)
                text = self._committed_text(notification, local_diagnostics)
                if text is not None:
                    chunks.append(text)
            await self._peer.notify("session/cancel", {"sessionId": self.session_id})
            result = await request
        except BaseException:
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)
            raise
        if result != {"stopReason": "cancelled"}:
            raise RuntimeError("cancelled prompt returned an invalid result")
        evidence = self._evidence(prompt, chunks, "cancelled", local_diagnostics)
        evidence["cancelSentAfterReadiness"] = True
        return evidence

    def _evidence(
        self,
        prompt: list[TextBlock],
        chunks: list[str],
        stop_reason: object,
        local_diagnostics: list[dict[str, object]],
        *,
        tool_updates: int = 0,
    ) -> dict[str, object]:
        answer = "".join(chunks)
        evidence = {
            "sessionId": self.session_id,
            "committedChunks": chunks,
            "committedAnswer": answer,
            "toolUpdates": tool_updates,
            "stopReason": stop_reason,
            "settlement": "committed-to-end-turn"
            if stop_reason == "end_turn"
            else "committed-to-cancelled",
            "transcript": normalize_committed_transcript(prompt, answer)
            if stop_reason == "end_turn"
            else None,
            "permissionRequests": [dict(item) for item in self._permission_requests],
            "diagnostics": [*self._peer.diagnostics, *local_diagnostics],
        }
        if self._permission_responses:
            evidence["permissionResponses"] = [dict(item) for item in self._permission_responses]
        return evidence

    def _is_tool_update(self, notification: dict[str, object]) -> bool:
        if notification.get("method") != "session/update":
            return False
        params = notification.get("params")
        if not isinstance(params, dict) or params.get("sessionId") != self.session_id:
            return False
        update = params.get("update")
        return isinstance(update, dict) and update.get("sessionUpdate") in {
            "tool_call",
            "tool_call_update",
        }

    def _committed_text(
        self,
        notification: dict[str, object],
        diagnostics: list[dict[str, object]],
    ) -> str | None:
        params = notification.get("params")
        if notification.get("method") != "session/update" or not isinstance(params, dict):
            diagnostics.append({"kind": "malformed_session_update"})
            return None
        update = params.get("update")
        if params.get("sessionId") != self.session_id or not isinstance(update, dict):
            diagnostics.append({"kind": "malformed_session_update"})
            return None
        content = update.get("content")
        if update.get("sessionUpdate") != "agent_message_chunk":
            return None
        if (
            not {"sessionUpdate", "content"} <= set(update)
            or set(update) - {"sessionUpdate", "content", "messageId"}
            or update.get("sessionUpdate") != "agent_message_chunk"
            or ("messageId" in update and not isinstance(update["messageId"], str))
            or not isinstance(content, dict)
            or set(content) != {"type", "text"}
            or content.get("type") != "text"
            or not isinstance(content.get("text"), str)
        ):
            diagnostics.append({"kind": "malformed_session_update"})
            return None
        return content["text"]

    @staticmethod
    def _validate_initialize(
        result: object,
    ) -> tuple[dict[str, object], dict[str, object], list[object]]:
        if not isinstance(result, dict) or set(result) != {
            "protocolVersion",
            "agentInfo",
            "agentCapabilities",
            "authMethods",
        }:
            raise RuntimeError("initialize returned an invalid ACP result")
        if isinstance(result["protocolVersion"], bool) or result["protocolVersion"] != 1:
            raise RuntimeError("initialize returned an incompatible protocol version")
        agent_info = result["agentInfo"]
        capabilities = result["agentCapabilities"]
        auth_methods = result["authMethods"]
        prompt_capabilities = (
            capabilities.get("promptCapabilities") if isinstance(capabilities, dict) else None
        )
        if (
            not isinstance(agent_info, dict)
            or set(agent_info) != {"name", "version"}
            or any(
                not isinstance(agent_info.get(field), str) or not agent_info[field]
                for field in ("name", "version")
            )
            or not isinstance(capabilities, dict)
            or "promptCapabilities" not in capabilities
            or not isinstance(prompt_capabilities, dict)
            or set(prompt_capabilities) != {"image", "audio", "embeddedContext"}
            or any(
                not isinstance(prompt_capabilities[field], bool)
                for field in ("image", "audio", "embeddedContext")
            )
            or auth_methods != []
        ):
            raise RuntimeError("initialize returned invalid ACP identity or capabilities")
        return dict(agent_info), dict(capabilities), list(auth_methods)
