"""Subprocess fixtures exercise native terminal classification and owned cleanup."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from protocol_labs.adapters import AdapterExecutionError, AdapterStateError, UnsupportedCapability
from protocol_labs.cli_adapter import open_cli_adapter


@pytest.fixture
def fake_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    binary = tmp_path / "fake-cli"
    binary.write_text(
        """#!/usr/bin/env python3
import json, pathlib, sys, time
def emit(value):
    print(json.dumps(value), flush=True)
engine = 'codex' if sys.argv[1] == 'exec' else 'hermes'
prompt = sys.stdin.read() if engine == 'codex' else pathlib.Path(sys.argv[sys.argv.index('--query-file')+1]).read_text()
warning = '  ⚠ tirith security scanner enabled but not available — command scanning will use pattern matching only'
if engine == 'hermes' and prompt == 'warning-before-init':
    print(warning, flush=True)
if engine == 'codex':
    emit({'type':'thread.started','thread_id':'test-thread'})
else:
    emit({'type':'system','subtype':'init','session_id':'test-session'})
    if prompt == 'known-warning':
        print(warning, flush=True)
    if prompt == 'duplicate-warning':
        print(warning, flush=True)
        print(warning, flush=True)
    if prompt == 'unknown-warning':
        print('unexpected startup text', flush=True)
if 'timeout' in prompt:
    time.sleep(3)
if 'output-limit' in prompt:
    print('x' * (1024 * 1024 + 8), flush=True)
if 'artifact' in prompt:
    pathlib.Path('result.txt').write_text('exact\\n')
    emit({'type':'item.started','item':{'type':'command_execution'}} if engine == 'codex' else {'type':'tool_use','name':'terminal'})
if 'partial' in prompt:
    emit({'type':'item.completed','item':{'type':'agent_message','text':'partial'}} if engine == 'codex' else {'type':'text','text':'partial'})
    sys.exit(0)
if 'failed' in prompt:
    if engine == 'codex':
        emit({'type':'turn.failed'})
    else:
        emit({'type':'result','session_id':'test-session','exit_code':1,'text':'partial'})
    sys.exit(1)
if engine == 'codex':
    emit({'type':'item.completed','item':{'type':'agent_message','text':'exact'}})
    emit({'type':'turn.completed'})
else:
    emit({'type':'result','session_id':'test-session','exit_code':0,'text':'exact'})
    if prompt == 'warning-after-result':
        print(warning, flush=True)
