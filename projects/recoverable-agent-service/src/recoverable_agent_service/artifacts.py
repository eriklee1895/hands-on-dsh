"""Secure artifact snapshotting through a retained directory descriptor."""

from __future__ import annotations

import errno
import mimetypes
import os
import stat
from collections.abc import Sequence
from contextlib import suppress
from pathlib import Path

from .domain import ArtifactUpdate, normalize_artifact_names

MAX_ARTIFACT_BYTES = 1024 * 1024
READ_CHUNK_BYTES = 64 * 1024


class RetainedArtifactDirectory:
    """Service-owned Run directory whose open descriptor survives path replacement."""

    def __init__(self, path: Path, descriptor: int) -> None:
        self.path = path
        self._descriptor: int | None = descriptor

    @classmethod
    def create(cls, workspace: str | Path, run_id: str) -> RetainedArtifactDirectory:
        """Create trusted directory components and retain the Run directory descriptor."""
        workspace_path = Path(workspace)
        workspace_path.mkdir(parents=True, exist_ok=True)
        path = workspace_path / "artifacts" / run_id
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        workspace_descriptor = os.open(workspace_path, flags)
        try:
            artifacts_descriptor = cls._open_or_create_directory(
                workspace_descriptor, "artifacts", flags
            )
            try:
                descriptor = cls._open_or_create_directory(artifacts_descriptor, run_id, flags)
            finally:
                os.close(artifacts_descriptor)
        finally:
            os.close(workspace_descriptor)
        return cls(path, descriptor)

    def snapshot(self, requested_names: Sequence[str]) -> list[ArtifactUpdate]:
        """Read every requested artifact through the retained descriptor."""
        names = normalize_artifact_names(requested_names)
        return [self._snapshot_one(name) for name in names]

    def close(self) -> None:
        """Close the retained directory descriptor idempotently."""
        descriptor = self._descriptor
        self._descriptor = None
        if descriptor is not None:
            os.close(descriptor)

    def _snapshot_one(self, name: str) -> ArtifactUpdate:
        directory_descriptor = self._require_open()
        flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC
        try:
            descriptor = os.open(name, flags, dir_fd=directory_descriptor)
        except OSError as error:
            state = "missing" if error.errno == errno.ENOENT else "invalid"
            return ArtifactUpdate(requested_name=name, state=state)

        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                return ArtifactUpdate(requested_name=name, state="invalid")
            content = self._read_bounded(descriptor)
            if content is None:
                return ArtifactUpdate(requested_name=name, state="invalid")
            media_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
            return ArtifactUpdate(
                requested_name=name,
                state="available",
                content=content,
                media_type=media_type,
            )
        except OSError:
            return ArtifactUpdate(requested_name=name, state="invalid")
        finally:
            os.close(descriptor)

    @staticmethod
    def _read_bounded(descriptor: int) -> bytes | None:
        content = bytearray()
        while len(content) <= MAX_ARTIFACT_BYTES:
            remaining = MAX_ARTIFACT_BYTES + 1 - len(content)
            chunk = os.read(descriptor, min(READ_CHUNK_BYTES, remaining))
            if not chunk:
                return bytes(content)
            content.extend(chunk)
        return None

    def _require_open(self) -> int:
        if self._descriptor is None:
            raise RuntimeError("artifact directory is closed")
        return self._descriptor

    @staticmethod
    def _open_or_create_directory(parent: int, name: str, flags: int) -> int:
        with suppress(FileExistsError):
            os.mkdir(name, mode=0o700, dir_fd=parent)
        descriptor = os.open(name, flags, dir_fd=parent)
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISDIR(metadata.st_mode):
                raise NotADirectoryError(name)
        except BaseException:
            os.close(descriptor)
            raise
        return descriptor
