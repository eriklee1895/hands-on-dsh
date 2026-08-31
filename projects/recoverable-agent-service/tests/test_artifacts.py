from __future__ import annotations

import errno
import hashlib
import importlib
import os
from pathlib import Path

import pytest


def load_artifacts():
    try:
        return importlib.import_module("recoverable_agent_service.artifacts")
    except ImportError as error:
        pytest.fail(f"Task 1B artifact snapshotting is not implemented: {error}")


def make_store(database_path: Path):
    store = importlib.import_module("recoverable_agent_service.store")
    repository = store.SQLiteStore(database_path)
    repository.migrate()
    return repository


def by_name(updates):
    return {update.requested_name: update for update in updates}


def test_snapshot_records_exact_content_hash_and_missing_artifact(tmp_path: Path) -> None:
    artifacts = load_artifacts()
    retained = artifacts.RetainedArtifactDirectory.create(tmp_path / "workspace", "run-1")
    try:
        (retained.path / "proof.txt").write_bytes(b"durable proof")

        updates = by_name(retained.snapshot(["proof.txt", "optional.txt"]))

        assert updates["proof.txt"].state == "available"
        assert updates["proof.txt"].content == b"durable proof"
        assert updates["proof.txt"].media_type == "text/plain"
        assert hashlib.sha256(updates["proof.txt"].content).hexdigest() == (
            "0b2503f5ae4ff33270ce64809c08fba69d3632d705c72648d32f5358b841f5b8"
        )
        assert updates["optional.txt"].state == "missing"
        assert updates["optional.txt"].content is None
    finally:
        retained.close()


def test_snapshot_rejects_symlink_fifo_and_oversize_but_accepts_exact_limit(
    tmp_path: Path,
) -> None:
    artifacts = load_artifacts()
    retained = artifacts.RetainedArtifactDirectory.create(tmp_path / "workspace", "run-2")
    try:
        outside = tmp_path / "outside.txt"
        outside.write_bytes(b"outside")
        (retained.path / "link.txt").symlink_to(outside)
        os.mkfifo(retained.path / "pipe.bin")
        (retained.path / "exact.bin").write_bytes(b"x" * (1024 * 1024))
        (retained.path / "large.bin").write_bytes(b"x" * (1024 * 1024 + 1))

        updates = by_name(retained.snapshot(["link.txt", "pipe.bin", "exact.bin", "large.bin"]))

        assert updates["link.txt"].state == "invalid"
        assert updates["pipe.bin"].state == "invalid"
        assert updates["large.bin"].state == "invalid"
        assert updates["exact.bin"].state == "available"
        assert len(updates["exact.bin"].content) == 1024 * 1024
    finally:
        retained.close()


def test_retained_descriptor_ignores_replacement_parent_directory(tmp_path: Path) -> None:
    artifacts = load_artifacts()
    retained = artifacts.RetainedArtifactDirectory.create(tmp_path / "workspace", "run-3")
    original_path = retained.path
    retired_path = original_path.with_name("run-3-retired")
    try:
        (original_path / "proof.txt").write_bytes(b"original descriptor")
        original_path.rename(retired_path)
        original_path.mkdir()
        (original_path / "proof.txt").write_bytes(b"replacement path")

        [update] = retained.snapshot(["proof.txt"])

        assert update.state == "available"
        assert update.content == b"original descriptor"
    finally:
        retained.close()


def test_create_rejects_preexisting_artifacts_ancestor_symlink(tmp_path: Path) -> None:
    artifacts = load_artifacts()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (workspace / "artifacts").symlink_to(outside, target_is_directory=True)

    with pytest.raises(OSError):
        artifacts.RetainedArtifactDirectory.create(workspace, "run-ancestor")

    assert not (outside / "run-ancestor").exists()


def test_create_rejects_preexisting_run_directory_symlink(tmp_path: Path) -> None:
    artifacts = load_artifacts()
    workspace = tmp_path / "workspace"
    artifact_root = workspace / "artifacts"
    artifact_root.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (artifact_root / "run-link").symlink_to(outside, target_is_directory=True)

    with pytest.raises(OSError):
        artifacts.RetainedArtifactDirectory.create(workspace, "run-link")

    assert list(outside.iterdir()) == []


def test_component_descriptor_closes_when_fstat_validation_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    artifacts = load_artifacts()
    real_open = artifacts.os.open
    real_fstat = artifacts.os.fstat
    opened_component: list[int] = []

    def recording_open(path, flags, mode=0o777, *, dir_fd=None):
        descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
        if path == "artifacts":
            opened_component.append(descriptor)
        return descriptor

    def failing_fstat(descriptor: int):
        if opened_component and descriptor == opened_component[0]:
            raise OSError("injected component fstat failure")
        return real_fstat(descriptor)

    monkeypatch.setattr(artifacts.os, "open", recording_open)
    monkeypatch.setattr(artifacts.os, "fstat", failing_fstat)

    with pytest.raises(OSError, match="injected component fstat failure"):
        artifacts.RetainedArtifactDirectory.create(tmp_path / "workspace", "run-fstat")

    [descriptor] = opened_component
    try:
        real_fstat(descriptor)
    except OSError as error:
        assert error.errno == errno.EBADF
    else:
        os.close(descriptor)
        pytest.fail("component descriptor leaked after fstat failure")


def test_snapshot_catalogues_read_failure_as_invalid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    artifacts = load_artifacts()
    retained = artifacts.RetainedArtifactDirectory.create(tmp_path / "workspace", "run-read")
    try:
        (retained.path / "proof.txt").write_bytes(b"unreadable through injected descriptor")

        def fail_read(_descriptor: int, _size: int) -> bytes:
            raise OSError("injected read failure")

        monkeypatch.setattr(artifacts.os, "read", fail_read)

        [update] = retained.snapshot(["proof.txt"])

        assert update.state == "invalid"
        assert update.content is None
    finally:
        retained.close()


def test_snapshot_bytes_remain_immutable_after_file_mutation_and_sqlite_commit(
    tmp_path: Path,
) -> None:
    artifacts = load_artifacts()
    repository = make_store(tmp_path / "service.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(conversation.id, "request", "create proof", ["proof.txt"]).run
    repository.claim_oldest_run()
    retained = artifacts.RetainedArtifactDirectory.create(tmp_path / "workspace", run.id)
    try:
        proof = retained.path / "proof.txt"
        proof.write_bytes(b"first bytes")
        updates = retained.snapshot(["proof.txt"])
        proof.write_bytes(b"mutated after snapshot")

        repository.complete_run_success(
            run.id,
            final_response="done",
            finish_reason="completed",
            artifacts=updates,
        )
        proof.write_bytes(b"mutated after commit")

        [stored] = repository.list_artifacts(run.id)
        assert stored.content == b"first bytes"
        assert stored.sha256 == hashlib.sha256(b"first bytes").hexdigest()
    finally:
        retained.close()
        retained.close()
