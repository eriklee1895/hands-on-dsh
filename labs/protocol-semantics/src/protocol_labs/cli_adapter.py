"""Bounded one-shot adapters for installed Codex and Hermes CLI event streams."""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import shutil
import signal
from collections import deque
from contextlib import suppress
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib

from protocol_labs.adapters import (
    AdapterExecutionError,
    AdapterResult,
    AdapterStateError,
    UnsupportedCapability,
)
from protocol_labs.live import INHERITED_ENV_NAMES, process_group_exists
from protocol_labs.owned_state import OwnedState

MAX_LINE = 1024 * 1024
MAX_STDOUT = 4 * 1024 * 1024
MAX_STDERR = 64 * 1024
HERMES_TIRITH_WARNING = (
    "⚠ tirith security scanner enabled but not available "
    "— command scanning will use pattern matching only"
)


def _engine_home(state: OwnedState, engine: str) -> Path:
    if engine == "hermes":
        # Hermes honors an explicit home under profiles/ even when another profile is active.
        return state.root / "profiles" / "adapter"
    return state.root / "engine-home"


def _required_binary(engine: str) -> Path:
    configured = os.environ.get(f"{engine.upper()}_ADAPTER_BIN")
    selected = configured or shutil.which(engine)
    if not selected:
        raise ValueError(f"{engine} executable is unavailable")
    path = Path(selected)
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError(f"{engine} executable is unavailable")
    return path


def _codex_options() -> tuple[str | None, str | None, str | None]:
    path = Path(os.environ.get("CODEX_ADAPTER_CONFIG", Path.home() / ".codex/config.toml"))
    if not path.is_file():
        return os.environ.get("CODEX_ADAPTER_MODEL"), None, None
    config = tomllib.loads(path.read_text())
    provider = config.get("model_provider")
    if provider not in (None, "openai"):
        raise ValueError("Codex adapter supports only the built-in openai provider")
    return (
        os.environ.get("CODEX_ADAPTER_MODEL") or config.get("model"),
        provider,
        config.get("model_reasoning_effort"),
    )


def _codex_auth(home: Path) -> None:
    source = Path(os.environ.get("CODEX_ADAPTER_AUTH", Path.home() / ".codex/auth.json"))
    if not source.is_file() or source.is_symlink():
        raise ValueError("Codex auth.json is unavailable")
    payload = source.read_bytes()
    if not isinstance(json.loads(payload), dict):
        raise ValueError("Codex auth.json must be an object")
    _write_private(home / "auth.json", payload)


