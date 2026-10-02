"""Own disposable demo paths until the runtime has closed."""

from __future__ import annotations

import math
import shutil
import tempfile
from pathlib import Path
from typing import Protocol, TypeVar


class Closable(Protocol):
    def close(self) -> None: ...


RuntimeT = TypeVar("RuntimeT", bound=Closable)


class DemoResources:
    """Retain temporary state when runtime shutdown cannot be confirmed."""

    def __init__(self, prefix: str) -> None:
        self.root = Path(tempfile.mkdtemp(prefix=f"{prefix}-"))
        self.workspace = self.root / "workspace"
        self.home = self.root / "home"
        self._closed = False
        self._runtime: Closable | None = None

    def __enter__(self) -> DemoResources:
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        if self._runtime is not None:
            self._runtime.close()
            self._closed = True
        if self._closed:
            shutil.rmtree(self.root)

    def own(self, runtime: RuntimeT) -> RuntimeT:
        """Register a runtime to close even if its context entry fails."""
        self._runtime = runtime
        return runtime

    def confirm_closed(self) -> None:
        """Permit cleanup after the owned runtime process was reaped."""
        self._closed = True


def finite_positive_timeout(raw: str) -> float:
    """Parse a finite positive CLI deadline duration."""
    value = float(raw)
    if not math.isfinite(value) or value <= 0:
        raise ValueError("timeout must be a finite positive number")
    return value
