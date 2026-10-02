"""Configuration is validated before starting any tenant coordinator."""

from __future__ import annotations

import hashlib
import json

import pytest

from recoverable_agent_service import tenant_server


def config():
    return {
        "alpha": {"token_sha256": [hashlib.sha256(b"a" * 40).hexdigest()]},
        "beta": {"token_sha256": [hashlib.sha256(b"b" * 40).hexdigest()]},
    }


def test_config_owns_separate_paths_without_creating_state(tmp_path, monkeypatch):
    monkeypatch.setenv("RECOVERABLE_AGENT_TENANTS", json.dumps(config()))
    monkeypatch.setenv("RECOVERABLE_AGENT_TENANT_ROOT", str(tmp_path))
    monkeypatch.setenv("RECOVERABLE_AGENT_DATABASE", str(tmp_path / "legacy.db"))
    created = []
    from fastapi import FastAPI

    def child(**kwargs):
        created.append(kwargs)
        return FastAPI()

    monkeypatch.setattr(tenant_server, "create_app", child)
    app = tenant_server.create_from_env()
    assert app is not None
    assert len(created) == 2
    for index, tenant in enumerate(("alpha", "beta")):
        assert created[index]["database_path"] == tmp_path / tenant / "service.db"
        assert created[index]["workspace"] == tmp_path / tenant / "workspace"
        assert created[index]["dsh_home"] == tmp_path / tenant / "dsh-home"
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    "value",
    [
        None,
        "",
        "not json",
        "[]",
        "{}",
        '{"alpha":{},"alpha":{}}',
        '{"alpha":{"token_sha256":[],"extra":true}}',
        '{"../escape":{"token_sha256":[]}}',
        '{"alpha":{"token_sha256":"not-a-list"}}',
        '{"alpha":{"token_sha256":["secret-value"]}}',
    ],
)
def test_bad_config_fails_without_echoing_values(value, monkeypatch):
    if value is None:
        monkeypatch.delenv("RECOVERABLE_AGENT_TENANTS", raising=False)
    else:
        monkeypatch.setenv("RECOVERABLE_AGENT_TENANTS", value)
    with pytest.raises(ValueError) as caught:
        tenant_server.create_from_env()
    assert "secret-value" not in str(caught.value)
    assert "not json" not in str(caught.value)


def test_duplicate_digest_cannot_select_two_tenants(monkeypatch):
    value = config()
    value["beta"] = value["alpha"]
    monkeypatch.setenv("RECOVERABLE_AGENT_TENANTS", json.dumps(value))
    with pytest.raises(ValueError):
        tenant_server.create_from_env()


@pytest.mark.parametrize(
    "component", ["alpha", "alpha/service.db", "alpha/workspace", "alpha/dsh-home"]
)
def test_symlink_storage_rejected_before_app_construction(tmp_path, monkeypatch, component):
    root = tmp_path / "tenants"
    root.mkdir()
    linked = root / component
    linked.parent.mkdir(parents=True, exist_ok=True)
    target = tmp_path / "outside"
    target.mkdir()
    linked.symlink_to(target, target_is_directory=True)
    monkeypatch.setenv("RECOVERABLE_AGENT_TENANTS", json.dumps(config()))
    monkeypatch.setenv("RECOVERABLE_AGENT_TENANT_ROOT", str(root))
    with pytest.raises(ValueError):
        tenant_server.create_from_env()


def test_cli_uses_authenticated_factory_and_loopback(monkeypatch):
    captured = {}
    monkeypatch.setattr(
        tenant_server.uvicorn, "run", lambda target, **kw: captured.update(target=target, **kw)
    )
    tenant_server.main()
    assert captured == {
        "target": "recoverable_agent_service.tenant_server:create_from_env",
        "factory": True,
        "host": "127.0.0.1",
        "port": 8001,
        "access_log": False,
    }


def test_database_hardlink_alias_rejected(tmp_path, monkeypatch):
    import os

    alpha = tmp_path / "alpha"
    beta = tmp_path / "beta"
    alpha.mkdir()
    beta.mkdir()
    (alpha / "service.db").write_bytes(b"")
    os.link(alpha / "service.db", beta / "service.db")
    monkeypatch.setenv("RECOVERABLE_AGENT_TENANTS", json.dumps(config()))
    monkeypatch.setenv("RECOVERABLE_AGENT_TENANT_ROOT", str(tmp_path))
    with pytest.raises(ValueError, match="hard link"):
        tenant_server.create_from_env()


@pytest.mark.parametrize("component", ["service.db", "workspace", "dsh-home"])
def test_storage_destination_types_are_checked(tmp_path, monkeypatch, component):
    directory = tmp_path / "alpha"
    directory.mkdir()
    target = directory / component
    if component == "service.db":
        target.mkdir()
    else:
        target.write_bytes(b"not a directory")
    monkeypatch.setenv("RECOVERABLE_AGENT_TENANTS", json.dumps(config()))
    monkeypatch.setenv("RECOVERABLE_AGENT_TENANT_ROOT", str(tmp_path))
    with pytest.raises(ValueError):
        tenant_server.create_from_env()