def _write_private(path: Path, payload: bytes) -> None:
    """Create a private file with mode 0600 before any bytes are written."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(payload)


def _hermes_options() -> tuple[str, str]:
    model = os.environ.get("HERMES_ADAPTER_MODEL")
    provider = os.environ.get("HERMES_ADAPTER_PROVIDER")
    if not (model and provider):
        # Only these two public model selectors are read from the user's CLI configuration.
        path = Path(os.environ.get("HERMES_ADAPTER_CONFIG", Path.home() / ".hermes/config.yaml"))
        if not path.is_file():
            raise ValueError("Hermes model and provider must be configured")
        text = path.read_text()
        match = re.search(r"(?m)^model:\s*\n((?:^[ \t]+[^\n]*\n?)*)", text)
        if match:
            block = match.group(1)
            model_match = re.search(r"(?m)^\s+default:\s*([^#\n]+)", block)
            provider_match = re.search(r"(?m)^\s+provider:\s*([^#\n]+)", block)
            model = model or (model_match.group(1).strip().strip("\"'") if model_match else None)
            provider = provider or (
                provider_match.group(1).strip().strip("\"'") if provider_match else None
            )
    if not model or not provider:
        raise ValueError("Hermes model and provider must be configured")
    if provider != "deepseek":
        raise ValueError("Hermes adapter currently supports the configured deepseek provider")
    return model, provider


def _hermes_key() -> str:
    key = os.environ.get("DEEPSEEK_API_KEY")
    if key:
        return key
    source = Path(os.environ.get("HERMES_ADAPTER_ENV", Path.home() / ".hermes/.env"))
    if not source.is_file():
        raise ValueError("Hermes DeepSeek credential is unavailable")
    for line in source.read_text().splitlines():
        match = re.match(r"^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.*)$", line)
        if match:
            value = match.group(1).strip().strip("\"'")
            if value:
                return value
    raise ValueError("Hermes DeepSeek credential is unavailable")


def _child_env(parent: dict[str, str], state: OwnedState, engine: str) -> dict[str, str]:
    env = {name: parent[name] for name in INHERITED_ENV_NAMES if parent.get(name)}
    env["HOME"] = str(state.root / "home")
    if engine == "codex":
        env["CODEX_HOME"] = str(_engine_home(state, engine))
    else:
        env["HERMES_HOME"] = str(_engine_home(state, engine))
    return env


def _classify(
    engine: str, events: list[dict[str, object]], returncode: int, *, tirith_warning: bool = False
) -> AdapterResult:
    """Require one native terminal record and matching successful process exit."""
    if engine == "codex":
        started = [e for e in events if e.get("type") == "thread.started"]
        terminal = [e for e in events if e.get("type") in {"turn.completed", "turn.failed"}]
        if len(started) != 1 or len(terminal) != 1 or events[-1] is not terminal[0]:
            raise AdapterExecutionError("missing-terminal")
        last = terminal[0]
        status = (
            "completed" if last.get("type") == "turn.completed" and returncode == 0 else "failed"
        )
        messages = [
            e.get("item", {}).get("text")
            for e in events
            if e.get("type") == "item.completed"
            and isinstance(e.get("item"), dict)
            and e["item"].get("type") == "agent_message"
        ]
        text = messages[-1] if messages and isinstance(messages[-1], str) else None
        tools = sum(
            e.get("type") == "item.started"
            and isinstance(e.get("item"), dict)
            and e["item"].get("type") in {"command_execution", "file_change", "mcp_tool_call"}
            for e in events
        )
        return AdapterResult(
            engine,
            "exec-jsonl",
            status,
            text,
            str(started[0].get("thread_id") or ""),
            "turn-terminal-and-process-exit",
            {"terminalType": last["type"], "exitCode": returncode},
            tools,
        )
    initial = [e for e in events if e.get("type") == "system" and e.get("subtype") == "init"]
    terminal = [e for e in events if e.get("type") == "result"]
    if len(initial) != 1 or len(terminal) != 1 or events[-1] is not terminal[0]:
        raise AdapterExecutionError("missing-terminal")
    last = terminal[0]
    native_exit = last.get("exit_code")
    if type(native_exit) is not int or native_exit != returncode:
        raise AdapterExecutionError("terminal-exit-mismatch")
    status = "completed" if returncode == 0 else "interrupted" if returncode == 130 else "failed"
    text = last.get("text") if isinstance(last.get("text"), str) else None
    return AdapterResult(
        engine,
        "chat-stream-json",
        status,
        text,
        str(last.get("session_id") or ""),
        "result-exit-code-and-process-exit",
        {
            "terminalType": "result",
            "exitCode": returncode,
            "startupWarning": "tirith-unavailable" if tirith_warning else None,
        },
        sum(e.get("type") == "tool_use" for e in events),
    )


class CliAdapter:
    """Own one isolated CLI task and its process group; each instance admits one prompt."""

    def __init__(self, engine: str, binary: Path, state: OwnedState, model: str, provider: str):
        self.engine = engine
        self.protocol = "exec-jsonl" if engine == "codex" else "chat-stream-json"
        self._binary = binary
        self._state = state
        self._model = model
        self._provider = provider
        self._process: asyncio.subprocess.Process | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._stderr_tail: deque[int] = deque(maxlen=MAX_STDERR)
        self._close_task: asyncio.Task[dict[str, object]] | None = None
        self.state = "open"

    @property
    def state_root(self) -> Path:
        """Return this run's disposable workspace and state root."""
        return self._state.root

    async def prompt(self, text: str, timeout: float | None = None) -> AdapterResult:
        """Run a one-shot task and accept only a native terminal event with process exit."""
        if self.state != "open":
            raise AdapterStateError(f"adapter is {self.state}")
        if not isinstance(text, str) or not text:
            raise ValueError("adapter prompt text must be nonempty")
        limit = 300 if timeout is None else timeout
        if type(limit) not in (int, float) or not math.isfinite(limit) or not 0 < limit <= 3600:
            raise ValueError("adapter timeout must be finite and within 0..3600 seconds")
        self.state = "busy"
        try:
            return await asyncio.wait_for(self._run(text), timeout=float(limit))
        except asyncio.TimeoutError:
            self.state = "faulted"
            raise AdapterExecutionError("timeout") from None
        except asyncio.CancelledError:
            self.state = "faulted"
            raise
        except AdapterExecutionError:
            self.state = "faulted"
            raise
        except Exception:
            self.state = "faulted"
            raise AdapterExecutionError("invalid-result") from None

    async def _run(self, text: str) -> AdapterResult:
        workspace = self._state.root / "workspace"
        env = _child_env(dict(os.environ), self._state, self.engine)
        if self.engine == "codex":
            argv = [
                str(self._binary),
                "exec",
                "--json",
                "--ephemeral",
                "--ignore-user-config",
                "--ignore-rules",
                "--skip-git-repo-check",
                "--sandbox",
                "workspace-write",
                "--model",
                self._model,
                "-C",
                str(workspace),
                "-",
            ]
            if self._provider:
                argv[3:3] = ["-c", f"model_provider={json.dumps(self._provider)}"]
        else:
            prompt_file = self._state.root / "prompt.txt"
            _write_private(prompt_file, text.encode())
            argv = [
                str(self._binary),
                "chat",
                "--query-file",
                str(prompt_file),
                "--oneshot",
                "--format",
                "stream-json",
                "--safe-mode",
                "--model",
                self._model,
                "--provider",
                self._provider,
                "--in",
                str(workspace),
                "--source",
                "tool",
                "--max-turns",
                "8",
                "--run-budget",
                "240",
            ]
        self._process = await asyncio.create_subprocess_exec(
            *argv,
            cwd=workspace,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
            limit=MAX_LINE + 1,
        )
        if self.engine == "codex":
            assert self._process.stdin is not None
            self._process.stdin.write(text.encode() + b"\n")
            await self._process.stdin.drain()
        assert self._process.stdin is not None
        self._process.stdin.close()
        self._stderr_task = asyncio.create_task(self._drain_stderr())
        events: list[dict[str, object]] = []
        tirith_warning = False
        total = 0
        assert self._process.stdout is not None
        while True:
            try:
                line = await self._process.stdout.readline()
            except ValueError:
                raise AdapterExecutionError("output-limit") from None
            if not line:
                break
            total += len(line)
            if len(line) > MAX_LINE or total > MAX_STDOUT:
                raise AdapterExecutionError("output-limit")
            try:
                event = json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError):
                if (
                    self.engine == "hermes"
                    and not tirith_warning
                    and any(
                        item.get("type") == "system" and item.get("subtype") == "init"
                        for item in events
                    )
                    and not any(item.get("type") == "result" for item in events)
                    and line.decode("utf-8", errors="replace").strip() == HERMES_TIRITH_WARNING
                ):
                    tirith_warning = True
                    continue
                raise AdapterExecutionError("invalid-event") from None
            if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                raise AdapterExecutionError("invalid-event")
            events.append(event)
        returncode = await self._process.wait()
        await self._stderr_task
        result = _classify(self.engine, events, returncode, tirith_warning=tirith_warning)
        self.state = "finished"
        return result

    async def _drain_stderr(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        while chunk := await self._process.stderr.read(16384):
            self._stderr_tail.extend(chunk)

    async def _discard_stdout(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        while await self._process.stdout.read(16384):
            pass

    async def close(self) -> dict[str, object]:
        """Reap the process group and remove state only after independent confirmation."""
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._close_owned())
        return await asyncio.shield(self._close_task)

    async def _close_owned(self) -> dict[str, object]:
        process = self._process
        escalation = None
        if process is not None:
            discard = asyncio.create_task(self._discard_stdout()) if self.state != "busy" else None
            group = process.pid
            if process_group_exists(group):
                with suppress(ProcessLookupError):
                    os.killpg(group, signal.SIGTERM)
                escalation = "SIGTERM"
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(process.wait(), timeout=0.5)
            if process_group_exists(group):
                with suppress(ProcessLookupError):
                    os.killpg(group, signal.SIGKILL)
                escalation = "SIGKILL"
            await process.wait()
            if self._stderr_task is not None:
                await self._stderr_task
            if discard is not None:
                await discard
            group_gone = not process_group_exists(group)
            returncode = process.returncode
        else:
            group_gone = True
            returncode = None
        if group_gone:
            shutil.rmtree(self._state.root)
            self.state = "closed"
        else:
            self.state = "faulted"
        return {
            "group_gone": group_gone,
            "returncode": returncode,
            "escalation_signal": escalation,
            "native_clean_exit": returncode == 0 and escalation is None,
            "state_removed": not self._state.root.exists(),
        }

    async def close_session(self) -> None:
        """Reject session close; the one-shot CLI owns its own session lifetime."""
        raise UnsupportedCapability("CLI session close is not integrated")

    async def resume(self) -> None:
        """Reject resume until a durable isolated session path is implemented."""
        raise UnsupportedCapability("CLI resume is not integrated")

    async def cancel_probe(self) -> None:
        """Reject native cancel; process cleanup is not a native turn cancellation."""
        raise UnsupportedCapability("CLI native cancellation is not integrated")


async def open_cli_adapter(engine: str) -> CliAdapter:
    """Validate binary and model settings before creating isolated run state."""
    if engine not in {"codex", "hermes"}:
        raise ValueError("CLI engine must be codex or hermes")
    binary = _required_binary(engine)
    hermes_key: str | None = None
    if engine == "codex":
        model, provider, _effort = _codex_options()
        if not model:
            raise ValueError("Codex model must be configured")
        auth = Path(os.environ.get("CODEX_ADAPTER_AUTH", Path.home() / ".codex/auth.json"))
        if not auth.is_file():
            raise ValueError("Codex auth.json is unavailable")
    else:
        model, provider = _hermes_options()
        hermes_key = _hermes_key()
        if "\n" in hermes_key or "\r" in hermes_key:
            raise ValueError("Hermes credential cannot contain a newline")
    state = OwnedState.create(prefix=f"{engine}-adapter-", owner_ids={"adapter"})
    try:
        home = _engine_home(state, engine)
        home.mkdir(mode=0o700, parents=True)
        state.root.chmod(0o700)
        if engine == "codex":
            _codex_auth(home)
        else:
            assert hermes_key is not None
            secret = home / ".env"
            _write_private(secret, f"DEEPSEEK_API_KEY={hermes_key}\n".encode())
    except BaseException:
        shutil.rmtree(state.root)
        raise
    return CliAdapter(engine, binary, state, model, provider or "")