"""
    )
    binary.chmod(0o700)
    for engine in ("CODEX", "HERMES"):
        monkeypatch.setenv(f"{engine}_ADAPTER_BIN", str(binary))
    auth = tmp_path / "auth.json"
    auth.write_text(json.dumps({"tokens": {}}))
    monkeypatch.setenv("CODEX_ADAPTER_AUTH", str(auth))
    monkeypatch.setenv("CODEX_ADAPTER_MODEL", "test-model")
    config = tmp_path / "codex.toml"
    config.write_text('model = "test-model"\nmodel_provider = "openai"\n')
    monkeypatch.setenv("CODEX_ADAPTER_CONFIG", str(config))
    monkeypatch.setenv("HERMES_ADAPTER_MODEL", "test-model")
    monkeypatch.setenv("HERMES_ADAPTER_PROVIDER", "deepseek")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "fixture-key")
    return binary


@pytest.mark.parametrize("engine", ["codex", "hermes"])
def test_cli_terminal_artifact_and_unsupported_controls(fake_cli: Path, engine: str) -> None:
    async def scenario() -> None:
        adapter = await open_cli_adapter(engine)
        try:
            private = (
                adapter.state_root / "engine-home/auth.json"
                if engine == "codex"
                else adapter.state_root / "profiles/adapter/.env"
            )
            assert private.stat().st_mode & 0o777 == 0o600
            result = await adapter.prompt("make artifact")
            assert result.status == "completed"
            assert result.text == "exact"
            assert result.tool_events == 1
            assert (adapter.state_root / "workspace/result.txt").read_text() == "exact\n"
            with pytest.raises(AdapterStateError):
                await adapter.prompt("another")
            for operation in (adapter.close_session, adapter.resume, adapter.cancel_probe):
                with pytest.raises(UnsupportedCapability):
                    await operation()
        finally:
            closed = await adapter.close()
        assert closed["native_clean_exit"] is True
        assert closed["group_gone"] is True
        assert closed["state_removed"] is True

    asyncio.run(scenario())


@pytest.mark.parametrize("engine", ["codex", "hermes"])
@pytest.mark.parametrize("prompt,expected", [("failed", "failed"), ("partial", "missing-terminal")])
def test_cli_failure_is_not_completed(
    fake_cli: Path, engine: str, prompt: str, expected: str
) -> None:
    async def scenario() -> None:
        adapter = await open_cli_adapter(engine)
        try:
            if expected == "failed":
                result = await adapter.prompt(prompt)
                assert result.status == "failed"
                assert result.text in {None, "partial"}
            else:
                with pytest.raises(AdapterExecutionError) as failure:
                    await adapter.prompt(prompt)
                assert failure.value.kind == expected
                assert adapter.state == "faulted"
        finally:
            closed = await adapter.close()
        assert closed["group_gone"] is True
        assert closed["state_removed"] is True

    asyncio.run(scenario())


@pytest.mark.parametrize("engine", ["codex", "hermes"])
def test_cli_timeout_reaps_process_group(fake_cli: Path, engine: str) -> None:
    async def scenario() -> None:
        adapter = await open_cli_adapter(engine)
        try:
            with pytest.raises(AdapterExecutionError) as failure:
                await adapter.prompt("timeout", timeout=0.05)
            assert failure.value.kind == "timeout"
        finally:
            closed = await adapter.close()
        assert closed["group_gone"] is True
        assert closed["state_removed"] is True
        assert closed["native_clean_exit"] is False

    asyncio.run(scenario())


@pytest.mark.parametrize("engine", ["codex", "hermes"])
def test_cli_output_limit_still_reaps_process_group(fake_cli: Path, engine: str) -> None:
    async def scenario() -> None:
        adapter = await open_cli_adapter(engine)
        try:
            with pytest.raises(AdapterExecutionError) as failure:
                await adapter.prompt("output-limit")
            assert failure.value.kind == "output-limit"
        finally:
            closed = await adapter.close()
        assert closed["group_gone"] is True
        assert closed["state_removed"] is True

    asyncio.run(scenario())


def test_hermes_accepts_only_fixed_native_startup_warning(fake_cli: Path) -> None:
    async def scenario() -> None:
        known = await open_cli_adapter("hermes")
        try:
            result = await known.prompt("known-warning")
            assert result.status == "completed"
            assert result.native["startupWarning"] == "tirith-unavailable"
        finally:
            assert (await known.close())["state_removed"] is True
        unknown = await open_cli_adapter("hermes")
        try:
            with pytest.raises(AdapterExecutionError) as failure:
                await unknown.prompt("unknown-warning")
            assert failure.value.kind == "invalid-event"
        finally:
            assert (await unknown.close())["state_removed"] is True

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "prompt", ["warning-before-init", "duplicate-warning", "warning-after-result"]
)
def test_hermes_warning_position_and_count_are_strict(fake_cli: Path, prompt: str) -> None:
    async def scenario() -> None:
        adapter = await open_cli_adapter("hermes")
        try:
            with pytest.raises(AdapterExecutionError) as failure:
                await adapter.prompt(prompt)
            assert failure.value.kind == "invalid-event"
        finally:
            assert (await adapter.close())["state_removed"] is True

    asyncio.run(scenario())


def test_hermes_provider_override_still_rejects_unintegrated_provider(
    fake_cli: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from protocol_labs.cli_adapter import _hermes_options

    monkeypatch.setenv("HERMES_ADAPTER_PROVIDER", "openrouter")
    with pytest.raises(ValueError, match="deepseek provider"):
        _hermes_options()


@pytest.mark.parametrize("engine,fault", [("codex", "auth-copy"), ("hermes", "secret-write")])
def test_setup_failure_removes_private_state(
    fake_cli: Path, monkeypatch: pytest.MonkeyPatch, engine: str, fault: str
) -> None:
    from protocol_labs import cli_adapter

    roots: list[Path] = []
    original_create = cli_adapter.OwnedState.create

    def create(*, prefix: str, owner_ids: set[str]):
        state = original_create(prefix=prefix, owner_ids=owner_ids)
        roots.append(state.root)
        return state

    monkeypatch.setattr(cli_adapter.OwnedState, "create", staticmethod(create))
    if fault == "auth-copy":

        def copy_auth(_home: Path) -> None:
            raise OSError("credential read failed")

        monkeypatch.setattr(cli_adapter, "_codex_auth", copy_auth)
    else:
        original_write = cli_adapter._write_private

        def write(path: Path, data: bytes) -> None:
            if path.name == ".env":
                original_write(path, b"DEEPSEEK_API_KEY=partial")
                raise OSError("credential write failed")
            original_write(path, data)

        monkeypatch.setattr(cli_adapter, "_write_private", write)

    async def scenario() -> None:
        with pytest.raises(OSError):
            await open_cli_adapter(engine)

    asyncio.run(scenario())
    assert len(roots) == 1
    assert not roots[0].exists()
