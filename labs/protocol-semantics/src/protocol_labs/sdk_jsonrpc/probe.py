"""SDK JSON-RPC lifecycle and settlement probe."""

from __future__ import annotations

import asyncio
from pathlib import Path

from protocol_labs.jsonl_peer import CloseOutcome, JsonlPeer
from protocol_labs.launch import LaunchSpec
from protocol_labs.normalize import normalize_committed_transcript


class SdkProbe:
    """Drive the narrow SDK request surface and interpret SessionEvent semantics."""

    def __init__(
        self,
        peer: JsonlPeer,
        launch: LaunchSpec,
        server_info: dict[str, object],
    ) -> None:
        self._peer = peer
        self.launch = launch
        self.server_info = server_info

    @classmethod
    async def start(
        cls,
        launch: LaunchSpec,
        *,
        cwd: Path,
        provider: str,
        model: str,
        max_tokens: int | None = None,
        child_env: dict[str, str] | None = None,
        startup_timeout: float = 1,
    ) -> SdkProbe:
        """Start and initialize an SDK peer.

        Args:
            launch: Validated server launch specification.
            cwd: Absolute DSH workspace path.
            provider: Provider identifier.
            model: Model identifier.
            max_tokens: Optional positive output-token bound.
            child_env: Optional complete child-process environment.
            startup_timeout: Bounded initialize duration in seconds.

        Returns:
            An initialized probe.
        """
        if not cwd.is_absolute():
            raise ValueError("SDK initialize cwd must be absolute")
        peer = await JsonlPeer.start(launch.argv, cwd=launch.cwd, env=child_env)
        params: dict[str, object] = {
            "cwd": str(cwd),
            "provider": provider,
            "model": model,
        }
        if max_tokens is not None:
            params["maxTokens"] = max_tokens
        try:
            result = await peer.request("initialize", params, timeout=startup_timeout)
        except BaseException:
            await peer.close()
            raise
        if not isinstance(result, dict) or not isinstance(result.get("serverInfo"), dict):
            await peer.close()
            raise RuntimeError("initialize returned invalid serverInfo")
        server_info = result["serverInfo"]
        if any(
            not isinstance(server_info.get(field), str) or not server_info[field]
            for field in ("name", "version")
        ):
            await peer.close()
            raise RuntimeError("initialize returned invalid serverInfo name/version")
        return cls(peer, launch, dict(server_info))

    @property
    def process_group_id(self) -> int:
        """Return the process group owned by the transport."""
        return self._peer.process_group_id

    async def prompt(
        self,
        prompt: str,
        *,
        session_id: str = "root",
        timeout: float = 1,
    ) -> dict[str, object]:
        """Prompt and settle only after matching receipt then root idle.

        Args:
            prompt: Ordered single text-block prompt.
            session_id: Root DSH session identifier.
            timeout: Response and settlement timeout in seconds.

        Returns:
            Sanitized semantic evidence.
        """
        result = await self._peer.request(
            "session/prompt",
            {
                "sessionId": session_id,
                "contentBlocks": [{"type": "text", "text": prompt}],
            },
            timeout=timeout,
        )
        if not isinstance(result, dict) or not isinstance(result.get("messageId"), str):
            raise RuntimeError("session/prompt returned invalid messageId")
        message_id = result["messageId"]
        buffered_before_response = self._peer.queued_notification_count
        return await self._settle(
            prompt,
            session_id,
            message_id,
            buffered_before_response,
            timeout,
        )

    async def close(self) -> CloseOutcome:
        """Request SDK shutdown, close stdin, and return final process evidence."""
        return await self._peer.close(shutdown_method="shutdown")

    async def _settle(
        self,
        prompt: str,
        root_session: str,
        message_id: str,
        buffered_before_response: int,
        timeout: float,
    ) -> dict[str, object]:
        receipt_matched = False
        unmatched_receipts = 0
        stale_root_idle = 0
        stale_root_events = 0
        descendants: set[str] = set()
        descendant_events = 0
        subagent_finished = 0
        foreign_events = 0
        raw_text: list[str] = []
        committed_answer: str | None = None
        turn_completed = False
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise asyncio.TimeoutError
            notification = await self._peer.next_notification(timeout=remaining)
            method = notification["method"]
            params = notification["params"]
            if not isinstance(params, dict):
                continue
            if not receipt_matched:
                if (
                    method == "session.status"
                    and params.get("sessionId") == root_session
                    and params.get("status") == "idle"
                ):
                    stale_root_idle += 1
                    continue
                if method != "session.event" or params.get("sessionId") != root_session:
                    continue
                event = params.get("event")
                if not isinstance(event, dict) or not isinstance(event.get("data"), dict):
                    continue
                if event.get("type") != "agent/inbox/spliced":
                    stale_root_events += 1
                    continue
                inserted = event["data"].get("inserted")
                if isinstance(inserted, list) and any(
                    isinstance(item, dict) and item.get("id") == message_id for item in inserted
                ):
                    receipt_matched = True
                elif isinstance(inserted, list) and inserted:
                    unmatched_receipts += 1
                continue
            if method == "subagent.started":
                parent = params.get("parentSessionId")
                child = params.get("childSessionId")
                if parent in {root_session, *descendants} and isinstance(child, str):
                    descendants.add(child)
                continue
            if method == "subagent.finished":
                parent = params.get("parentSessionId")
                child = params.get("childSessionId")
                if parent in {root_session, *descendants} and child in descendants:
                    subagent_finished += 1
                continue
            if method == "session.status":
                observed_session = params.get("sessionId")
                status = params.get("status")
                if observed_session in descendants:
                    descendant_events += 1
                    continue
                if observed_session != root_session:
                    foreign_events += 1
                    continue
                if status == "idle":
                    if not receipt_matched:
                        stale_root_idle += 1
                        continue
                    break
                continue
            if method != "session.event":
                continue
            observed_session = params.get("sessionId")
            if observed_session in descendants:
                descendant_events += 1
                continue
            if observed_session != root_session:
                foreign_events += 1
                continue
            event = params.get("event")
            if not isinstance(event, dict) or not isinstance(event.get("data"), dict):
                continue
            event_type = event.get("type")
            data = event["data"]
            if event_type == "assistant/chunk":
                chunk = data.get("chunk")
                if (
                    isinstance(chunk, dict)
                    and chunk.get("type") == "text-delta"
                    and isinstance(chunk.get("text"), str)
                ):
                    raw_text.append(chunk["text"])
            elif event_type == "assistant/message":
                message = data.get("message")
                if isinstance(message, dict):
                    committed_answer = _content_text(message.get("content"))
            elif event_type == "turn/end":
                reason = data.get("reason")
                turn_completed = isinstance(reason, dict) and reason.get("kind") == "completed"
        if not receipt_matched:
            raise RuntimeError("root settlement lacked the matching inbox receipt")
        return {
            "serverInfo": self.server_info,
            "messageId": message_id,
            "bufferedBeforeResponse": buffered_before_response,
            "receiptMatched": receipt_matched,
            "unmatchedReceiptsIgnored": unmatched_receipts,
            "settlement": "receipt-to-root-idle",
            "staleRootIdleIgnored": stale_root_idle,
            "staleRootEventsIgnored": stale_root_events,
            "rawTextDeltas": raw_text,
            "committedAnswer": committed_answer,
            "completedTurnObserved": turn_completed,
            "transcript": (
                normalize_committed_transcript(prompt, committed_answer)
                if committed_answer is not None and turn_completed
                else None
            ),
            "descendantSessions": sorted(descendants),
            "descendantEventsObserved": descendant_events,
            "subagentFinishedObserved": subagent_finished,
            "foreignEventsDiscarded": foreign_events,
            "diagnostics": [dict(item) for item in self._peer.diagnostics],
        }


def _content_text(content: object) -> str | None:
    if not isinstance(content, list):
        return None
    values = [
        block["text"]
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    ]
    return "".join(values) if values else None
